import { redis } from "../config/redis.js";
import { readTimedRoom } from "./match-clock.js";
import { SETTLE_VOTE_LUA } from "./voting-lua.js";

export type MeetingMode = "READ" | "CALL" | "CHAT" | "VOTE";

export interface MeetingInput {
  matchId?: string;
  requestId?: string;
  meetingId?: string;
  text?: string;
  targetId?: string;
}

const SCRIPT = SETTLE_VOTE_LUA + `
  local raw = redis.call("GET", KEYS[1])
  if not raw then
    return cjson.encode({outcome="NOT_FOUND"})
  end

  local room = cjson.decode(raw)
  local playerId = redis.call("HGET", KEYS[2], ARGV[1])
  local member = nil

  for _, player in ipairs(room.players) do
    if player.id == playerId then member = player end
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

  state.votes = state.votes or {}

  if mode ~= "READ" and member.eliminated then
    return cjson.encode({outcome="SPECTATOR"})
  end

  if mode ~= "READ" and input.matchId ~= room.challenge.matchId then
    return cjson.encode({outcome="MATCH_CHANGED"})
  end

  if mode == "CALL" then
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
      state.votes = {}

      local eligibleIds = {}
      for _, player in ipairs(room.players) do
        if not player.eliminated then
          table.insert(eligibleIds, player.id)
        end
      end

      room.meeting = {
        id=room.challenge.matchId .. ":" .. tostring(state.count),
        calledByName=member.displayName,
        startedAt=now,
        voteStartsAt=now + 150000,
        eligibleIds=eligibleIds,
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

    if now >= (room.meeting.voteStartsAt or room.meeting.endsAt - 30000) then
      return cjson.encode({outcome="DISCUSSION_ENDED"})
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

  if mode == "VOTE" then
    if not active or input.meetingId ~= room.meeting.id then
      return cjson.encode({outcome="MEETING_ENDED"})
    end

    if now < (room.meeting.voteStartsAt or room.meeting.endsAt - 30000) then
      return cjson.encode({outcome="VOTING_NOT_STARTED"})
    end

    local eligible = {}
    for _, id in ipairs(room.meeting.eligibleIds or {}) do
      eligible[id] = true
    end

    if not eligible[playerId] then
      return cjson.encode({outcome="SPECTATOR"})
    end

    local previous = state.votes[playerId]

    if previous then
      if previous.requestId ~= input.requestId or
         previous.targetId ~= input.targetId then
        return cjson.encode({outcome="ALREADY_VOTED"})
      end
    else
      local valid = input.targetId == ""

      for _, player in ipairs(room.players) do
        if player.id == input.targetId and
           not player.eliminated and
           eligible[player.id] then
          valid = true
        end
      end

      if not valid then
        return cjson.encode({outcome="INVALID_TARGET"})
      end

      state.votes[playerId] = {
        requestId=input.requestId,
        targetId=input.targetId
      }

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

  local candidates = {}

  for _, player in ipairs(room.players) do
    if not player.eliminated then
      table.insert(candidates, {
        id=player.id,
        displayName=player.displayName
      })
    end
  end

  local myVote = state.votes[playerId]

  return cjson.encode({
    outcome="OK",
    snapshot={
      matchId=room.challenge.matchId,
      serverNowMs=now,
      codingStartsAt=startsAt,
      matchEndsAt=room.matchEndsAt,
      remainingCalls=3-state.count,
      isSpectator=member.eliminated == true,
      players=candidates,
      hasVoted=active and myVote ~= nil,
      myVote=myVote and myVote.targetId or cjson.null,
      lastVoteResult=room.lastVoteResult or cjson.null,
            officialSource=member.eliminated and (
        private.collaboration and
        gwRenderDocument(private.collaboration, "*", nil) or
        room.challenge.source
      ) or cjson.null,
      codeVersion=private.collaboration and
        private.collaboration.revision or room.challenge.codeVersion,
      canCall=not member.eliminated and not active and now >= startsAt and
        not state.called[playerId] and state.count < 3,
      meeting=active and room.meeting or cjson.null,
      messages=messages
    }
  })
`;

export async function meetingStore(
  code: string,
  tokenHash: string,
  mode: MeetingMode,
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
    ["messages", "players", "tally"].includes(key) &&
    !Array.isArray(value)
      ? []
      : value,
  ) as {
    outcome: string;
    snapshot?: {
      meeting: unknown;
      isSpectator: boolean;
    };
  };
}