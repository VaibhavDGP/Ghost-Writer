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
  | { outcome: "JOINED"; room: Room }
  | { outcome: "NOT_FOUND" }
  | { outcome: "NOT_IN_LOBBY" }
  | { outcome: "FULL" };

const JOIN_ROOM_SCRIPT = `
  local data = redis.call("GET", KEYS[1])

  if not data then
    return cjson.encode({ outcome = "NOT_FOUND" })
  end

  local room = cjson.decode(data)

  if room.phase ~= "LOBBY" then
    return cjson.encode({ outcome = "NOT_IN_LOBBY" })
  end

  if #room.players >= room.maxPlayers then
    return cjson.encode({ outcome = "FULL" })
  end

  local player = cjson.decode(ARGV[1])
  table.insert(room.players, player)

  redis.call("SET", KEYS[1], cjson.encode(room), "KEEPTTL")

  return cjson.encode({
    outcome = "JOINED",
    room = room
  })
`;

export async function addPlayerToRoom(
  code: string,
  player: Player,
): Promise<JoinRoomResult> {
  const result = await redis.eval(JOIN_ROOM_SCRIPT, {
    keys: [roomKey(code)],
    arguments: [JSON.stringify(player)],
  });

  if (typeof result !== "string") {
    throw new Error("Unexpected response from Redis join operation.");
  }

  return JSON.parse(result) as JoinRoomResult;
}