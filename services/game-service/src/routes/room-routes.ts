import { Router } from "express";
import {
  createRoom,
  getRoomByCode,
  joinRoom,
} from "../services/room-service.js";

export const roomRouter = Router();



// POST /rooms
roomRouter.post("/", async (req, res) => {
  const displayName: unknown = req.body?.displayName;

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

  try {
    const room = await createRoom(displayName.trim());

    res.status(201).json({ room });
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

  try {
    const result = await joinRoom(
      code,
      displayName.trim(),
      requestId.toLowerCase(),
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
          error: "requestId was already used with a different displayName.",
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