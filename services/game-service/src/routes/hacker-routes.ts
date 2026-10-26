import { Router, type Response } from "express";
import {
  hashSessionToken,
  readBearerToken,
} from "../services/session-service.js";
import {
  hackerChatStore,
  hackerSettingsStore,
} from "../stores/hacker-store.js";

export const hackerRouter = Router();

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function identity(
  code: string,
  authorization: string | undefined,
  res: Response,
) {
  res.set("Cache-Control", "no-store");

  const normalized = code.trim().toUpperCase();

  if (!/^[0-9A-F]{6}$/.test(normalized)) {
    res.status(400).json({ error: "Invalid room code." });
    return null;
  }

  const token = readBearerToken(authorization);

  if (!token) {
    res.status(401).json({
      error: "A valid player session is required.",
    });
    return null;
  }

  return {
    code: normalized,
    tokenHash: hashSessionToken(token),
  };
}

function reply(
  res: Response,
  result: { outcome: string; snapshot?: unknown },
) {
  if (result.outcome === "OK") {
    res.json(result.snapshot);
    return;
  }

  const errors: Record<
    string,
    { status: number; error: string }
  > = {
    NOT_FOUND: {
      status: 404,
      error: "This room has closed.",
    },
    UNAUTHORIZED: {
      status: 401,
      error: "Your player session has ended.",
    },
    FORBIDDEN: {
      status: 403,
      error: "You do not have access to this action.",
    },
    NOT_IN_LOBBY: {
      status: 409,
      error: "Settings can only change in the lobby.",
    },
    NEED_SIX_PLAYERS: {
      status: 409,
      error: "Two hackers require at least six players.",
    },
    INVALID_COUNT: {
      status: 400,
      error: "Choose one or two hackers.",
    },
    NOT_ACTIVE: {
      status: 409,
      error: "Private chat is available during an active match.",
    },
    MATCH_CHANGED: {
      status: 409,
      error: "This request belongs to another match.",
    },
    REQUEST_CONFLICT: {
      status: 409,
      error: "Retry the original message without changing it.",
    },
    RATE_LIMIT: {
      status: 429,
      error: "Wait two seconds between messages.",
    },
    CHAT_FULL: {
      status: 409,
      error: "The private chat reached its 200-message match limit.",
    },
  };

  const failure = errors[result.outcome] ?? {
    status: 500,
    error: "The request could not be completed.",
  };

  res.status(failure.status).json({ error: failure.error });
}

hackerRouter.all("/:code/hacker-settings", async (req, res) => {
  if (req.method !== "GET" && req.method !== "PATCH") {
    res.set("Allow", "GET, PATCH").status(405).end();
    return;
  }

  const auth = identity(
    String(req.params.code),
    req.get("Authorization"),
    res,
  );

  if (!auth) return;

  const count: unknown = req.body?.count;

  if (
    req.method === "PATCH" &&
    count !== 1 &&
    count !== 2
  ) {
    res.status(400).json({
      error: "Choose one or two hackers.",
    });
    return;
  }

  try {
    const result = await hackerSettingsStore(
      auth.code,
      auth.tokenHash,
      req.method === "PATCH" ? "UPDATE" : "READ",
      req.method === "PATCH" ? { count: count as number } : {},
    );

    reply(res, result);
  } catch (error) {
    console.error("Hacker settings failed:", error);

    res.status(503).json({
      error: "Could not synchronize hacker settings.",
    });
  }
});

hackerRouter.all("/:code/hacker-chat", async (req, res) => {
  if (req.method !== "GET" && req.method !== "POST") {
    res.set("Allow", "GET, POST").status(405).end();
    return;
  }

  const auth = identity(
    String(req.params.code),
    req.get("Authorization"),
    res,
  );

  if (!auth) return;

  const matchId: unknown =
    req.method === "GET"
      ? req.query.matchId
      : req.body?.matchId;

  if (typeof matchId !== "string" || !uuid.test(matchId)) {
    res.status(400).json({ error: "A valid matchId is required." });
    return;
  }

  const input: {
    matchId: string;
    requestId?: string;
    text?: string;
  } = { matchId };

  if (req.method === "POST") {
    const requestId: unknown = req.body?.requestId;
    const text: unknown = req.body?.text;

    if (
      typeof requestId !== "string" ||
      !uuid.test(requestId) ||
      typeof text !== "string" ||
      !text.trim() ||
      text.length > 300 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)
    ) {
      res.status(400).json({
        error: "Send a message containing 1–300 characters.",
      });
      return;
    }

    input.requestId = requestId;
    input.text = text.trim();
  }

  try {
    const result = await hackerChatStore(
      auth.code,
      auth.tokenHash,
      req.method === "POST" ? "SEND" : "READ",
      input,
    );

    reply(res, result);
  } catch (error) {
    console.error("Private hacker chat failed:", error);

    res.status(503).json({
      error: "Could not synchronize private chat.",
    });
  }
});