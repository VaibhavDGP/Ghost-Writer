import { createHash } from "node:crypto";
import { Router } from "express";
import { judgePublicDraft } from "../../../../workers/code-judge/judge.mjs";
import { findServerChallenge } from "../stores/challenge-store.js";
import { saveVerifiedRepair } from "../stores/repair-store.js";
import { acquireJudgeSlot } from "../services/judge-slot.js";
import {
  getPlayerRole,
  getPlayerSession,
  getRoomByCode,
} from "../services/room-service.js";
import {
  hashSessionToken,
  readBearerToken,
} from "../services/session-service.js";

export const submitRouter = Router();

const MAX_SOURCE_BYTES = 64 * 1024;
const SUBMIT_COOLDOWN_MS = 5000;
const nextSubmitAt = new Map<string, number>();

interface ObjectiveResult {
  id: string;
  complete: boolean;
}

submitRouter.post("/:code/submit", async (req, res) => {
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
      error: "A JSON object containing source, matchId, and baseVersion is required.",
    });
    return;
  }

  const payload = body as Record<string, unknown>;

  if (
    Object.keys(payload).some(
      (key) =>
        key !== "source" &&
        key !== "matchId" &&
        key !== "baseVersion",
    )
  ) {
    res.status(400).json({
      error: "Only source, matchId, and baseVersion may be submitted.",
    });
    return;
  }

  const source = payload.source;
  const matchId = payload.matchId;
  const baseVersion = payload.baseVersion;

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

  if (
    typeof baseVersion !== "number" ||
    !Number.isSafeInteger(baseVersion) ||
    baseVersion < 0
  ) {
    res.status(400).json({
      error: "baseVersion must be a non-negative integer.",
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

    const challenge = room.challenge;

    if (room.phase !== "IN_PROGRESS" || !challenge) {
      res.status(409).json({
        error: "There is no active challenge in this room.",
      });
      return;
    }

    if (challenge.matchId !== matchId) {
      res.status(409).json({
        error: "This draft belongs to a different match.",
      });
      return;
    }

    if (
      typeof challenge.codeVersion !== "number" ||
      !Array.isArray(challenge.completedObjectiveIds)
    ) {
      res.status(409).json({
        error: "This match does not have repair version tracking. Start a fresh match.",
      });
      return;
    }

    const role = await getPlayerRole(code, sessionToken);

    if (role.outcome !== "ROLE_READY") {
      res.status(409).json({
        error: "The match is not ready for submissions yet.",
      });
      return;
    }

    if (role.role !== "CODER") {
      res.status(403).json({
        error: "Only coders can submit a repair.",
      });
      return;
    }

    const rateLimitKey = `${session.roomId}:${session.player.id}`;
    const remainingMs = (nextSubmitAt.get(rateLimitKey) ?? 0) - Date.now();

    if (remainingMs > 0) {
      res.set("Retry-After", String(Math.ceil(remainingMs / 1000)));
      res.status(429).json({
        error: "Please wait before submitting again.",
      });
      return;
    }

    releaseJudgeSlot = acquireJudgeSlot();

    if (releaseJudgeSlot === null) {
      res.set("Retry-After", "2");
      res.status(429).json({
        error: "The judge is busy. Try again shortly.",
      });
      return;
    }

    nextSubmitAt.set(rateLimitKey, Date.now() + SUBMIT_COOLDOWN_MS);

    setTimeout(() => {
      nextSubmitAt.delete(rateLimitKey);
    }, SUBMIT_COOLDOWN_MS).unref();

    const serverChallenge = await findServerChallenge(code);

    if (!serverChallenge || !Array.isArray(serverChallenge.hiddenTests)) {
      res.status(503).json({
        error: "The private challenge tests are unavailable.",
      });
      return;
    }

    const objectiveResults: ObjectiveResult[] = [];

    for (const objective of challenge.objectives) {
      const objectiveTests = [
        ...challenge.publicTests,
        ...serverChallenge.hiddenTests,
      ]
        .filter((test) => test.objectives.includes(objective.id))
        .map(({ id, input, expectedOutput }) => ({
          id,
          input,
          expectedOutput,
        }));

      if (objectiveTests.length === 0) {
        res.status(503).json({
          error: "The challenge has an objective without trusted tests.",
        });
        return;
      }

      const result = await judgePublicDraft({
        source,
        tests: objectiveTests,
      });

      if (result.status === "COMPILE_ERROR") {
        res.status(422).json({
          error: "Your repair did not compile.",
          compilerOutput: result.compilerOutput,
        });
        return;
      }

      // Return objective status only; never return hidden test details.
      objectiveResults.push({
        id: objective.id,
        complete: result.tests.every((test) => test.status === "PASSED"),
      });
    }

    const completedObjectiveIds = objectiveResults
      .filter((result) => result.complete)
      .map((result) => result.id);

    const completedSet = new Set(completedObjectiveIds);
    const regressed = challenge.completedObjectiveIds.some(
      (id) => !completedSet.has(id),
    );

    if (regressed) {
      res.status(422).json({
        error: "This draft would undo an objective that was already completed.",
        objectiveResults,
      });
      return;
    }

    const hasNewProgress = completedObjectiveIds.some(
      (id) => !challenge.completedObjectiveIds.includes(id),
    );

    if (!hasNewProgress) {
      res.status(422).json({
        error: "This draft did not complete a new objective. The official code is unchanged.",
        objectiveResults,
      });
      return;
    }

    const currentSession = await getPlayerSession(code, sessionToken);

    if (
      currentSession.outcome !== "AUTHENTICATED" ||
      currentSession.roomId !== session.roomId
    ) {
      res.status(401).json({
        error: "Your player session ended during verification.",
      });
      return;
    }

    const sourceHash = createHash("sha256").update(source).digest("hex");

    const saved = await saveVerifiedRepair({
      code,
      tokenHash: hashSessionToken(sessionToken),
      matchId,
      baseVersion,
      source,
      sourceHash,
      completedObjectiveIds,
    });

    if (saved.outcome !== "SAVED") {
      const status =
        saved.outcome === "UNAUTHORIZED"
          ? 401
          : saved.outcome === "NOT_FOUND"
            ? 404
            : saved.outcome === "NOT_CODER"
              ? 403
              : 409;

      res.status(status).json({
        error:
          saved.outcome === "STALE_VERSION"
            ? "The official code changed while this repair was being checked. Reload the workspace and try again."
            : `Repair was not saved: ${saved.outcome.toLowerCase().replaceAll("_", " ")}.`,
        objectiveResults,
      });
      return;
    }

    res.status(200).json({
      matchId,
      codeVersion: saved.codeVersion,
      sourceHash,
      completedObjectiveIds: saved.completedObjectiveIds,
      objectiveResults,
    });
  } catch (error) {
    console.error("Failed to submit repair:", error);

    res.status(503).json({
      error: "The code judge is unavailable. Check Docker and try again.",
    });
  } finally {
    releaseJudgeSlot?.();
  }
});