import { Router, type Response } from "express";
import {
  meetingStore,
  type MeetingInput,
} from "../stores/meeting-store.js";
import {
  hashSessionToken,
  readBearerToken,
} from "../services/session-service.js";

export const meetingRouter = Router();

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function identity(
  code: string,
  header: string | undefined,
  res: Response,
) {
  const normalized = code.toUpperCase();

  if (!/^[0-9A-F]{6}$/.test(normalized)) {
    res.status(400).json({ error: "Invalid room code." });
    return null;
  }

  const token = readBearerToken(header);

  if (!token) {
    res.status(401).json({
      error: "A player session is required.",
    });
    return null;
  }

  return {
    code: normalized,
    hash: hashSessionToken(token),
  };
}

function failure(res: Response, outcome: string) {
  const status =
    outcome === "UNAUTHORIZED"
      ? 401
      : outcome === "NOT_FOUND"
        ? 404
        : outcome === "RATE_LIMIT"
          ? 429
          : 409;

  res.status(status).json({
    error: outcome.toLowerCase().replaceAll("_", " "),
  });
}

// This router must be registered before the coding-action routers.
meetingRouter.post(
  ["/:code/run", "/:code/submit", "/:code/sabotage"],
  async (req, res, next) => {
    res.set("Cache-Control", "no-store");

    const auth = identity(
      typeof req.params.code === "string" ? req.params.code : "",
      req.get("Authorization"),
      res,
    );

    if (!auth) return;

    try {
      const result = await meetingStore(
        auth.code,
        auth.hash,
        "READ",
      );

      if (result.outcome === "OK" && result.snapshot?.meeting) {
        res.status(409).json({
          error: "Coding actions are paused during the meeting.",
        });
        return;
      }

      if (
        result.outcome === "UNAUTHORIZED" ||
        result.outcome === "NOT_FOUND"
      ) {
        failure(res, result.outcome);
        return;
      }

      next();
    } catch {
      res.status(503).json({
        error: "Could not check meeting state. Try again.",
      });
    }
  },
);

meetingRouter.all("/:code/meeting", async (req, res) => {
  res.set("Cache-Control", "no-store");

  if (req.method !== "GET" && req.method !== "POST") {
    res.set("Allow", "GET, POST").status(405).end();
    return;
  }

  const auth = identity(
    typeof req.params.code === "string" ? req.params.code : "",
    req.get("Authorization"),
    res,
  );

  if (!auth) return;

  let mode: "READ" | "CALL" | "CHAT" = "READ";
  let input: MeetingInput = {};

  if (req.method === "POST") {
    const body = req.body as Record<string, unknown> | null;

    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      (body.action !== "CALL" && body.action !== "CHAT") ||
      typeof body.matchId !== "string" ||
      !uuid.test(body.matchId) ||
      typeof body.requestId !== "string" ||
      !uuid.test(body.requestId)
    ) {
      res.status(400).json({
        error: "Invalid meeting request.",
      });
      return;
    }

    mode = body.action;

    input = {
      matchId: body.matchId,
      requestId: body.requestId,
    };

    if (mode === "CHAT") {
      if (
        typeof body.meetingId !== "string" ||
        body.meetingId.length > 80 ||
        typeof body.text !== "string" ||
        !body.text.trim() ||
        body.text.length > 300 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(body.text)
      ) {
        res.status(400).json({
          error: "Messages must contain 1–300 characters.",
        });
        return;
      }

      input.meetingId = body.meetingId;
      input.text = body.text.trim();
    }
  }

  try {
    const result = await meetingStore(
      auth.code,
      auth.hash,
      mode,
      input,
    );

    if (result.outcome !== "OK") {
      failure(res, result.outcome);
      return;
    }

    res.json(result.snapshot);
  } catch (error) {
    console.error("Meeting request failed:", error);

    res.status(503).json({
      error: "Could not synchronize the meeting. Try again.",
    });
  }
});