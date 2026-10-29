import { createHash } from "node:crypto";
import { Router, type Response } from "express";
import { judgePublicDraft } from "../../../../workers/code-judge/judge.mjs";
import { acquireJudgeSlot } from "../services/judge-slot.js";
import { splitFunctions } from "../services/function-document.js";
import {
  hashSessionToken,
  readBearerToken,
} from "../services/session-service.js";
import {
  mutations,
  applyMutation,
  hasBoundedDamage,
} from "../services/sabotage-policy.js";
import {
  sabotageStore,
  type SabotageRequest,
} from "../stores/sabotage-store.js";
import { findServerChallenge } from "../stores/challenge-store.js";

export const sabotageRouter = Router();

function fail(res: Response, outcome: string) {
  const status =
    outcome === "NOT_FOUND"
      ? 404
      : outcome === "UNAUTHORIZED"
        ? 401
        : outcome === "FORBIDDEN"
          ? 403
          : outcome === "COOLDOWN" || outcome === "RATE_LIMIT"
            ? 429
            : 409;

  res.status(status).json({
    error: outcome.replaceAll("_", " ").toLowerCase(),
  });
}

sabotageRouter.use("/:code/sabotage", (req, res, next) => {
  res.set("Cache-Control", "no-store");

  if (!/^[0-9A-F]{6}$/i.test(String(req.params.code))) {
    res.status(400).json({ error: "Invalid room code." });
    return;
  }

  const token = readBearerToken(req.get("Authorization"));

  if (!token) {
    res.status(401).json({
      error: "A valid player session is required.",
    });
    return;
  }

  res.locals.tokenHash = hashSessionToken(token);
  next();
});

sabotageRouter.get("/:code/sabotage", async (req, res) => {
  try {
    const snapshot = await sabotageStore(
      req.params.code.toUpperCase(),
      res.locals.tokenHash as string,
      "READ",
    );

    const { room, economy, nowMs } = snapshot;

    if (
      snapshot.outcome !== "READY" ||
      !room?.challenge ||
      !economy ||
      nowMs === undefined
    ) {
      fail(res, snapshot.outcome);
      return;
    }

    const challenge = room.challenge;

    const catalog =
      snapshot.privateChallenge?.approvedMutations ??
      mutations;

    const choices = catalog
      .filter((mutation) =>
        challenge.objectives.some(
          (item) => item.id === mutation.objectiveId,
        ),
      )
      .map((mutation) => {
        let available = false;

        try {
          available =
            applyMutation(challenge.source, mutation) !== null;
        } catch {
          // Unsupported or ambiguous syntax is not mutated.
        }

        return {
          id: mutation.id,
          label: mutation.label,
          available,
          cost: economy.verified[mutation.objectiveId] ? 2 : 1,
        };
      });

    res.json({
      matchId: challenge.matchId,
      codeVersion: challenge.codeVersion,
      tokensRemaining: economy.tokens,
      cooldownRemainingMs: Math.max(
        0,
        economy.nextAllowedAt -
          nowMs -
          Math.max(0, (room.meeting?.endsAt ?? 0) - nowMs),
      ),
      mutations: choices,
    });
  } catch (error) {
    console.error("Sabotage status failed:", error);

    res.status(503).json({
      error: "Could not load sabotage status.",
    });
  }
});

sabotageRouter.post("/:code/sabotage", async (req, res) => {
  const body: unknown = req.body;

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    res.status(400).json({
      error: "Invalid sabotage request.",
    });
    return;
  }

  const payload = body as Record<string, unknown>;

  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (
    Object.keys(payload).some(
      (key) =>
        ![
          "matchId",
          "baseVersion",
          "mutationId",
          "requestId",
        ].includes(key),
    ) ||
    typeof payload.matchId !== "string" ||
    !uuid.test(payload.matchId) ||
    typeof payload.requestId !== "string" ||
    !uuid.test(payload.requestId) ||
    typeof payload.baseVersion !== "number" ||
    !Number.isSafeInteger(payload.baseVersion) ||
    payload.baseVersion < 0 ||
    typeof payload.mutationId !== "string"
  ) {
    res.status(400).json({
      error: "Invalid sabotage request.",
    });
    return;
  }

  const code = req.params.code.toUpperCase();
  const tokenHash = res.locals.tokenHash as string;
    const release = acquireJudgeSlot(res);

  if (!release) {
    res.status(429).json({
      error: "The judge is busy. Retry shortly.",
    });
    return;
  }

  try {
    const policy = await findServerChallenge(code);
    const catalog = policy?.approvedMutations ?? mutations;

    const mutation = catalog.find(
      (item) => item.id === payload.mutationId,
    );

    if (!mutation) {
      res.status(400).json({
        error: "Unknown approved mutation.",
      });
      return;
    }

    const request: SabotageRequest = {
      matchId: payload.matchId,
      baseVersion: payload.baseVersion,
      mutationId: payload.mutationId,
      requestId: payload.requestId,
      objectiveId: mutation.objectiveId,
            functionName: mutation.functionName,
    };

    const snapshot = await sabotageStore(
      code,
      tokenHash,
      "PREPARE",
      request,
    );

    if (snapshot.outcome === "REPLAYED") {
      res.json(snapshot.receipt);
      return;
    }

    const challenge = snapshot.room?.challenge;
    const privateChallenge = snapshot.privateChallenge;

    if (
      snapshot.outcome !== "READY" ||
      !challenge ||
      !privateChallenge
    ) {
      fail(res, snapshot.outcome);
      return;
    }

    let candidate: string | null = null;

    try {
      candidate = applyMutation(
        challenge.source,
        mutation,
      );
    } catch {
      // Unsupported syntax is rejected.
    }

    if (candidate === null) {
      res.status(422).json({
        error:
          "This mutation does not match the current function. No tokens spent.",
      });
      return;
    }

    const cases = [
      ...challenge.publicTests,
      ...privateChallenge.hiddenTests,
    ];

    if (
      cases.length === 0 ||
      new Set(cases.map((item) => item.id)).size !== cases.length ||
      challenge.objectives.some(
        (objective) =>
          !cases.some((item) =>
            item.objectives.includes(objective.id),
          ),
      )
    ) {
      res.status(503).json({
        error: "The trusted challenge tests are incomplete.",
      });
      return;
    }

    const tests = cases.map(
      ({ id, input, expectedOutput }) => ({
        id,
        input,
        expectedOutput,
      }),
    );

    const before = await judgePublicDraft({
      source: challenge.source,
      tests,
    });

    const after = await judgePublicDraft({
      source: candidate,
      tests,
    });

    if (
      before.status !== "COMPLETED" ||
      after.status !== "COMPLETED" ||
      !hasBoundedDamage(
        cases,
        before.tests,
        after.tests,
        mutation.objectiveId,
      )
    ) {
      res.status(422).json({
        error:
          "This mutation did not produce a permitted regression. No tokens spent.",
      });
      return;
    }

    const completedObjectiveIds = challenge.objectives
      .filter((objective) =>
        cases.every(
          (item, index) =>
            !item.objectives.includes(objective.id) ||
            after.tests[index]?.status === "PASSED",
        ),
      )
      .map((objective) => objective.id);

    const saved = await sabotageStore(
      code,
      tokenHash,
      "COMMIT",
      {
                ...request,
        functionBody: splitFunctions(candidate).bodies[mutation.functionName]!,
        source: candidate,
        sourceHash: createHash("sha256")
          .update(candidate)
          .digest("hex"),
        completedObjectiveIds,
      },
    );

    if (
      saved.outcome !== "SAVED" &&
      saved.outcome !== "REPLAYED"
    ) {
      fail(res, saved.outcome);
      return;
    }

    res.json(saved.receipt);
  } catch (error) {
    console.error("Sabotage verification failed:", error);

    res.status(503).json({
      error:
        "Verification could not finish. Retry the same request to check its outcome.",
    });
  } finally {
    release();
  }
});