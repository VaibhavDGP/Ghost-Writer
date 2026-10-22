import type { GeneratedChallenge } from "../services/challenge-generator.js";

export type GameRole = "CODER" | "HACKER";

export interface Player {
  id: string;
  displayName: string;
  joinedAt: string;
  isReady?: boolean;
}

export interface MatchResults {
  matchId: string;
  finishedAt: number;
  expiresAt: number;
  durationMs: number;
  acceptedRepairs: number;
  completedObjectives: number;
  totalObjectives: number;
  players: {
    id: string;
    displayName: string;
    role: GameRole | "UNKNOWN";
  }[];
}

export interface Room {
  id: string;
  code: string;
  hostPlayerId: string;
  phase: "LOBBY" | "IN_PROGRESS" | "RESULTS";
  players: Player[];
  maxPlayers: number;
  createdAt: string;
  countdownEndsAt?: number;
  challenge?: GeneratedChallenge["playerFacing"];
  results?: MatchResults;
}