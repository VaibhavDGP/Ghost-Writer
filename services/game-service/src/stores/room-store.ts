import { redis } from "../config/redis.js";
import type { Player , Room } from "../types/room.js";

// Starter policy: rooms expire one hour after creation.
const ROOM_TTL_SECONDS = 60 * 60;

function roomKey(code: string): string {
  return `ghost-writer:room:${code}`;
}

export async function saveNewRoom(room: Room): Promise<boolean> {
  const result = await redis.set(
    roomKey(room.code),
    JSON.stringify(room),
    {
      EX: ROOM_TTL_SECONDS,
      NX: true,
    },
  );

  return result === "OK";
}

export async function findRoomByCode(
  code: string,
): Promise<Room | null> {
  const data = await redis.get(roomKey(code));

  if (data === null) {
    return null;
  }

  return JSON.parse(data) as Room;
}

export type JoinRoomResult =
  | { outcome: "JOINED"; room: Room; playerId: string }
  | { outcome: "NOT_FOUND" }
  | { outcome: "NOT_IN_LOBBY" }
  | { outcome: "FULL" }
  | { outcome: "REQUEST_CONFLICT" };

function joinRequestsKey(code: string): string {
  return `ghost-writer:room:${code}:join-requests`;
}

const JOIN_ROOM_SCRIPT = `
  local data = redis.call("GET", KEYS[1])

  if not data then
    return cjson.encode({ outcome = "NOT_FOUND" })
  end

  local room = cjson.decode(data)
  local player = cjson.decode(ARGV[1])
  local requestId = ARGV[2]

  -- Check whether this request already succeeded.
  local previousData = redis.call("HGET", KEYS[2], requestId)

  if previousData then
    local previous = cjson.decode(previousData)

    if previous.displayName ~= player.displayName then
      return cjson.encode({ outcome = "REQUEST_CONFLICT" })
    end

    return cjson.encode({
      outcome = "JOINED",
      room = room,
      playerId = previous.playerId
    })
  end

  if room.phase ~= "LOBBY" then
    return cjson.encode({ outcome = "NOT_IN_LOBBY" })
  end

  if #room.players >= room.maxPlayers then
    return cjson.encode({ outcome = "FULL" })
  end

  table.insert(room.players, player)

  redis.call("SET", KEYS[1], cjson.encode(room), "KEEPTTL")

  -- Remember the player created by this successful request.
  redis.call("HSET", KEYS[2], requestId, cjson.encode({
    playerId = player.id,
    displayName = player.displayName
  }))

  -- Give the request records the room's remaining lifetime.
  local ttl = redis.call("PTTL", KEYS[1])

  if ttl >= 0 then
    redis.call("PEXPIRE", KEYS[2], ttl)
  else
    redis.call("PERSIST", KEYS[2])
  end

  return cjson.encode({
    outcome = "JOINED",
    room = room,
    playerId = player.id
  })
`;

export async function addPlayerToRoom(
  code: string,
  player: Player,
  requestId: string,
): Promise<JoinRoomResult> {
  const result = await redis.eval(JOIN_ROOM_SCRIPT, {
    keys: [
      roomKey(code),
      joinRequestsKey(code),
    ],
    arguments: [
      JSON.stringify(player),
      requestId,
    ],
  });

  if (typeof result !== "string") {
    throw new Error("Unexpected response from Redis join operation.");
  }

  return JSON.parse(result) as JoinRoomResult;
}