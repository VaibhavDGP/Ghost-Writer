import { Router } from "express";
import {
  hashSessionToken,
  readBearerToken,
} from "../services/session-service.js";
import { heartbeatRoom } from "../stores/presence-store.js";
import { readTimedRoom } from "../stores/match-clock.js";

export const presenceRouter = Router();

presenceRouter.post("/:code/presence", async (req, res) => {
  res.set("Cache-Control", "no-store");

  const code = String(req.params.code).trim().toUpperCase();

  if (!/^[0-9A-F]{6}$/.test(code)) {
    res.status(400).json({ error: "Invalid room code." });
    return;
  }

  const token = readBearerToken(req.get("Authorization"));

  if (!token) {
    res.status(401).json({
      error: "Your player session is missing.",
    });
    return;
  }

  try {
    const result = await heartbeatRoom(
      code,
      hashSessionToken(token),
    );

    if (result.outcome === "NOT_FOUND") {
      res.status(404).json({
        error: "This room has closed or expired.",
      });
      return;
    }

    if (result.outcome === "UNAUTHORIZED") {
      res.status(401).json({
        error:
          "Your player session ended. You may have left the room or exceeded the 60-second reconnection period.",
      });
      return;
    }

    res.json({
      room: result.room,
      playerId: result.playerId,
      serverNowMs: result.serverNowMs,
    });
  } catch (error) {
    console.error("Heartbeat failed:", error);

    res.status(503).json({
      error: "Could not reconnect to the room. Retrying…",
    });
  }
});

// Run before the existing room/action routers.
// Public room reads do not renew anyone's connection.
presenceRouter.use("/:code", async (req, res, next) => {
  const code = String(req.params.code).trim().toUpperCase();

  if (!/^[0-9A-F]{6}$/.test(code)) {
    next();
    return;
  }

  try {
    await readTimedRoom(code);
    next();
  } catch (error) {
    console.error("Presence synchronization failed:", error);

    res.status(503).json({
      error: "Could not synchronize the room. Try again.",
    });
  }
});