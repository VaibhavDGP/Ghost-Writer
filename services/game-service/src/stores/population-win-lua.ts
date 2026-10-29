// Uses the same Redis keys as presence-lua.ts:
// 1 room, 2 sessions, 3 roles, 4 private challenge, 5 join requests.
//
// This runs after the existing presence cleanup.
export const POPULATION_WIN_LUA = `
local function gwCheckPopulationWin()
  local raw = redis.call("GET", KEYS[1])
  if not raw then return end

  local room = cjson.decode(raw)

    if room.phase ~= "IN_PROGRESS" or not room.challenge then
    return
  end

  -- Two-player matches end only through repairs or timeout.
  if room.twoPlayerMode then
    return
  end

  local clock = redis.call("TIME")
  local now = tonumber(clock[1]) * 1000 +
    math.floor(tonumber(clock[2]) / 1000)

  -- Leave an already-expired match to the existing timer logic.
  local deadline = tonumber(room.matchEndsAt)
  if deadline and now >= deadline then
    return
  end

  -- Let the existing vote reveal finish before showing results.
  -- Voting applies its elimination when this meeting becomes settled.
  local meeting = room.meeting

  if meeting and meeting.voteClosedAt and not meeting.settled then
    return
  end

  local hackers = 0
  local coders = 0

  for _, player in ipairs(room.players or {}) do
    if not player.eliminated then
      local role = redis.call("HGET", KEYS[3], player.id)

      if role == "HACKER" then
        hackers = hackers + 1
      elseif role == "CODER" then
        coders = coders + 1
      else
        -- Missing role data must not award a false victory.
        return
      end
    end
  end

  local winningTeam = nil
  local reason = nil

  if hackers == 0 then
    winningTeam = "CODERS"
    reason = "NO_HACKERS"
  elseif coders <= hackers then
    winningTeam = "HACKER"
    reason = "HACKER_MAJORITY"
  else
    return
  end

  local privateRaw = redis.call("GET", KEYS[4])
  local private = privateRaw and cjson.decode(privateRaw) or {}
  local economy = private.sabotage or {}
  local challenge = room.challenge

  local players = {}
  local seen = {}

  for _, list in ipairs({
    room.players or {},
    room.departedPlayers or {}
  }) do
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

  local paused = room.meetingPausedMs or 0

  -- A departure can end the game during an unfinished discussion.
  -- Exclude only the discussion time that actually elapsed.
  if meeting and not meeting.settled and now < meeting.endsAt then
    paused = math.max(0, paused - (meeting.endsAt - now))
  end

  room.phase = "RESULTS"
  room.results = {
    matchId=challenge.matchId,
    winner=winningTeam,
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

  -- Release editing locks when the match finishes.
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
  gwCheckPopulationWin()
end
`;