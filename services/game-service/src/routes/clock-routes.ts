import { Router } from "express";
import { readTimedRoom } from "../stores/match-clock.js";
import { getPlayerSession } from "../services/room-service.js";
import { readBearerToken } from "../services/session-service.js";

export const clockRouter = Router();

clockRouter.get("/:code/clock", async (req, res) => {
  res.set("Cache-Control", "no-store");

  const code = req.params.code.trim().toUpperCase();

  if (!/^[0-9A-F]{6}$/.test(code)) {
    res.status(400).json({ error: "Invalid room code." });
    return;
  }

  const token = readBearerToken(req.get("Authorization"));

  if (!token) {
    res.status(401).json({ error: "A player session is required." });
    return;
  }

  try {
    const session = await getPlayerSession(code, token);

    if (session.outcome !== "AUTHENTICATED") {
      res.status(401).json({ error: "Invalid or expired player session." });
      return;
    }

    const snapshot = await readTimedRoom(code);
    const room = snapshot.room;

    if (!room) {
      res.status(404).json({ error: "The room has closed." });
      return;
    }

    if (room.id !== session.roomId) {
      res.status(401).json({ error: "Your room session has ended." });
      return;
    }

    res.json({
      phase: room.phase,
      matchId: room.challenge?.matchId ?? null,
      codingStartsAt: room.codingStartsAt ?? null,
      matchEndsAt: room.matchEndsAt ?? null,
      serverNowMs: snapshot.serverNowMs,
    });
  } catch (error) {
    console.error("Could not read match clock:", error);

    res.status(503).json({
      error: "Could not synchronize the match timer.",
    });
  }
});