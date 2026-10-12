export interface Player {
  id: string;
  displayName: string;
  joinedAt: string;
}

export interface Room {
  id: string;
  code: string;
  hostPlayerId: string;
  phase: "LOBBY";
  players: Player[];
  maxPlayers: number;
  createdAt: string;
}