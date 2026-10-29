import { PRESENCE_FUNCTIONS_LUA } from "./presence-lua.js";

// KEYS: room, sessions, roles, private challenge, join requests.
export const SETTLE_VOTE_LUA = PRESENCE_FUNCTIONS_LUA + `
local function gwSettleVote()
  gwPresence(nil, true)

  local raw = redis.call("GET", KEYS[1])
  if not raw then return end

  local room = cjson.decode(raw)
  local meeting = room.meeting

  if room.phase ~= "IN_PROGRESS" or
     not meeting or meeting.settled then
    return
  end

  local clock = redis.call("TIME")
  local now = tonumber(clock[1]) * 1000 +
    math.floor(tonumber(clock[2]) / 1000)

  local privateRaw = redis.call("GET", KEYS[4])
  local private = privateRaw and cjson.decode(privateRaw) or {}
  local state = private.meetings or {}
  local votes = state.votes or {}
  local changed = false

  if not meeting.voteClosedAt then
    local eligible = {}
    for _, id in ipairs(meeting.eligibleIds or {}) do
      eligible[id] = true
    end

    local candidates = {}
    local candidateCount = 0

    for _, player in ipairs(room.players) do
      if eligible[player.id] and not player.eliminated then
        candidates[player.id] = player
        candidateCount = candidateCount + 1
      end
    end

    local completed = 0

    for id, _ in pairs(candidates) do
      local ballot = votes[id]

      if ballot and (
        ballot.targetId == "" or
        (ballot.targetId ~= id and candidates[ballot.targetId])
      ) then
        completed = completed + 1
      end
    end

    local voteEndsAt = meeting.voteEndsAt or meeting.endsAt
    local everyoneVoted =
      candidateCount > 0 and completed == candidateCount

    if everyoneVoted or now >= voteEndsAt then
      local closedAt = now >= voteEndsAt and voteEndsAt or now
      local counts = {}
      local ballots = {}

      for _, player in ipairs(room.players) do
        if candidates[player.id] then
          local ballot = votes[player.id]
          local target = ballot and candidates[ballot.targetId] or nil
          local status = "NO_VOTE"
          local targetId = cjson.null
          local targetName = cjson.null

          if ballot and ballot.targetId == "" then
            status = "SKIPPED"
          elseif target and target.id ~= player.id then
            status = "VOTED"
            targetId = target.id
            targetName = target.displayName
            counts[target.id] = (counts[target.id] or 0) + 1
          end

          table.insert(ballots, {
            voterId=player.id,
            voterName=player.displayName,
            targetId=targetId,
            targetName=targetName,
            status=status
          })
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
        outcome = "ELIMINATED"
      else
        winner = nil
      end

      local oldEnd = meeting.endsAt
      local revealEnd = closedAt + 8000
      local adjustment = revealEnd - oldEnd

      meeting.stage = "REVEAL"
      meeting.voteClosedAt = closedAt
      meeting.endsAt = revealEnd

      -- Keep coding time and sabotage cooldowns paused for exactly
      -- the actual meeting duration, including the results reveal.
      room.matchEndsAt = room.matchEndsAt + adjustment
      room.meetingPausedMs =
        (room.meetingPausedMs or 0) + adjustment

      local economy = private.sabotage

      if economy then
        for _, field in ipairs({"nextAllowedAt", "attemptAfter"}) do
          if tonumber(economy[field] or 0) > oldEnd then
            economy[field] = economy[field] + adjustment
          end
        end
      end

      room.lastVoteResult = {
        meetingId=meeting.id,
        outcome=outcome,
        playerId=winner and winner.id or cjson.null,
        displayName=winner and winner.displayName or cjson.null,
        closedAt=closedAt,
        revealEndsAt=revealEnd,
        applied=false,
        tally=tally,
        ballots=ballots
      }

      changed = true
    end
  end

  if meeting.voteClosedAt and now >= meeting.endsAt then
    local result = room.lastVoteResult
    local winner = nil

    if result and result.meetingId == meeting.id and
       result.outcome == "ELIMINATED" then
      for _, player in ipairs(room.players) do
        if player.id == result.playerId then
          winner = player
          player.eliminated = true
          break
        end
      end
    end

    meeting.settled = true
    meeting.stage = "FINISHED"

    if result then result.applied = true end

    local activeHackers = 0

    for _, player in ipairs(room.players) do
      if not player.eliminated and
         redis.call("HGET", KEYS[3], player.id) == "HACKER" then
        activeHackers = activeHackers + 1
      end
    end

    local hackerEliminated =
      winner and
      redis.call("HGET", KEYS[3], winner.id) == "HACKER"

    if activeHackers == 0 and (
      hackerEliminated or meeting.deferredHackerDeparture
    ) then
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
        reason=hackerEliminated and "HACKER_ELIMINATED" or "HACKER_LEFT",
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

    changed = true
  end

  if changed then
    redis.call("SET", KEYS[1], cjson.encode(room), "KEEPTTL")

    if privateRaw then
      redis.call("SET", KEYS[4], cjson.encode(private), "KEEPTTL")
    end

    local expiresAt = room.phase == "RESULTS" and
      room.results.expiresAt or room.matchEndsAt + 60000

    for _, key in ipairs(KEYS) do
      redis.call("PEXPIREAT", key, expiresAt)
    end
  end

  gwPresence(nil, false)
end

gwSettleVote()
`;

export const ACTIVE_PLAYER_LUA = SETTLE_VOTE_LUA + `
do
  local raw = redis.call("GET", KEYS[1])

  if raw then
    local room = cjson.decode(raw)
    local id = redis.call("HGET", KEYS[2], ARGV[1])

    if not id then
      return cjson.encode({outcome="UNAUTHORIZED"})
    end

    local member = nil

    for _, player in ipairs(room.players) do
      if player.id == id then
        member = player
        break
      end
    end

    if not member or member.eliminated then
      return cjson.encode({outcome="UNAUTHORIZED"})
    end
  end
end
`;