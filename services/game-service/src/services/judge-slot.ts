import { randomUUID } from "node:crypto";
import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  getPlayerRole,
  getPlayerSession,
} from "./room-service.js";
import { readBearerToken } from "./session-service.js";
import { readTimedRoom } from "../stores/match-clock.js";

type Action = "run" | "submit" | "sabotage";

type Phase =
  | "QUEUED"
  | "CHECKING"
  | "COMPLETED"
  | "ACCEPTED"
  | "REJECTED"
  | "FAILED"
  | "CANCELLED"
  | "UNKNOWN";

interface Status {
  id: string;
  matchId: string;
  action: Action;
  phase: Phase;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

interface Job {
  key: string;
  code: string;
  token: string;
  matchId: string;
  action: Action;
  status: Status;
  res: Response;
  next: NextFunction;
  claimed: boolean;
  done: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  onFinish: () => void;
  onClose: () => void;
}

class QueueError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_WAITING = 12;
const MAX_WAIT_MS = 90_000;
const STATUS_RETENTION_MS = 60_000;

const waiting: Job[] = [];
const pending = new Map<string, Job>();
const latest = new Map<string, Status>();
const leases = new WeakMap<Response, Job>();

let busy = false;
let running: Job | null = null;

export const judgeQueueRouter = Router();

function schedulePump(): void {
  queueMicrotask(pump);
}

function rememberCompletion(job: Job): void {
  const status = job.status;

  setTimeout(() => {
    if (latest.get(job.key) === status) {
      latest.delete(job.key);
    }
  }, STATUS_RETENTION_MS).unref();
}

function finish(job: Job, forcedPhase?: Phase): void {
  if (job.done) return;
  job.done = true;

  if (job.timer) clearTimeout(job.timer);

  const index = waiting.indexOf(job);
  if (index >= 0) waiting.splice(index, 1);

  job.res.off("finish", job.onFinish);
  job.res.off("close", job.onClose);
  leases.delete(job.res);

  if (pending.get(job.key) === job) {
    pending.delete(job.key);
  }

  if (running === job) {
    running = null;
    busy = false;
  }

  let phase = forcedPhase;

  if (!phase) {
    if (job.res.destroyed && !job.res.writableFinished) {
      // A lost connection does not prove whether a commit succeeded.
      phase = "UNKNOWN";
    } else if (job.res.statusCode >= 500) {
      phase = "FAILED";
    } else if (job.res.statusCode >= 400) {
      phase = "REJECTED";
    } else {
      phase = job.action === "run" ? "COMPLETED" : "ACCEPTED";
    }
  }

  job.status.phase = phase;
  job.status.finishedAt = Date.now();

  rememberCompletion(job);
  schedulePump();
}

async function authorize(
  code: string,
  token: string,
  matchId: string,
  action: Action,
): Promise<string> {
  const session = await getPlayerSession(code, token);

  if (session.outcome !== "AUTHENTICATED") {
    throw new QueueError(401, "Your player session has ended.");
  }

  const snapshot = await readTimedRoom(code);
  const room = snapshot.room;
  const now = snapshot.serverNowMs;

  if (
    !room ||
    room.id !== session.roomId ||
    room.phase !== "IN_PROGRESS" ||
    room.challenge?.matchId !== matchId
  ) {
    throw new QueueError(409, "The match changed or ended.");
  }

  const member = room.players.find(
    (player) => player.id === session.player.id,
  );

  if (!member || member.eliminated) {
    throw new QueueError(403, "Spectators cannot request code validation.");
  }

  if (!room.codingStartsAt || now < room.codingStartsAt) {
    throw new QueueError(409, "Wait for the match to begin.");
  }

  if (
    room.meeting &&
    !room.meeting.settled &&
    now < room.meeting.endsAt
  ) {
    throw new QueueError(
      409,
      "Coding actions are paused during the meeting.",
    );
  }

  const role = await getPlayerRole(code, token);

  if (role.outcome !== "ROLE_READY") {
    throw new QueueError(409, "Your match role is unavailable.");
  }

  if (action === "submit" && role.role !== "CODER") {
    throw new QueueError(403, "Only coders can submit repairs.");
  }

  if (action === "sabotage" && role.role !== "HACKER") {
    throw new QueueError(403, "Only hackers can use sabotage.");
  }

  return `${session.roomId}:${session.player.id}`;
}

function respondToError(res: Response, error: unknown): void {
  if (res.destroyed || res.writableEnded) return;

  if (error instanceof QueueError) {
    res.status(error.status).json({ error: error.message });
    return;
  }

  console.error("Judge queue failed:", error);

  res.status(503).json({
    error: "The validation queue is unavailable. Please try again.",
  });
}

async function dispatch(job: Job): Promise<void> {
  try {
    // Recheck after waiting: the player may have been eliminated,
    // a meeting may have begun, or the match may have ended.
    const key = await authorize(
      job.code,
      job.token,
      job.matchId,
      job.action,
    );

    if (job.done) return;

    if (key !== job.key) {
      throw new QueueError(401, "Your player session changed.");
    }

    if (job.res.destroyed || job.res.writableEnded) {
      finish(job, "CANCELLED");
      return;
    }

    // Continue through the existing meeting checks, repair snapshot
    // preparation, and authoritative validation/commit handlers.
    job.next();
  } catch (error) {
    if (job.done) return;

    respondToError(job.res, error);

    finish(
      job,
      error instanceof QueueError ? "REJECTED" : "FAILED",
    );
  }
}

function pump(): void {
  if (busy) return;

  const job = waiting.shift();
  if (!job) return;

  if (job.done || job.res.destroyed || job.res.writableEnded) {
    finish(job, "CANCELLED");
    schedulePump();
    return;
  }

  busy = true;
  running = job;

  if (job.timer) {
    clearTimeout(job.timer);
    job.timer = null;
  }

  job.status.phase = "CHECKING";
  job.status.startedAt = Date.now();

  leases.set(job.res, job);
  void dispatch(job);
}

/**
 * Existing validation handlers claim their queued request here.
 * They MUST call the returned release function in finally.
 *
 * Without queue middleware, retain the original single-slot behavior.
 * This also keeps independently mounted route handlers compatible.
 */
export function acquireJudgeSlot(
  res?: Response,
): (() => void) | null {
  const job = res ? leases.get(res) : undefined;

  if (job) {
    if (job.done || job.claimed) return null;

    job.claimed = true;
    return () => finish(job);
  }

  if (busy || waiting.length > 0) return null;

  busy = true;
  let released = false;

  return () => {
    if (released) return;
    released = true;
    busy = false;
    schedulePump();
  };
}

judgeQueueRouter.get("/:code/judge-status", async (req, res) => {
  res.set("Cache-Control", "no-store");

  const code = String(req.params.code).trim().toUpperCase();
  const token = readBearerToken(req.get("Authorization"));

  if (!/^[0-9A-F]{6}$/.test(code)) {
    res.status(400).json({ error: "Invalid room code." });
    return;
  }

  if (!token) {
    res.status(401).json({ error: "A player session is required." });
    return;
  }

  try {
    const session = await getPlayerSession(code, token);

    if (session.outcome !== "AUTHENTICATED") {
      res.status(401).json({ error: "Your player session has ended." });
      return;
    }

    const key = `${session.roomId}:${session.player.id}`;
    const status = latest.get(key);

    if (
      !status ||
      (
        typeof req.query.matchId === "string" &&
        req.query.matchId !== status.matchId
      )
    ) {
      res.json({ job: null });
      return;
    }

    const pendingJob = pending.get(key);
    const position =
      status.phase === "QUEUED" && pendingJob
        ? waiting.indexOf(pendingJob) + 1
        : 0;

    // Only return this player's status. Never expose another
    // player's action, source code, role, or hidden-test details.
    res.json({
      job: {
        ...status,
        position: Math.max(0, position),
      },
    });
  } catch (error) {
    respondToError(res, error);
  }
});

async function enqueue(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  res.set("Cache-Control", "no-store");

  const code = String(req.params.code).trim().toUpperCase();
  const actionName = req.path.split("/").at(-1);
  const token = readBearerToken(req.get("Authorization"));

  if (
    actionName !== "run" &&
    actionName !== "submit" &&
    actionName !== "sabotage"
  ) {
    next();
    return;
  }

  const action: Action = actionName;
  const body: unknown = req.body;

  if (!/^[0-9A-F]{6}$/.test(code)) {
    res.status(400).json({ error: "Invalid room code." });
    return;
  }

  if (!token) {
    res.status(401).json({ error: "A player session is required." });
    return;
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    res.status(400).json({ error: "A JSON request is required." });
    return;
  }

  const matchId = (body as Record<string, unknown>).matchId;

  if (
    typeof matchId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      matchId,
    )
  ) {
    res.status(400).json({ error: "A valid matchId is required." });
    return;
  }

  try {
    const key = await authorize(code, token, matchId, action);

    if (res.destroyed || res.writableEnded) return;

    // No await between checking and registering: simultaneous
    // requests from this player cannot both enter the queue.
    if (pending.has(key)) {
      res.set("Retry-After", "2");
      res.status(429).json({
        error: "You already have a queued or running validation.",
      });
      return;
    }

    if (waiting.length >= MAX_WAITING) {
      res.set("Retry-After", "5");
      res.status(429).json({
        error: "The validation queue is full. Please try again shortly.",
      });
      return;
    }

    const status: Status = {
      id: randomUUID(),
      matchId,
      action,
      phase: "QUEUED",
      queuedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
    };

    const job: Job = {
      key,
      code,
      token,
      matchId,
      action,
      status,
      res,
      next,
      claimed: false,
      done: false,
      timer: null,
      onFinish: () => {},
      onClose: () => {},
    };

    job.onFinish = () => {
      // Early middleware/validation rejections never claim the slot.
      if (!job.claimed) finish(job);
    };

    job.onClose = () => {
      if (!job.claimed) {
        finish(job, "CANCELLED");
      }
      // Once a handler starts Docker work, its finally block owns
      // release. A disconnect must not free the slot prematurely.
    };

    job.timer = setTimeout(() => {
      if (job.done || job.status.phase !== "QUEUED") return;

      job.res.status(503).json({
        error:
          "The queue wait exceeded 90 seconds. Your request did not run. Please try again.",
      });

      finish(job, "FAILED");
    }, MAX_WAIT_MS);

    job.timer.unref();

    res.once("finish", job.onFinish);
    res.once("close", job.onClose);

    pending.set(key, job);
    latest.set(key, status);
    waiting.push(job);

    pump();
  } catch (error) {
    respondToError(res, error);
  }
}

judgeQueueRouter.post(
  ["/:code/run", "/:code/submit", "/:code/sabotage"],
  enqueue,
);