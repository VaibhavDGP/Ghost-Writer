// KEYS:
// 1. room
// 2. sessions
// 3. player roles
// 4. private challenge
// 5. join requests
import { JUDGE_PAUSE_LUA } from "./judge-pause-lua.js";
import { TEAM_VICTORY_LUA } from "./team-victory-lua.js";
import { SHARED_DOCUMENT_LUA } from "./shared-document-lua.js";
import { POPULATION_WIN_LUA } from "./population-win-lua.js";
export const PRESENCE_FUNCTIONS_LUA =
  SHARED_DOCUMENT_LUA + JUDGE_PAUSE_LUA + `
local function gwPresenceCleanup(forcedPlayerId, stopAtMeetingEnd)
  gwSyncJudgePause() 
local raw = redis.call("GET", KEYS[1])
  if not raw then return end

  local room = cjson.decode(raw)
  local clock = redis.call("TIME")
  local now = tonumber(clock[1]) * 1000 +
    math.floor(tonumber(clock[2]) / 1000)

  local cutoff = now
  local meeting = room.meeting

  if stopAtMeetingEnd and
     room.phase == "IN_PROGRESS" and
     meeting and
     not meeting.settled and
     now >= meeting.endsAt then
    cutoff = math.min(cutoff, meeting.endsAt)
  end

  local privateRaw = redis.call("GET", KEYS[4])
  local private = privateRaw and cjson.decode(privateRaw) or {}
  local changedPrivate = false
  local changed = false

  room.departedPlayers = room.departedPlayers or {}

  local function resultPlayers()
    local players = {}
    local seen = {}

    for _, list in ipairs({room.players, room.departedPlayers}) do
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

    return players
  end

    local function finishForHackerDeparture(at, departingId)
    if room.phase ~= "IN_PROGRESS" or not room.challenge then
      return
    end

    if room.twoPlayerMode then
      return
    end

    if room.matchEndsAt and at >= room.matchEndsAt then
      return
    end

    -- A remaining, non-eliminated hacker keeps the match alive.
    -- Disconnected players retain their place during the grace period.
    for _, player in ipairs(room.players) do
      if player.id ~= departingId and
         not player.eliminated and
         redis.call("HGET", KEYS[3], player.id) == "HACKER" then
        return
      end
    end

       -- Finish an existing vote reveal before showing match results.
    if room.meeting and
       room.meeting.voteClosedAt and
       at < room.meeting.endsAt then
      room.meeting.deferredHackerDeparture = true
      changed = true
      return
    end

    local challenge = room.challenge
    local economy = private.sabotage or {}
    local paused = room.meetingPausedMs or 0

    if room.meeting and at < room.meeting.endsAt then
      paused = math.max(
        0,
        paused - (room.meeting.endsAt - at)
      )
    end

    room.phase = "RESULTS"
    room.results = {
      matchId=challenge.matchId,
      winner="CODERS",
      reason="HACKER_LEFT",
      finishedAt=at,
      expiresAt=at + 60000,
      durationMs=math.max(
        0,
        at - (room.codingStartsAt or at) - paused
      ),
      acceptedRepairs=economy.acceptedRepairs or
        challenge.codeVersion or 0,
      successfulSabotages=economy.sabotages or 0,
      completedObjectives=#(challenge.completedObjectiveIds or {}),
      totalObjectives=#challenge.objectives,
      players=resultPlayers()
    }

    changed = true
  end

  local departures = {}

  for _, player in ipairs(room.players) do
    if not tonumber(player.lastSeenAt) then
      player.lastSeenAt = now
      changed = true
    end

    local lastSeen = tonumber(player.lastSeenAt)
        local connected = now - lastSeen < 90000

    if player.connected ~= connected then
      player.connected = connected
      changed = true
    end

    if room.phase == "LOBBY" and
       not connected and
       player.isReady then
      player.isReady = false
      changed = true
    end

    local expiresAt = lastSeen + 300000
    local forced = player.id == forcedPlayerId
    local expired = expiresAt <= cutoff

    if room.phase == "IN_PROGRESS" and
       room.matchEndsAt and
       expiresAt >= room.matchEndsAt then
      expired = false
    end

    if forced or expired then
      table.insert(departures, {
        id=player.id,
        at=forced and now or expiresAt
      })
    end
  end

  table.sort(departures, function(a, b)
    if a.at == b.at then return a.id < b.id end
    return a.at < b.at
  end)

  for _, departure in ipairs(departures) do
    local index = nil
    local member = nil

    for i, player in ipairs(room.players) do
      if player.id == departure.id then
        index = i
        member = player
        break
      end
    end

    if member then
      if room.phase == "IN_PROGRESS" then
        if not member.eliminated and
           redis.call("HGET", KEYS[3], member.id) == "HACKER" then
          finishForHackerDeparture(departure.at, member.id)
        end

        table.insert(room.departedPlayers, {
          id=member.id,
          displayName=member.displayName
        })
      end

      table.remove(room.players, index)

      local sessions = redis.call("HGETALL", KEYS[2])
      for i=1,#sessions,2 do
        if sessions[i + 1] == member.id then
          redis.call("HDEL", KEYS[2], sessions[i])
        end
      end

      local joins = redis.call("HGETALL", KEYS[5])
      for i=1,#joins,2 do
        local ok, receipt = pcall(cjson.decode, joins[i + 1])

        if ok and type(receipt) == "table" and
           receipt.playerId == member.id then
          redis.call("HDEL", KEYS[5], joins[i])
        end
      end

      -- Preserve private role records for the final results.
            if room.meeting and
         not room.meeting.settled and
         not room.meeting.voteClosedAt then
        local eligible = {}

        for _, id in ipairs(room.meeting.eligibleIds or {}) do
          if id ~= member.id then
            table.insert(eligible, id)
          end
        end

        room.meeting.eligibleIds = eligible

        local state = private.meetings
        if state and state.votes then
          local remove = {}

          for voter, ballot in pairs(state.votes) do
            if voter == member.id or ballot.targetId == member.id then
              table.insert(remove, voter)
            end
          end

          for _, voter in ipairs(remove) do
            state.votes[voter] = nil
          end

          changedPrivate = true
        end
      end

      changed = true
    end
  end

  if #room.players == 0 then
    redis.call("DEL", unpack(KEYS))
    return
  end

  -- Only lobby population changes affect the configured count.
  -- An active two-hacker match keeps its original setting.
  if room.phase == "LOBBY" and
     #room.players <= 5 and
     room.hackerCount ~= 1 then
    room.hackerCount = 1

    for _, player in ipairs(room.players) do
      player.isReady = false
    end

    changed = true
  end

  local hostExists = false
  for _, player in ipairs(room.players) do
    if player.id == room.hostPlayerId then
      hostExists = true
      break
    end
  end

  if not hostExists then
    local nextHost = nil
    local bestScore = -1

    for _, player in ipairs(room.players) do
      local score = 0

      if not player.eliminated then score = score + 2 end
      if player.connected then score = score + 1 end

      if score > bestScore then
        nextHost = player
        bestScore = score
      end
    end

    room.hostPlayerId = nextHost.id
    nextHost.isReady = false
    changed = true
  end

  if room.phase == "RESULTS" and room.results then
    local known = {}
    local players = room.results.players or {}

    for _, player in ipairs(players) do
      known[player.id] = true
    end

    for _, player in ipairs(room.departedPlayers) do
      if not known[player.id] then
        table.insert(players, {
          id=player.id,
          displayName=player.displayName,
          role=redis.call("HGET", KEYS[3], player.id) or "UNKNOWN"
        })

        known[player.id] = true
        changed = true
      end
    end

    room.results.players = players
  end

      if gwCleanDocument(room, private, now) then
    changedPrivate = true
  end

  if changedPrivate and privateRaw then
    redis.call("SET", KEYS[4], cjson.encode(private), "KEEPTTL")
  end

  if changed then
    redis.call("SET", KEYS[1], cjson.encode(room), "KEEPTTL")
  end

  if room.phase == "RESULTS" and room.results then
    for _, key in ipairs(KEYS) do
      redis.call("PEXPIREAT", key, room.results.expiresAt)
    end
  end
end
` + POPULATION_WIN_LUA;