import { Router } from "express";
import { judgePublicDraft } from "../../../../workers/code-judge/judge.mjs";
import { redis } from "../config/redis.js";
import {
  JUDGE_HEALTH_KEY,
  JUDGE_PAUSE_LUA,
} from "../stores/judge-pause-lua.js";

interface Health {
  available: boolean;
  since?: number;
  endedAt?: number;
  checkedAt: number;
}

const HEALTH_UPDATE_SCRIPT = `
local clock = redis.call("TIME")
local now = tonumber(clock[1]) * 1000 +
  math.floor(tonumber(clock[2]) / 1000)

local raw = redis.call("GET", KEYS[1])
local previous = raw and cjson.decode(raw) or {}
local available = ARGV[1] == "1"

local health = {
  available=available,
  checkedAt=now,
  since=previous.since,
  endedAt=previous.endedAt
}

if not available then
  if previous.available ~= false then
    health.since = now
  end

  health.endedAt = nil
elseif previous.available == false then
  health.endedAt = now
end

redis.call("SET", KEYS[1], cjson.encode(health))
return cjson.encode(health)
`;

const SYNC_ROOM_SCRIPT = JUDGE_PAUSE_LUA + `
gwSyncJudgePause()
return 1
`;

// This source and its test are controlled by the server.
// No player's source or test output is used to declare an outage.
const PROBE_SOURCE = `
#include <iostream>
int main() {
  int value;
  if (!(std::cin >> value)) return 1;
  std::cout << value + 1 << '\\n';
  return 0;
}
`;

let checking: Promise<void> | null = null;

async function readHealth(): Promise<Health | null> {
  const raw = await redis.get(JUDGE_HEALTH_KEY);

  if (!raw) return null;

  return JSON.parse(raw) as Health;
}

async function synchronizeRooms(): Promise<void> {
  let cursor = "0";

  do {
    const reply = await redis.sendCommand([
      "SCAN",
      cursor,
      "MATCH",
      "ghost-writer:room:??????",
      "COUNT",
      "100",
    ]);

    if (
      !Array.isArray(reply) ||
      reply.length !== 2 ||
      !Array.isArray(reply[1])
    ) {
      throw new Error("Invalid room scan response.");
    }

    cursor = String(reply[0]);

    for (const entry of reply[1]) {
      const key = String(entry);
      const code = key.slice("ghost-writer:room:".length);

      if (!/^[0-9A-F]{6}$/.test(code)) continue;

      await redis.eval(SYNC_ROOM_SCRIPT, {
        keys: [
          key,
          `${key}:sessions`,
          `${key}:player-roles`,
          `${key}:server-challenge`,
          `${key}:join-requests`,
        ],
        arguments: [],
      });
    }
  } while (cursor !== "0");
}

export function checkJudgeAvailability(): Promise<void> {
  if (checking) return checking;

  checking = (async () => {
    // Finish accounting for the previous health state before
    // recording another transition.
    await synchronizeRooms();

    let available = false;

    try {
      const result = await judgePublicDraft({
        source: PROBE_SOURCE,
        tests: [
          {
            id: "judge-health",
            input: "41\n",
            expectedOutput: "42\n",
          },
        ],
      });

      available =
        result.status === "COMPLETED" &&
        result.tests.length === 1 &&
        result.tests.every((test) => test.status === "PASSED");
    } catch (error) {
      console.error("Trusted judge health check failed:", error);
    }

    await redis.eval(HEALTH_UPDATE_SCRIPT, {
      keys: [JUDGE_HEALTH_KEY],
      arguments: [available ? "1" : "0"],
    });

    // Apply the transition to idle rooms as well as active clients.
    await synchronizeRooms();
  })().finally(() => {
    checking = null;
  });

  return checking;
}

/**
 * Used by Run, Submit and Sabotage.
 *
 * Compilation failures and wrong answers are ordinary returned
 * verdicts. They do not directly declare an infrastructure outage.
 */
export async function judgeWithAvailability(
  input: Parameters<typeof judgePublicDraft>[0],
) {
  const health = await readHealth();

  if (health?.available === false) {
    throw new Error("Code validation is temporarily unavailable.");
  }

  try {
    return await judgePublicDraft(input);
  } catch (error) {
    // Confirm availability with independent trusted code.
    // A rejected player submission alone never pauses the game.
    try {
      await checkJudgeAvailability();
    } catch (healthError) {
      console.error("Could not update judge health:", healthError);
    }

    throw error;
  }
}

export async function startJudgeMonitor(): Promise<() => void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Establish health before accepting new requests.
  await checkJudgeAvailability();

  async function tick(): Promise<void> {
    if (stopped) return;

    try {
      await checkJudgeAvailability();
    } catch (error) {
      console.error("Judge monitor failed:", error);
    } finally {
      if (!stopped) {
        timer = setTimeout(() => void tick(), 10_000);
        timer.unref();
      }
    }
  }

  timer = setTimeout(() => void tick(), 10_000);
  timer.unref();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

export const judgeAvailabilityRouter = Router();

// Existing matches can remain visible during an outage,
// but don't start another match until validation is available.
judgeAvailabilityRouter.post("/:code/start", async (_req, res, next) => {
  try {
    const health = await readHealth();

    if (health?.available === false) {
      res.set("Retry-After", "10");
      res.status(503).json({
        error:
          "Code validation is temporarily unavailable. Wait for recovery before starting.",
      });
      return;
    }

    next();
  } catch {
    res.status(503).json({
      error: "Could not confirm code-validator availability.",
    });
  }
});