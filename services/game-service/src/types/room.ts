import type { GeneratedChallenge } from "../services/challenge-generator.js";

export type GameRole = "CODER" | "HACKER";

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
  countdownEndsAt?: number;
  challenge?: GeneratedChallenge["playerFacing"];
}