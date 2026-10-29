// Uses the standard room-store key order:
// room, sessions, player roles, private challenge, join requests.
//
// Appended after the presence cleanup function, so departures have
// already been removed before the remaining teams are counted.
export const TEAM_VICTORY_LUA = `
local function gwCheckTeamVictory()
  local raw = redis.call("GET", KEYS[1])
  if not raw then return end

  local room = cjson.decode(raw)

  if room.phase ~= "IN_PROGRESS" or not room.challenge then
    return
  end

  local clock = redis.call("TIME")
  local now = tonumber(clock[1]) * 1000 +
    math.floor(tonumber(clock[2]) / 1000)

  -- Let the existing match clock handle an expired deadline.
  if room.matchEndsAt and now >= room.matchEndsAt then
    return
  end

  local meeting = room.meeting

  -- Preserve the existing vote-reveal animation. The elimination and
  -- its resulting victory are resolved when that reveal finishes.
  if meeting and
     meeting.voteClosedAt and
     not meeting.settled then
    return
  end

  local coders = 0
  local hackers = 0

  for _, player in ipairs(room.players) do
    if not player.eliminated then
      local role = redis.call("HGET", KEYS[3], player.id)

      if role == "HACKER" then
        hackers = hackers + 1
      elseif role == "CODER" then
        coders = coders + 1
      else
        -- Missing role data must not accidentally award a victory.
        return
      end
    end
  end

  local winner = nil
  local reason = nil

  if hackers == 0 then
    winner = "CODERS"
    reason = "NO_HACKERS_REMAIN"
  elseif coders <= hackers then
    winner = "HACKER"
    reason = "HACKER_PARITY"
  else
    return
  end

  local privateRaw = redis.call("GET", KEYS[4])
  local private = privateRaw and cjson.decode(privateRaw) or {}
  local economy = private.sabotage or {}
  local challenge = room.challenge
  local paused = room.meetingPausedMs or 0

  -- An unfinished discussion reserves its full duration in the clock.
  -- Remove any unused portion when the match ends during discussion.
  if meeting and not meeting.settled and now < meeting.endsAt then
    paused = math.max(0, paused - (meeting.endsAt - now))
  end

  local players = {}
  local seen = {}

  for _, list in ipairs({room.players, room.departedPlayers or {}}) do
    for _, player in ipairs(list) do
      if not seen[player.id] then
        seen[player.id] = true

        table.insert(players, {
          id=player.id,
          displayName=player.displayName,
          role=redis.call("HGET", KEYS[3], player.id) or "UNKNOWN"
        })
      end
    end
  end

  room.phase = "RESULTS"
  room.results = {
    matchId=challenge.matchId,
    winner=winner,
    reason=reason,
    finishedAt=now,
    expiresAt=now + 60000,
    durationMs=math.max(
      0,
      now - (room.codingStartsAt or now) - paused
    ),
    acceptedRepairs=economy.acceptedRepairs or
      challenge.codeVersion or 0,
    successfulSabotages=economy.sabotages or 0,
    completedObjectives=#(challenge.completedObjectiveIds or {}),
    totalObjectives=#challenge.objectives,
    players=players
  }

  -- Release editor locks when the match finishes.
  if gwCleanDocument(room, private, now) and privateRaw then
    redis.call("SET", KEYS[4], cjson.encode(private), "KEEPTTL")
  end

  redis.call("SET", KEYS[1], cjson.encode(room), "KEEPTTL")

  for _, key in ipairs(KEYS) do
    redis.call("PEXPIREAT", key, room.results.expiresAt)
  end
end

local function gwPresence(forcedPlayerId, stopAtMeetingEnd)
  gwPresenceCleanup(forcedPlayerId, stopAtMeetingEnd)
  gwCheckTeamVictory()
end
`;