import { generateUniqueChallenge } from "./unique-challenge.js";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import type { GameRole, Player, Room } from "../types/room.js";
import {
  findRoomByCode,
  saveNewRoom,
  addPlayerToRoom,
  startRoomInStore,
  setPlayerReadyInRoom,
  saveNewRoomWithSession,
  findPlayerSession,
   findPlayerRole,
  addPlayerToRoomWithSession,
} from "../stores/room-store.js";

import { leaveRoomWithPresence } from "../stores/presence-store.js";

import type {
  JoinRoomResult,
  StartRoomResult,
  LeaveRoomResult,
  PlayerSessionResult,
  SetPlayerReadyResult,
   JoinRoomWithSessionResult,
  PlayerRoleResult,
} from "../stores/room-store.js";

import {
  hashSessionToken,
  isSessionToken,
} from "./session-service.js";

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

export async function createRoomWithSession(
  displayName: string,
  sessionToken: string,
): Promise<Room> {
  if (!isSessionToken(sessionToken)) {
    throw new Error("Invalid session token format.");
  }

  const tokenHash = hashSessionToken(sessionToken);
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

    const saved = await saveNewRoomWithSession(room, tokenHash);

    if (saved) {
      return room;
    }
  }

  throw new Error("Unable to allocate a unique room code.");
}

export async function getPlayerSession(
  code: string,
  sessionToken: string,
): Promise<PlayerSessionResult> {
  if (!isSessionToken(sessionToken)) {
    return { outcome: "UNAUTHORIZED" };
  }

  return findPlayerSession(
    code,
    hashSessionToken(sessionToken),
  );
}

export async function getPlayerRole(
  code: string,
  sessionToken: string,
): Promise<PlayerRoleResult> {
  if (!isSessionToken(sessionToken)) {
    return { outcome: "UNAUTHORIZED" };
  }

  return findPlayerRole(code, hashSessionToken(sessionToken));
}

export async function joinRoomWithSession(
  code: string,
  displayName: string,
  requestId: string,
  sessionToken: string,
): Promise<JoinRoomWithSessionResult> {
  if (!isSessionToken(sessionToken)) {
    throw new Error("Invalid session token format.");
  }

  const player: Player = {
    id: randomUUID(),
    displayName,
    joinedAt: new Date().toISOString(),
  };

  return addPlayerToRoomWithSession(
    code,
    player,
    requestId,
    hashSessionToken(sessionToken),
  );
}

export async function setPlayerReady(
  code: string,
  sessionToken: string,
  isReady: boolean,
): Promise<SetPlayerReadyResult> {
  if (!isSessionToken(sessionToken)) {
    return { outcome: "UNAUTHORIZED" };
  }

  return setPlayerReadyInRoom(
    code,
    hashSessionToken(sessionToken),
    isReady,
  );
}

export async function startRoom(
  code: string,
  sessionToken: string,
): Promise<StartRoomResult> {
  if (!isSessionToken(sessionToken)) {
    return { outcome: "UNAUTHORIZED" };
  }

  const tokenHash = hashSessionToken(sessionToken);

  for (let attempt = 0; attempt < 3; attempt++) {
    const room = await findRoomByCode(code);

    if (room === null) {
      return { outcome: "NOT_FOUND" };
    }

    const session = await findPlayerSession(
      code,
      tokenHash,
    );

    if (session.outcome !== "AUTHENTICATED") {
      return { outcome: "UNAUTHORIZED" };
    }

    if (!session.isHost) {
      return { outcome: "FORBIDDEN" };
    }

    const challenge =
      room.phase === "IN_PROGRESS" ||
      room.players.length < 2
        ? null
        : await generateUniqueChallenge(room.players.length);

    const hackerIndex = randomInt(room.players.length);
    const roleAssignments: Record<string, GameRole> = {};

    room.players.forEach((player, index) => {
      roleAssignments[player.id] =
        index === hackerIndex ? "HACKER" : "CODER";
    });

    const result = await startRoomInStore(
      code,
      tokenHash,
      room.players.length,
      challenge,
      roleAssignments,
    );

    if (result.outcome !== "ROSTER_CHANGED") {
      return result;
    }
  }

  return { outcome: "RETRY_REQUIRED" };
}

export async function leaveRoom(
  code: string,
  sessionToken: string,
): Promise<LeaveRoomResult> {
  if (!isSessionToken(sessionToken)) {
    return { outcome: "UNAUTHORIZED" };
  }

  return leaveRoomWithPresence(
    code,
    hashSessionToken(sessionToken),
  );
}
