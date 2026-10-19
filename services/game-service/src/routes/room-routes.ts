import { Router } from "express";
import {
  createRoomWithSession,
  getRoomByCode,
  getPlayerSession,
  startRoom,
  leaveRoom,
  getPlayerRole,
  setPlayerReady,
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

// GET /rooms/:code/me/role
roomRouter.get("/:code/me/role", async (req, res) => {
  res.set("Cache-Control", "no-store");

  const code = req.params.code.trim().toUpperCase();

  if (!/^[0-9A-F]{6}$/.test(code)) {
    res.status(400).json({
      error: "Room code must contain 6 hexadecimal characters.",
    });
    return;
  }

  const sessionToken = readBearerToken(req.get("Authorization"));

  if (sessionToken === null) {
    res.set("WWW-Authenticate", "Bearer");
    res.status(401).json({
      error: "A valid session token is required.",
    });
    return;
  }

  try {
    const result = await getPlayerRole(code, sessionToken);

    switch (result.outcome) {
      case "NOT_FOUND":
        res.status(404).json({ error: "Room not found or expired." });
        return;

      case "UNAUTHORIZED":
        res.set("WWW-Authenticate", "Bearer");
        res.status(401).json({
          error: "Invalid or expired player session.",
        });
        return;

      case "NOT_STARTED":
        res.status(409).json({ error: "The game has not started." });
        return;

      case "ROLE_UNAVAILABLE":
        res.status(409).json({ error: "Your role is not available yet." });
        return;

      case "COUNTDOWN_ACTIVE":
        res.status(409).json({
          error: "The reveal is not available yet.",
          countdownEndsAt: result.countdownEndsAt,
        });
        return;

      case "ROLE_READY":
        res.status(200).json({
          role: result.role,
          countdownEndsAt: result.countdownEndsAt,
        });
        return;
    }
  } catch (error) {
    console.error("Failed to fetch player role:", error);
    res.status(500).json({ error: "Failed to fetch player role." });
  }
});

// PATCH /rooms/:code/ready
roomRouter.patch("/:code/ready", async (req, res) => {
  const code = req.params.code.trim().toUpperCase();
  const isReady: unknown = req.body?.isReady;

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

  if (typeof isReady !== "boolean") {
    res.status(400).json({
      error: "isReady must be true or false.",
    });
    return;
  }

  try {
    const result = await setPlayerReady(
      code,
      sessionToken,
      isReady,
    );

    switch (result.outcome) {
      case "NOT_FOUND":
        res.status(404).json({
          error: "Room not found or expired.",
        });
        return;

      case "UNAUTHORIZED":
        res.set("WWW-Authenticate", "Bearer");
        res.status(401).json({
          error: "Invalid or expired player session.",
        });
        return;

      case "NOT_IN_LOBBY":
        res.status(409).json({
          error: "Readiness can only be changed in the lobby.",
        });
        return;

      case "HOST_CANNOT_READY":
        res.status(403).json({
          error: "The host starts the game instead of marking ready.",
        });
        return;

      case "UPDATED":
        res.status(200).json({
          room: result.room,
          playerId: result.playerId,
        });
        return;
    }
  } catch (error) {
    console.error("Failed to update player readiness:", error);

    res.status(500).json({
      error: "Failed to update player readiness.",
    });
  }
});

// POST /rooms/:code/start
roomRouter.post("/:code/start", async (req, res) => {
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
    const result = await startRoom(code, sessionToken);

    switch (result.outcome) {
      case "NOT_FOUND":
        res.status(404).json({
          error: "Room not found or expired.",
        });
        return;
      
      case "RETRY_REQUIRED":
        res.status(409).json({
          error: "The player list changed while starting. Please try again.",
        });
        return;

      case "UNAUTHORIZED":
        res.set("WWW-Authenticate", "Bearer");
        res.status(401).json({
          error: "Invalid or expired player session.",
        });
        return;

      case "FORBIDDEN":
        res.status(403).json({
          error: "Only the host can start the game.",
        });
        return;

      case "NOT_IN_LOBBY":
        res.status(409).json({
          error: "The room cannot be started in its current phase.",
        });
        return;

      case "NOT_ENOUGH_PLAYERS":
        res.status(409).json({
          error: "At least two players are required to start.",
        });
        return;

      case "PLAYERS_NOT_READY":
        res.status(409).json({
          error: "Every guest must be ready before starting.",
        });
        return;

      case "STARTED":
        res.status(200).json({
          room: result.room,
        });
        return;
    }
  } catch (error) {
    console.error("Failed to start room:", error);

    res.status(500).json({
      error: "Failed to start room.",
    });
  }
});

// DELETE /rooms/:code/players/me
roomRouter.delete("/:code/players/me", async (req, res) => {
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
    const result = await leaveRoom(code, sessionToken);

    switch (result.outcome) {
      case "NOT_FOUND":
        res.status(404).json({
          error: "Room not found or expired.",
        });
        return;

      case "UNAUTHORIZED":
        res.set("WWW-Authenticate", "Bearer");
        res.status(401).json({
          error: "Invalid or expired player session.",
        });
        return;

      case "ROOM_CLOSED":
        res.status(200).json({
          outcome: "ROOM_CLOSED",
          playerId: result.playerId,
        });
        return;

      case "LEFT":
        res.status(200).json({
          outcome: "LEFT",
          room: result.room,
          playerId: result.playerId,
        });
        return;
    }
  } catch (error) {
    console.error("Failed to leave room:", error);

    res.status(500).json({
      error: "Failed to leave room.",
    });
  }
});