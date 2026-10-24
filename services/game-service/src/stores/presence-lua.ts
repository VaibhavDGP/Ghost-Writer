// Every script using this module must supply keys in this order:
// 1. room
// 2. sessions
// 3. player roles
// 4. private challenge
// 5. join requests
//
// This defines a Lua function. It does not execute it automatically.

export const PRESENCE_FUNCTIONS_LUA = `
local function gwPresence(forcedPlayerId, stopAtMeetingEnd)
  local raw = redis.call("GET", KEYS[1])
  if not raw then return end

  local room = cjson.decode(raw)
  local clock = redis.call("TIME")
  local now = tonumber(clock[1]) * 1000 +
    math.floor(tonumber(clock[2]) / 1000)

  local cutoff = now
  local meeting = room.meeting

  -- Resolve departures that happened before a vote before counting it.
  -- Later departures are handled after the vote has been settled.
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

  local function finishForHackerDeparture(at)
    if room.phase ~= "IN_PROGRESS" or not room.challenge then
      return
    end

    -- If the match deadline came first, the clock decides the result.
    if room.matchEndsAt and at >= room.matchEndsAt then
      return
    end

    local challenge = room.challenge
    local economy = private.sabotage or {}
    local paused = room.meetingPausedMs or 0

    -- Only subtract meeting time that actually elapsed.
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
    -- Existing rooms get a grace period when this feature is installed.
    if not tonumber(player.lastSeenAt) then
      player.lastSeenAt = now
      changed = true
    end

    local lastSeen = tonumber(player.lastSeenAt)
    local connected = now - lastSeen < 15000

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

    local expiresAt = lastSeen + 60000
    local forced = player.id == forcedPlayerId
    local expired = expiresAt <= cutoff

    -- Preserve chronological ordering with the match deadline.
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
        if redis.call("HGET", KEYS[3], member.id) == "HACKER" then
          finishForHackerDeparture(departure.at)
        end

        table.insert(room.departedPlayers, {
          id=member.id,
          displayName=member.displayName
        })
      end

      table.remove(room.players, index)

      -- Revoke every session belonging to this player.
      local sessions = redis.call("HGETALL", KEYS[2])
      for i=1,#sessions,2 do
        if sessions[i + 1] == member.id then
          redis.call("HDEL", KEYS[2], sessions[i])
        end
      end

      -- Remove old join receipts for this player.
      local joins = redis.call("HGETALL", KEYS[5])
      for i=1,#joins,2 do
        local ok, receipt = pcall(cjson.decode, joins[i + 1])
        if ok and type(receipt) == "table" and
           receipt.playerId == member.id then
          redis.call("HDEL", KEYS[5], joins[i])
        end
      end

      -- Keep their private role until replay/expiry so results can
      -- still include everyone who participated in the match.

      if room.meeting and not room.meeting.settled then
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

  -- Other result-producing scripts use the current roster.
  -- Add departed participants back to the results summary.
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

  if changedPrivate and privateRaw then
    redis.call(
      "SET", KEYS[4], cjson.encode(private), "KEEPTTL"
    )
  end

  if changed then
    redis.call(
      "SET", KEYS[1], cjson.encode(room), "KEEPTTL"
    )
  end

  if room.phase == "RESULTS" and room.results then
    for _, key in ipairs(KEYS) do
      redis.call("PEXPIREAT", key, room.results.expiresAt)
    end
  end
end
`;