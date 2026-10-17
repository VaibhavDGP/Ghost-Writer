import type { GeneratedChallenge } from "../services/challenge-generator.js";

export interface Player {
  id: string;
  displayName: string;
  joinedAt: string;
  isReady?: boolean;
}

export interface Room {
  id: string;
  code: string;
  hostPlayerId: string;
  phase: "LOBBY" | "IN_PROGRESS";
  players: Player[];
  maxPlayers: number;
  createdAt: string;
  challenge?: GeneratedChallenge["playerFacing"];
}