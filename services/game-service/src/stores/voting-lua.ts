// Shared by the clock and code-commit transactions.
// KEYS: room, sessions, roles, private challenge, join requests.
export const SETTLE_VOTE_LUA = `
do
  local raw = redis.call("GET", KEYS[1])

  if raw then
    local room = cjson.decode(raw)
    local meeting = room.meeting
    local clock = redis.call("TIME")
    local now = tonumber(clock[1]) * 1000 +
      math.floor(tonumber(clock[2]) / 1000)

    if room.phase == "IN_PROGRESS" and
       meeting and
       not meeting.settled and
       now >= meeting.endsAt then

      local privateRaw = redis.call("GET", KEYS[4])
      local private = privateRaw and cjson.decode(privateRaw) or {}
      local state = private.meetings or {}

      local eligible = {}
      for _, id in ipairs(meeting.eligibleIds or {}) do
        eligible[id] = true
      end

      local candidates = {}
      for _, player in ipairs(room.players) do
        if not player.eliminated and eligible[player.id] then
          candidates[player.id] = player
        end
      end

      local counts = {}

      for voter, ballot in pairs(state.votes or {}) do
        -- Skip is an empty string and never receives a tally.
        if eligible[voter] and candidates[ballot.targetId] then
          counts[ballot.targetId] =
            (counts[ballot.targetId] or 0) + 1
        end
      end

      local highest = 0
      local leaders = 0
      local winner = nil
      local tally = {}

      for _, player in ipairs(room.players) do
        if candidates[player.id] then
          local count = counts[player.id] or 0

          table.insert(tally, {
            playerId=player.id,
            displayName=player.displayName,
            votes=count
          })

          if count > highest then
            highest = count
            leaders = 1
            winner = player
          elseif count > 0 and count == highest then
            leaders = leaders + 1
          end
        end
      end

      local outcome = highest == 0 and "NO_VOTES" or "TIE"

      if highest > 0 and leaders == 1 then
        winner.eliminated = true
        outcome = "ELIMINATED"
      else
        winner = nil
      end

      meeting.settled = true

      room.lastVoteResult = {
        meetingId=meeting.id,
        outcome=outcome,
        playerId=winner and winner.id or cjson.null,
        displayName=winner and winner.displayName or cjson.null,
        tally=tally
      }

      if winner and
         redis.call("HGET", KEYS[3], winner.id) == "HACKER" then

        local finishedAt = meeting.endsAt
        local economy = private.sabotage or {}
        local challenge = room.challenge
        local players = {}

        for _, player in ipairs(room.players) do
          table.insert(players, {
            id=player.id,
            displayName=player.displayName,
            role=redis.call("HGET", KEYS[3], player.id) or "UNKNOWN"
          })
        end

        room.phase = "RESULTS"
        room.results = {
          matchId=challenge.matchId,
          winner="CODERS",
          reason="HACKER_ELIMINATED",
          finishedAt=finishedAt,
          expiresAt=finishedAt + 60000,
          durationMs=math.max(
            0,
            finishedAt - room.codingStartsAt -
              (room.meetingPausedMs or 0)
          ),
          acceptedRepairs=economy.acceptedRepairs or
            challenge.codeVersion or 0,
          successfulSabotages=economy.sabotages or 0,
          completedObjectives=#(challenge.completedObjectiveIds or {}),
          totalObjectives=#challenge.objectives,
          players=players
        }
      end

      redis.call("SET", KEYS[1], cjson.encode(room), "KEEPTTL")

      if room.phase == "RESULTS" then
        for _, key in ipairs(KEYS) do
          redis.call("PEXPIREAT", key, room.results.expiresAt)
        end
      end
    end
  end
end
`;

export const ACTIVE_PLAYER_LUA = SETTLE_VOTE_LUA + `
do
  local raw = redis.call("GET", KEYS[1])

  if raw then
    local room = cjson.decode(raw)
    local id = redis.call("HGET", KEYS[2], ARGV[1])

    for _, player in ipairs(room.players) do
      if player.id == id and player.eliminated then
        return cjson.encode({outcome="UNAUTHORIZED"})
      end
    end
  end
end
`;