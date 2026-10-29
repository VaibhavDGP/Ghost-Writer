import { Router } from "express";
import {
  judgeWithAvailability as judgePublicDraft,
} from "../services/judge-availability.js";
import { acquireJudgeSlot } from "../services/judge-slot.js";
import {
  getPlayerRole,
  getPlayerSession,
  getRoomByCode,
} from "../services/room-service.js";
import { readBearerToken } from "../services/session-service.js";

export const runRouter = Router();

const MAX_SOURCE_BYTES = 64 * 1024;
const RUN_COOLDOWN_MS = 5000;
const nextRunAt = new Map<string, number>();

runRouter.post("/:code/run", async (req, res) => {
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
      error: "A valid player session is required.",
    });
    return;
  }

  const body: unknown = req.body;

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    res.status(400).json({
      error: "A JSON object containing source and matchId is required.",
    });
    return;
  }

  const payload = body as Record<string, unknown>;

  if (
    Object.keys(payload).some(
      (key) => key !== "source" && key !== "matchId",
    )
  ) {
    res.status(400).json({
      error: "Only source and matchId may be submitted.",
    });
    return;
  }

  const source = payload.source;
  const matchId = payload.matchId;

  if (
    typeof source !== "string" ||
    source.trim().length === 0 ||
    Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES
  ) {
    res.status(400).json({
      error: "Source must contain between 1 and 65536 bytes.",
    });
    return;
  }

  if (
    typeof matchId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      matchId,
    )
  ) {
    res.status(400).json({
      error: "A valid matchId is required.",
    });
    return;
  }

  let releaseJudgeSlot: (() => void) | null = null;

  try {
    const session = await getPlayerSession(code, sessionToken);

    if (session.outcome !== "AUTHENTICATED") {
      res.set("WWW-Authenticate", "Bearer");
      res.status(401).json({
        error: "Invalid or expired player session.",
      });
      return;
    }

    const room = await getRoomByCode(code);

    if (room === null) {
      res.status(404).json({
        error: "Room not found or expired.",
      });
      return;
    }

    if (room.phase !== "IN_PROGRESS" || !room.challenge) {
      res.status(409).json({
        error: "There is no active challenge in this room.",
      });
      return;
    }

    if (room.challenge.matchId !== matchId) {
      res.status(409).json({
        error: "This draft belongs to a different match.",
      });
      return;
    }

    const role = await getPlayerRole(code, sessionToken);

    if (role.outcome !== "ROLE_READY") {
      res.status(409).json({
        error: "The match is not ready for code execution yet.",
      });
      return;
    }

    const rateLimitKey = `${session.roomId}:${session.player.id}`;
    const remainingMs = (nextRunAt.get(rateLimitKey) ?? 0) - Date.now();

    if (remainingMs > 0) {
      res.set("Retry-After", String(Math.ceil(remainingMs / 1000)));
      res.status(429).json({
        error: "Please wait a few seconds before running again.",
      });
      return;
    }

        releaseJudgeSlot = acquireJudgeSlot(res);

    if (releaseJudgeSlot === null) {
      res.set("Retry-After", "2");
      res.status(429).json({
        error: "The judge is busy. Please try again shortly.",
      });
      return;
    }

    nextRunAt.set(rateLimitKey, Date.now() + RUN_COOLDOWN_MS);

    setTimeout(() => {
      nextRunAt.delete(rateLimitKey);
    }, RUN_COOLDOWN_MS).unref();

    const tests = room.challenge.publicTests.map((test) => ({
      id: test.id,
      input: test.input,
      expectedOutput: test.expectedOutput,
    }));

    const result = await judgePublicDraft({ source, tests });

    const currentSession = await getPlayerSession(code, sessionToken);

    if (
      currentSession.outcome !== "AUTHENTICATED" ||
      currentSession.roomId !== session.roomId
    ) {
      res.status(401).json({
        error: "Your player session ended during execution.",
      });
      return;
    }

    const currentRoom = await getRoomByCode(code);

    if (
      currentRoom === null ||
      currentRoom.phase !== "IN_PROGRESS" ||
      currentRoom.challenge?.matchId !== matchId
    ) {
      res.status(409).json({
        error: "The match changed or ended during execution.",
      });
      return;
    }

    res.status(200).json({
      matchId,
      result,
    });
  } catch (error) {
    console.error("Failed to run private draft:", error);

    res.status(503).json({
      error: "The code judge is unavailable. Check Docker and try again.",
    });
  } finally {
    releaseJudgeSlot?.();
  }
});