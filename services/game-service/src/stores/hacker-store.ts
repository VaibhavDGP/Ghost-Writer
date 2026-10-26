import { redis } from "../config/redis.js";
import { readTimedRoom } from "./match-clock.js";
import { SETTLE_VOTE_LUA } from "./voting-lua.js";

const SETTINGS_SCRIPT = SETTLE_VOTE_LUA + `
local raw = redis.call("GET", KEYS[1])
if not raw then
  return cjson.encode({outcome="NOT_FOUND"})
end

local room = cjson.decode(raw)
local playerId = redis.call("HGET", KEYS[2], ARGV[1])
local member = false

for _, player in ipairs(room.players) do
  if player.id == playerId then member = true end
end

if not member then
  return cjson.encode({outcome="UNAUTHORIZED"})
end

local maximum = #room.players > 5 and 2 or 1
local count = room.hackerCount == 2 and 2 or 1

if room.phase == "LOBBY" then
  count = math.min(count, maximum)
end

if ARGV[2] == "UPDATE" then
  if room.hostPlayerId ~= playerId then
    return cjson.encode({outcome="FORBIDDEN"})
  end

  if room.phase ~= "LOBBY" then
    return cjson.encode({outcome="NOT_IN_LOBBY"})
  end

  local input = cjson.decode(ARGV[3])
  local requested = input.count

  if requested ~= 1 and requested ~= 2 then
    return cjson.encode({outcome="INVALID_COUNT"})
  end

  if requested > maximum then
    return cjson.encode({outcome="NEED_SIX_PLAYERS"})
  end

  if count ~= requested then
    -- Guests acknowledge the changed rules by readying up again.
    for _, player in ipairs(room.players) do
      if player.id ~= room.hostPlayerId then
        player.isReady = false
      end
    end
  end

  count = requested
  room.hackerCount = count

  redis.call("SET", KEYS[1], cjson.encode(room), "KEEPTTL")
end

local clock = redis.call("TIME")
local now = tonumber(clock[1]) * 1000 +
  math.floor(tonumber(clock[2]) / 1000)

return cjson.encode({
  outcome="OK",
  snapshot={
    count=count,
    maximum=maximum,
    playerCount=#room.players,
    phase=room.phase,
    canEdit=room.phase == "LOBBY" and room.hostPlayerId == playerId,
    serverNowMs=now
  }
})
`;

const CHAT_SCRIPT = SETTLE_VOTE_LUA + `
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

if member.eliminated or
   redis.call("HGET", KEYS[3], playerId) ~= "HACKER" or
   room.hackerCount ~= 2 then
  return cjson.encode({outcome="FORBIDDEN"})
end

local input = cjson.decode(ARGV[3])
local clock = redis.call("TIME")
local now = tonumber(clock[1]) * 1000 +
  math.floor(tonumber(clock[2]) / 1000)

if room.phase ~= "IN_PROGRESS" or
   not room.challenge or
   not room.codingStartsAt or
   not room.matchEndsAt or
   now < room.codingStartsAt or
   now >= room.matchEndsAt then
  return cjson.encode({outcome="NOT_ACTIVE"})
end

if input.matchId ~= room.challenge.matchId then
  return cjson.encode({outcome="MATCH_CHANGED"})
end

local privateRaw = redis.call("GET", KEYS[4])
if not privateRaw then
  return cjson.encode({outcome="NOT_ACTIVE"})
end

local private = cjson.decode(privateRaw)
local state = private.hackerChat or {
  messages={},
  lastSent={},
  nextId=0
}

if ARGV[2] == "SEND" then
  local previous = nil

  for _, message in ipairs(state.messages) do
    if message.playerId == playerId and
       message.requestId == input.requestId then
      previous = message
      break
    end
  end

  if previous then
    if previous.text ~= input.text then
      return cjson.encode({outcome="REQUEST_CONFLICT"})
    end
  else
    if now - (state.lastSent[playerId] or 0) < 2000 then
      return cjson.encode({outcome="RATE_LIMIT"})
    end

    if #state.messages >= 200 then
      return cjson.encode({outcome="CHAT_FULL"})
    end

    state.nextId = state.nextId + 1

    table.insert(state.messages, {
      id=state.nextId,
      playerId=playerId,
      displayName=member.displayName,
      requestId=input.requestId,
      text=input.text,
      sentAt=now
    })

    state.lastSent[playerId] = now
    private.hackerChat = state

    redis.call(
      "SET", KEYS[4], cjson.encode(private), "KEEPTTL"
    )
  end
end

local messages = {}
for _, message in ipairs(state.messages) do
  table.insert(messages, {
    id=message.id,
    playerId=message.playerId,
    displayName=message.displayName,
    text=message.text,
    sentAt=message.sentAt
  })
end

local members = {}
for _, player in ipairs(room.players) do
  if not player.eliminated and
     redis.call("HGET", KEYS[3], player.id) == "HACKER" then
    table.insert(members, {
      id=player.id,
      displayName=player.displayName
    })
  end
end

return cjson.encode({
  outcome="OK",
  snapshot={
    matchId=room.challenge.matchId,
    playerId=playerId,
    serverNowMs=now,
    revision=state.nextId,
    members=members,
    messages=messages
  }
})
`;

interface StoreReply {
  outcome: string;
  snapshot?: unknown;
}

async function execute(
  script: string,
  code: string,
  tokenHash: string,
  mode: string,
  input: object,
): Promise<StoreReply> {
  await readTimedRoom(code);

  const key = `ghost-writer:room:${code}`;

  const raw = await redis.eval(script, {
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
    throw new Error("Invalid hacker-store response.");
  }

  return JSON.parse(raw, (key: string, value: unknown) => {
    if (
      (key === "messages" || key === "members") &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    ) {
      return [];
    }

    return value;
  }) as StoreReply;
}

export function hackerSettingsStore(
  code: string,
  tokenHash: string,
  mode: "READ" | "UPDATE",
  input: { count?: number } = {},
) {
  return execute(SETTINGS_SCRIPT, code, tokenHash, mode, input);
}

export function hackerChatStore(
  code: string,
  tokenHash: string,
  mode: "READ" | "SEND",
  input: {
    matchId: string;
    requestId?: string;
    text?: string;
  },
) {
  return execute(CHAT_SCRIPT, code, tokenHash, mode, input);
}