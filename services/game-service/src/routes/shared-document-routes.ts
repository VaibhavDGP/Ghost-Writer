import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import {
  sharedDocumentStore,
  type DocumentAction,
  type DocumentInput,
} from "../stores/shared-document-store.js";
import {
  hashSessionToken,
  readBearerToken,
} from "../services/session-service.js";
import { assertSameScaffold } from "../services/function-document.js";

export const sharedDocumentRouter = Router();

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function identity(req: Request, res: Response) {
  const code = String(req.params.code).trim().toUpperCase();
  const token = readBearerToken(req.get("Authorization"));

  res.set("Cache-Control", "no-store");

  if (!/^[0-9A-F]{6}$/.test(code)) {
    res.status(400).json({ error: "Invalid room code." });
    return null;
  }

  if (!token) {
    res.status(401).json({ error: "A player session is required." });
    return null;
  }

  return { code, tokenHash: hashSessionToken(token) };
}

function failure(res: Response, outcome: string) {
  res.status(
    outcome === "UNAUTHORIZED" ? 401 :
      outcome === "NOT_FOUND" ? 404 : 409,
  ).json({
    error: outcome.toLowerCase().replaceAll("_", " "),
  });
}

function payload(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validLock(p: Record<string, unknown>): boolean {
  return (
    typeof p.matchId === "string" &&
    uuid.test(p.matchId) &&
    typeof p.name === "string" &&
    /^[A-Za-z_]\w*$/.test(p.name) &&
    typeof p.lockId === "string" &&
    uuid.test(p.lockId)
  );
}

sharedDocumentRouter.get("/:code/document", async (req, res) => {
  const auth = identity(req, res);
  if (!auth) return;

  try {
    const result = await sharedDocumentStore(
      auth.code,
      auth.tokenHash,
      "READ",
    );

    if (result.outcome !== "OK") {
      failure(res, result.outcome);
      return;
    }

    res.json({ snapshot: result.snapshot });
  } catch {
    res.status(503).json({ error: "Could not load the shared document." });
  }
});

sharedDocumentRouter.post("/:code/document", async (req, res) => {
  const auth = identity(req, res);
  if (!auth) return;

  const p = payload(req.body);

  if (
    !p ||
    !validLock(p) ||
    !["ACQUIRE", "EDIT", "RELEASE"].includes(String(p.action))
  ) {
    res.status(400).json({ error: "Invalid document action." });
    return;
  }

  if (
    p.action === "EDIT" &&
    (
      typeof p.body !== "string" ||
      Buffer.byteLength(p.body, "utf8") > 65536 ||
      typeof p.revision !== "number" ||
      !Number.isSafeInteger(p.revision) ||
      p.revision < 0
    )
  ) {
    res.status(400).json({ error: "Invalid function edit." });
    return;
  }

  const input: DocumentInput = {
    matchId: p.matchId as string,
    name: p.name as string,
    lockId: p.lockId as string,
  };

  if (p.action === "EDIT") {
    input.body = p.body as string;
    input.revision = p.revision as number;
  }

  try {
    const result = await sharedDocumentStore(
      auth.code,
      auth.tokenHash,
      p.action as DocumentAction,
      input,
    );

    if (result.outcome !== "OK") {
      failure(res, result.outcome);
      return;
    }

    res.json({ snapshot: result.snapshot });
  } catch {
    res.status(503).json({ error: "Could not save the document action." });
  }
});

/**
 * Runs before the existing submitRouter.
 * The client supplies a lock, never the source to commit.
 *
 * Redis constructs:
 *   official code + this coder's claimed function.
 */
sharedDocumentRouter.post("/:code/submit", async (req, res, next) => {
  const auth = identity(req, res);
  if (!auth) return;

  const p = payload(req.body);

  if (!p || !validLock(p)) {
    res.status(400).json({
      error: "Claim a function before submitting its repair.",
    });
    return;
  }

  const input: DocumentInput = {
    matchId: p.matchId as string,
    name: p.name as string,
    lockId: p.lockId as string,
    checkId: randomUUID(),
  };

  const thaw = () =>
    sharedDocumentStore(auth.code, auth.tokenHash, "THAW", input)
      .catch((error: unknown) => {
        console.error("Could not release repair-check freeze:", error);
      });

  try {
    const result = await sharedDocumentStore(
      auth.code,
      auth.tokenHash,
      "CHECK",
      input,
    );

    if (result.outcome !== "OK") {
      failure(res, result.outcome);
      return;
    }

    if (
      typeof result.source !== "string" ||
      typeof result.originalSource !== "string" ||
      typeof result.baseVersion !== "number"
    ) {
      await thaw();
      res.status(503).json({ error: "Incomplete repair snapshot." });
      return;
    }

    try {
      assertSameScaffold(result.originalSource, result.source);
    } catch (error) {
      await thaw();
      res.status(422).json({
        error: error instanceof Error
          ? error.message
          : "The protected program structure changed.",
      });
      return;
    }

    req.body = {
      source: result.source,
      matchId: input.matchId,
      baseVersion: result.baseVersion,
    };

    res.once("finish", () => {
      void thaw();
    });

    next();
  } catch (error) {
    await thaw();
    console.error("Could not prepare shared repair:", error);
    res.status(503).json({ error: "Could not prepare the repair." });
  }
});