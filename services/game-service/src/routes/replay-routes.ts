import { Router } from "express";
import { redis } from "../config/redis.js";
import {
  hashSessionToken,
  readBearerToken,
} from "../services/session-service.js";

export const replayRouter = Router();

const REPLAY_SCRIPT = `
  local data = redis.call("GET", KEYS[1])
  if not data then
    return cjson.encode({ outcome = "NOT_FOUND" })
  end

  local playerId = redis.call("HGET", KEYS[2], ARGV[1])
  if not playerId then
    return cjson.encode({ outcome = "UNAUTHORIZED" })
  end

  local room = cjson.decode(data)
  local isMember = false

  for _, player in ipairs(room.players) do
    if player.id == playerId then
      isMember = true
      break
    end
  end

  if not isMember then
    return cjson.encode({ outcome = "UNAUTHORIZED" })
  end

  if room.hostPlayerId ~= playerId then
    return cjson.encode({ outcome = "FORBIDDEN" })
  end

  if room.phase ~= "RESULTS" or not room.results then
    return cjson.encode({ outcome = "NOT_IN_RESULTS" })
  end

  if room.results.matchId ~= ARGV[2] then
    return cjson.encode({ outcome = "MATCH_CHANGED" })
  end

  local redisTime = redis.call("TIME")
  local nowMs = tonumber(redisTime[1]) * 1000 +
    math.floor(tonumber(redisTime[2]) / 1000)

  if nowMs >= tonumber(room.results.expiresAt) then
    redis.call("DEL", unpack(KEYS))
    return cjson.encode({ outcome = "NOT_FOUND" })
  end

  room.phase = "LOBBY"
  room.challenge = nil
  room.results = nil
  room.countdownEndsAt = nil
    room.codingStartsAt = nil
    room.matchEndsAt = nil
  room.meeting = nil
    room.meetingPausedMs = nil
  room.lastVoteResult = nil

    for _, player in ipairs(room.players) do
    player.isReady = false
    player.eliminated = nil
  end

  -- Keep the room code, roster, and authenticated player sessions.
  redis.call("SET", KEYS[1], cjson.encode(room), "EX", 3600)

  local deadline = nowMs + 3600000
  redis.call("PEXPIREAT", KEYS[2], deadline)
  redis.call("PEXPIREAT", KEYS[5], deadline)

  -- The next start generates fresh roles and private challenge tests.
  redis.call("DEL", KEYS[3], KEYS[4])

  return cjson.encode({ outcome = "REPLAY_READY" })
`;

replayRouter.post("/:code/replay", async (req, res) => {
  res.set("Cache-Control", "no-store");

  const code = req.params.code.trim().toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(code)) {
    res.status(400).json({ error: "Invalid room code." });
    return;
  }

  const token = readBearerToken(req.get("Authorization"));
  if (!token) {
    res.status(401).json({ error: "A valid player session is required." });
    return;
  }

  const body: unknown = req.body;
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    res.status(400).json({ error: "A matchId is required." });
    return;
  }

  const payload = body as Record<string, unknown>;
  const matchId = payload.matchId;

  if (
    Object.keys(payload).some((key) => key !== "matchId") ||
    typeof matchId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(matchId)
  ) {
    res.status(400).json({ error: "A valid matchId is required." });
    return;
  }

  try {
    const prefix = `ghost-writer:room:${code}`;

    const raw = await redis.eval(REPLAY_SCRIPT, {
      keys: [
        prefix,
        `${prefix}:sessions`,
        `${prefix}:player-roles`,
        `${prefix}:server-challenge`,
        `${prefix}:join-requests`,
      ],
      arguments: [hashSessionToken(token), matchId],
    });

    if (typeof raw !== "string") {
      throw new Error("Unexpected Redis replay response.");
    }

    const result = JSON.parse(raw) as { outcome: string };

    if (result.outcome === "REPLAY_READY") {
      res.status(200).json({ outcome: "REPLAY_READY" });
      return;
    }

    const errors: Record<string, { status: number; error: string }> = {
      NOT_FOUND: {
        status: 404,
        error: "The results period ended and this room closed.",
      },
      UNAUTHORIZED: {
        status: 401,
        error: "Your player session is no longer valid.",
      },
      FORBIDDEN: {
        status: 403,
        error: "Only the current host can return everyone to the lobby.",
      },
      NOT_IN_RESULTS: {
        status: 409,
        error: "This room is no longer showing results. Waiting for room updates.",
      },
      MATCH_CHANGED: {
        status: 409,
        error: "These results belong to an older match.",
      },
    };

    const failure = errors[result.outcome] ?? {
      status: 500,
      error: "Could not prepare another match.",
    };

    res.status(failure.status).json({ error: failure.error });
  } catch (error) {
    console.error("Failed to prepare replay:", error);
    res.status(503).json({
      error: "Could not reach the room store. Try again.",
    });
  }
});