import { randomBytes, randomUUID } from "node:crypto";
import type { Player , Room } from "../types/room.js";
import {
  findRoomByCode,
  saveNewRoom,
  addPlayerToRoom,
} from "../stores/room-store.js";

import type { JoinRoomResult } from "../stores/room-store.js";

const MAX_PLAYERS = 8;
const MAX_CODE_ATTEMPTS = 5;

function generateRoomCode(): string {
  return randomBytes(3).toString("hex").toUpperCase();
}

export async function createRoom(
  displayName: string,
): Promise<Room> {
  const hostPlayerId = randomUUID();
  const createdAt = new Date().toISOString();

  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const room: Room = {
      id: randomUUID(),
      code: generateRoomCode(),
      hostPlayerId,
      phase: "LOBBY",
      players: [
        {
          id: hostPlayerId,
          displayName,
          joinedAt: createdAt,
        },
      ],
      maxPlayers: MAX_PLAYERS,
      createdAt,
    };

    const saved = await saveNewRoom(room);

    if (saved) {
      return room;
    }
  }

  throw new Error("Unable to allocate a unique room code.");
}

export async function getRoomByCode(
  code: string,
): Promise<Room | null> {
  return findRoomByCode(code);
}

export async function joinRoom(
  code: string,
  displayName: string,
  requestId: string,
): Promise<JoinRoomResult> {
  const player: Player = {
    id: randomUUID(),
    displayName,
    joinedAt: new Date().toISOString(),
  };

  return addPlayerToRoom(code, player, requestId);
}