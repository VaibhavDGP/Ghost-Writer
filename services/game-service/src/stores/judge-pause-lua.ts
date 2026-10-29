export const JUDGE_HEALTH_KEY = "ghost-writer:judge-health:v1";

// Standard key order:
// room, sessions, roles, private challenge, join requests.
export const JUDGE_PAUSE_LUA = `
local function gwSyncJudgePause()
  local raw = redis.call("GET", KEYS[1])
  if not raw then return end

  local room = cjson.decode(raw)

  if room.phase ~= "IN_PROGRESS" or
     not room.challenge or
     not room.matchEndsAt then
    return
  end

  local healthRaw = redis.call(
    "GET",
    "ghost-writer:judge-health:v1"
  )

  if not healthRaw then return end

  local health = cjson.decode(healthRaw)
  local clock = redis.call("TIME")
  local now = tonumber(clock[1]) * 1000 +
    math.floor(tonumber(clock[2]) / 1000)

  local pause = room.judgePause
  local codingStartsAt = tonumber(room.codingStartsAt or now)

  if not pause then
    if health.available ~= false then return end

    local startsAt = math.max(
      tonumber(health.since or now),
      codingStartsAt
    )

    -- Never revive a match whose deadline passed before the outage.
    if room.matchEndsAt <= startsAt then return end

    pause = {
      since=startsAt,
      appliedAt=startsAt,
      remainingMs=math.max(0, room.matchEndsAt - startsAt)
    }

    room.judgePause = pause
  end

  local untilAt = now

  if health.available then
    untilAt = math.min(now, tonumber(health.endedAt or now))
  end

  local from = tonumber(pause.appliedAt)
  local untilTime = math.max(from, untilAt)
  local extension = untilTime - from

  -- Meetings already pause coding and sabotage cooldowns.
  -- Count only outage time outside the meeting interval.
  local meeting = room.meeting

  if meeting and meeting.startedAt and meeting.endsAt then
    local overlap = math.max(
      0,
      math.min(untilTime, meeting.endsAt) -
        math.max(from, meeting.startedAt)
    )

    extension = math.max(0, extension - overlap)
  end

  if extension > 0 then
    room.matchEndsAt = room.matchEndsAt + extension

    -- Existing result calculations subtract this accumulated
    -- non-coding time. Include outage time in that same accounting.
    room.meetingPausedMs =
      (room.meetingPausedMs or 0) + extension

    local privateRaw = redis.call("GET", KEYS[4])

    if privateRaw then
      local private = cjson.decode(privateRaw)
      local economy = private.sabotage

      if economy then
        for _, field in ipairs({"nextAllowedAt", "attemptAfter"}) do
          if tonumber(economy[field] or 0) > from then
            economy[field] = economy[field] + extension
          end
        end

        redis.call(
          "SET",
          KEYS[4],
          cjson.encode(private),
          "KEEPTTL"
        )
      end
    end
  end

  pause.appliedAt = untilTime

  if meeting and not meeting.settled and now < meeting.endsAt then
    pause.remainingMs = meeting.pausedRemainingMs
  else
    pause.remainingMs = math.max(
      0,
      room.matchEndsAt - math.max(now, codingStartsAt)
    )
  end

  if health.available then
    room.judgePause = nil
  end

  redis.call("SET", KEYS[1], cjson.encode(room), "KEEPTTL")

  for _, key in ipairs(KEYS) do
    if room.judgePause then
      -- An outage must not expire an otherwise active room.
      redis.call("PERSIST", key)
    else
      redis.call("PEXPIREAT", key, room.matchEndsAt + 60000)
    end
  end
end
`;