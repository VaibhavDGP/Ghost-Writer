import { readFile } from "node:fs/promises";
import { redis } from "../config/redis.js";
import type { Room } from "../types/room.js";

const challengeConfig = JSON.parse(
  await readFile(
    new URL(
      "../../../../challenges/templates/numeric-001/challenge.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { durationSeconds: number };

// The environment override is useful for short local tests.
// Otherwise use the existing challenge configuration: 1800 seconds.
const durationSeconds = Number(
  process.env.MATCH_DURATION_SECONDS ?? challengeConfig.durationSeconds,
);

if (
  !Number.isSafeInteger(durationSeconds) ||
  durationSeconds < 10 ||
  durationSeconds > 7200
) {
  throw new Error(
    "Match duration must be an integer between 10 and 7200 seconds.",
  );
}

export const MATCH_DURATION_MS = durationSeconds * 1000;

interface ClockSnapshot {
  room: Room | null;
  serverNowMs: number;
}

const READ_TIMED_ROOM_SCRIPT = `
  local clock = redis.call("TIME")
  local nowMs = tonumber(clock[1]) * 1000 +
    math.floor(tonumber(clock[2]) / 1000)

  local raw = redis.call("GET", KEYS[1])

  if not raw then
    return cjson.encode({
      room = cjson.null,
      serverNowMs = nowMs
    })
  end

  local room = cjson.decode(raw)
  local deadline = tonumber(room.matchEndsAt)

  if room.phase == "IN_PROGRESS" and deadline and nowMs >= deadline then
    local expiresAt = deadline + 60000

    if nowMs >= expiresAt then
      redis.call("DEL", unpack(KEYS))

      return cjson.encode({
        room = cjson.null,
        serverNowMs = nowMs
      })
    end

    local challenge = room.challenge
    local privateRaw = redis.call("GET", KEYS[4])
    local private = privateRaw and cjson.decode(privateRaw) or {}
    local economy = private.sabotage or {}

    local resultPlayers = {}

    for _, player in ipairs(room.players) do
      table.insert(resultPlayers, {
        id = player.id,
        displayName = player.displayName,
        role = redis.call("HGET", KEYS[3], player.id) or "UNKNOWN"
      })
    end

    room.phase = "RESULTS"
    room.results = {
      matchId = challenge.matchId,
      winner = "HACKER",
      reason = "TIME_EXPIRED",
      finishedAt = deadline,
      expiresAt = expiresAt,
      durationMs = math.max(
        0,
        deadline - tonumber(room.codingStartsAt or room.countdownEndsAt)
      ),
      acceptedRepairs = tonumber(
        economy.acceptedRepairs or challenge.codeVersion or 0
      ),
      successfulSabotages = tonumber(economy.sabotages or 0),
      completedObjectives = #(challenge.completedObjectiveIds or {}),
      totalObjectives = #challenge.objectives,
      players = resultPlayers
    }

    redis.call("SET", KEYS[1], cjson.encode(room), "KEEPTTL")

    for _, key in ipairs(KEYS) do
      redis.call("PEXPIREAT", key, expiresAt)
    end
  end

  return cjson.encode({
    room = room,
    serverNowMs = nowMs
  })
`;

export async function readTimedRoom(
  code: string,
): Promise<ClockSnapshot> {
  const key = `ghost-writer:room:${code}`;

  const result = await redis.eval(READ_TIMED_ROOM_SCRIPT, {
    keys: [
      key,
      `${key}:sessions`,
      `${key}:player-roles`,
      `${key}:server-challenge`,
      `${key}:join-requests`,
    ],
    arguments: [],
  });

  if (typeof result !== "string") {
    throw new Error("Invalid match-clock response.");
  }

  return JSON.parse(result, (key: string, value: unknown) => {
    if (
      key === "completedObjectiveIds" &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    ) {
      return [];
    }

    return value;
  }) as ClockSnapshot;
}