import { redis } from "../config/redis.js";
import type { Room } from "../types/room.js";

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