import { redis } from "../config/redis.js";
import { readTimedRoom } from "./match-clock.js";

export interface MeetingInput {
  matchId?: string;
  requestId?: string;
  meetingId?: string;
  text?: string;
}

const SCRIPT = `
  local raw = redis.call("GET", KEYS[1])
  if not raw then
    return cjson.encode({outcome="NOT_FOUND"})
  end

  local room = cjson.decode(raw)
  local playerId = redis.call("HGET", KEYS[2], ARGV[1])
  local member = nil

  for _, player in ipairs(room.players) do
    if player.id == playerId then
      member = player
    end
  end

  if not member then
    return cjson.encode({outcome="UNAUTHORIZED"})
  end

  if room.phase ~= "IN_PROGRESS" or not room.challenge then
    return cjson.encode({outcome="NOT_ACTIVE"})
  end

  local clock = redis.call("TIME")
  local now = tonumber(clock[1]) * 1000 +
    math.floor(tonumber(clock[2]) / 1000)

  local deadline = tonumber(room.matchEndsAt)
  local startsAt = tonumber(room.codingStartsAt)

  if not deadline or not startsAt or now >= deadline then
    return cjson.encode({outcome="NOT_ACTIVE"})
  end

  local privateRaw = redis.call("GET", KEYS[4])
  if not privateRaw then
    return cjson.encode({outcome="NOT_ACTIVE"})
  end

  local private = cjson.decode(privateRaw)
  local state = private.meetings or {
    count=0,
    called={},
    requests={},
    messages={},
    lastSent={}
  }

  local input = cjson.decode(ARGV[3])
  local mode = ARGV[2]
  local active = room.meeting and now < room.meeting.endsAt
  local changed = false

  if mode ~= "READ" and input.matchId ~= room.challenge.matchId then
    return cjson.encode({outcome="MATCH_CHANGED"})
  end

  if mode == "CALL" then
    -- Retrying the same request cannot consume another call
    -- or extend the clocks twice.
    if state.requests[playerId] ~= input.requestId then
      if now < startsAt then
        return cjson.encode({outcome="COUNTDOWN_ACTIVE"})
      end

      if active then
        return cjson.encode({outcome="MEETING_ACTIVE"})
      end

      if state.called[playerId] then
        return cjson.encode({outcome="CALL_USED"})
      end

      if state.count >= 3 then
        return cjson.encode({outcome="MATCH_LIMIT"})
      end

      state.count = state.count + 1
      state.called[playerId] = true
      state.requests[playerId] = input.requestId
      state.messages = {}
      state.lastSent = {}

      room.meeting = {
        id=room.challenge.matchId .. ":" .. tostring(state.count),
        calledByName=member.displayName,
        startedAt=now,
        endsAt=now + 180000,
        pausedRemainingMs=deadline - now
      }

      room.matchEndsAt = deadline + 180000
      room.meetingPausedMs = (room.meetingPausedMs or 0) + 180000

      local economy = private.sabotage

      if economy then
        for _, field in ipairs({"nextAllowedAt", "attemptAfter"}) do
          if tonumber(economy[field] or 0) > now then
            economy[field] = economy[field] + 180000
          end
        end
      end

      active = true
      changed = true
    end

  elseif mode == "CHAT" then
    if not active or input.meetingId ~= room.meeting.id then
      return cjson.encode({outcome="MEETING_ENDED"})
    end

    local duplicate = false

    for _, message in ipairs(state.messages) do
      if message.playerId == playerId and
         message.requestId == input.requestId then
        if message.text ~= input.text then
          return cjson.encode({outcome="REQUEST_CONFLICT"})
        end

        duplicate = true
      end
    end

    if not duplicate then
      if now - (state.lastSent[playerId] or 0) < 2000 then
        return cjson.encode({outcome="RATE_LIMIT"})
      end

      if #state.messages >= 150 then
        return cjson.encode({outcome="CHAT_FULL"})
      end

      table.insert(state.messages, {
        id=tostring(#state.messages + 1),
        playerId=playerId,
        displayName=member.displayName,
        requestId=input.requestId,
        text=input.text,
        sentAt=now
      })

      state.lastSent[playerId] = now
      changed = true
    end
  end

  if changed then
    private.meetings = state

    redis.call("SET", KEYS[1], cjson.encode(room), "KEEPTTL")
    redis.call("SET", KEYS[4], cjson.encode(private), "KEEPTTL")

    for _, key in ipairs(KEYS) do
      redis.call("PEXPIREAT", key, room.matchEndsAt + 60000)
    end
  end

  -- Return only public meeting information.
  local messages = {}

  if active then
    for _, message in ipairs(state.messages) do
      table.insert(messages, {
        id=message.id,
        displayName=message.displayName,
        text=message.text,
        sentAt=message.sentAt
      })
    end
  end

  return cjson.encode({
    outcome="OK",
    snapshot={
      matchId=room.challenge.matchId,
      serverNowMs=now,
      codingStartsAt=startsAt,
      matchEndsAt=room.matchEndsAt,
      remainingCalls=3-state.count,
      canCall=not active and now >= startsAt and
        not state.called[playerId] and state.count < 3,
      meeting=active and room.meeting or cjson.null,
      messages=messages
    }
  })
`;

export async function meetingStore(
  code: string,
  tokenHash: string,
  mode: "READ" | "CALL" | "CHAT",
  input: MeetingInput = {},
) {
  await readTimedRoom(code);

  const key = `ghost-writer:room:${code}`;

  const raw = await redis.eval(SCRIPT, {
    keys: [
      key,
      `${key}:sessions`,
      `${key}:player-roles`,
      `${key}:server-challenge`,
      `${key}:join-requests`,
    ],
    arguments: [tokenHash, mode, JSON.stringify(input)],
  });

  if (typeof raw !== "string") {
    throw new Error("Invalid meeting response.");
  }

  return JSON.parse(raw, (key, value: unknown) =>
    key === "messages" && !Array.isArray(value) ? [] : value,
  ) as {
    outcome: string;
    snapshot?: { meeting: unknown };
  };
}