import { Router } from "express";
import {
  createRoomWithSession,
  getRoomByCode,
  getPlayerSession,
  joinRoomWithSession,
} from "../services/room-service.js";

import {
  isSessionToken,
  readBearerToken,
} from "../services/session-service.js";

export const roomRouter = Router();



// POST /rooms
roomRouter.post("/", async (req, res) => {
  const displayName: unknown = req.body?.displayName;
  const sessionToken: unknown = req.body?.sessionToken;

  if (
    typeof displayName !== "string" ||
    displayName.trim().length === 0 ||
    displayName.trim().length > 40
  ) {
    res.status(400).json({
      error: "displayName must contain between 1 and 40 characters.",
    });
    return;
  }

  if (!isSessionToken(sessionToken)) {
    res.status(400).json({
      error: "sessionToken must contain 64 lowercase hexadecimal characters.",
    });
    return;
  }

  try {
    const room = await createRoomWithSession(
      displayName.trim(),
      sessionToken,
    );

    res.status(201).json({
      room,
      playerId: room.hostPlayerId,
    });
  } catch (error) {
    console.error("Failed to create room:", error);

    res.status(500).json({
      error: "Failed to create room.",
    });
  }
});



// GET /rooms/:code
roomRouter.get("/:code", async (req, res) => {
  const code = req.params.code.trim().toUpperCase();

  if (!/^[0-9A-F]{6}$/.test(code)) {
    res.status(400).json({
      error: "Room code must contain 6 hexadecimal characters.",
    });
    return;
  }

  try {
    const room = await getRoomByCode(code);

    if (room === null) {
      res.status(404).json({
        error: "Room not found or expired.",
      });
      return;
    }

    res.status(200).json({ room });
  } catch (error) {
    console.error("Failed to fetch room:", error);

    res.status(500).json({
      error: "Failed to fetch room.",
    });
  }
});

// POST /rooms/:code/join
roomRouter.post("/:code/join", async (req, res) => {
  const code = req.params.code.trim().toUpperCase();
  const displayName: unknown = req.body?.displayName;
  const requestId: unknown = req.body?.requestId;
  const sessionToken: unknown = req.body?.sessionToken;

  if (!/^[0-9A-F]{6}$/.test(code)) {
    res.status(400).json({
      error: "Room code must contain 6 hexadecimal characters.",
    });
    return;
  }

  if (
    typeof displayName !== "string" ||
    displayName.trim().length === 0 ||
    displayName.trim().length > 40
  ) {
    res.status(400).json({
      error: "displayName must contain between 1 and 40 characters.",
    });
    return;
  }

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (
    typeof requestId !== "string" ||
    !uuidPattern.test(requestId)
  ) {
    res.status(400).json({
      error: "requestId must use UUID format.",
    });
    return;
  }

  if (!isSessionToken(sessionToken)) {
    res.status(400).json({
      error: "sessionToken must contain 64 lowercase hexadecimal characters.",
    });
    return;
  }

  try {
    const result = await joinRoomWithSession(
      code,
      displayName.trim(),
      requestId.toLowerCase(),
      sessionToken,
    );

    switch (result.outcome) {
      case "NOT_FOUND":
        res.status(404).json({
          error: "Room not found or expired.",
        });
        return;

      case "NOT_IN_LOBBY":
        res.status(409).json({
          error: "This room is no longer accepting players.",
        });
        return;

      case "FULL":
        res.status(409).json({
          error: "Room is full.",
        });
        return;

      case "REQUEST_CONFLICT":
        res.status(409).json({
          error: "Retry the join with the original name and session token.",
        });
        return;

      case "SESSION_IN_USE":
        res.status(409).json({
          error: "This session already belongs to a player in this room.",
        });
        return;

      case "JOINED":
        res.status(200).json({
          room: result.room,
          playerId: result.playerId,
        });
        return;
    }
  } catch (error) {
    console.error("Failed to join room:", error);

    res.status(500).json({
      error: "Failed to join room.",
    });
  }
});

// GET /rooms/:code/me
roomRouter.get("/:code/me", async (req, res) => {
  res.set("Cache-Control", "no-store");

  const code = req.params.code.trim().toUpperCase();

  if (!/^[0-9A-F]{6}$/.test(code)) {
    res.status(400).json({
      error: "Room code must contain 6 hexadecimal characters.",
    });
    return;
  }

  const sessionToken = readBearerToken(
    req.get("Authorization"),
  );

  if (sessionToken === null) {
    res.set("WWW-Authenticate", "Bearer");
    res.status(401).json({
      error: "A valid session token is required.",
    });
    return;
  }

  try {
    const result = await getPlayerSession(code, sessionToken);

    if (result.outcome === "UNAUTHORIZED") {
      res.set("WWW-Authenticate", "Bearer");
      res.status(401).json({
        error: "Invalid or expired player session.",
      });
      return;
    }

    res.status(200).json({
      roomId: result.roomId,
      player: result.player,
      isHost: result.isHost,
    });
  } catch (error) {
    console.error("Failed to look up player session:", error);

    res.status(500).json({
      error: "Failed to look up player session.",
    });
  }
});