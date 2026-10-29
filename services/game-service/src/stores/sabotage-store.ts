import { redis } from "../config/redis.js";
import type { Room } from "../types/room.js";
import type { GeneratedChallenge } from "../services/challenge-generator.js";
import { ACTIVE_PLAYER_LUA } from "./voting-lua.js";
export interface SabotageRequest {
  matchId: string;
  baseVersion: number;
  mutationId: string;
    functionName?: string;
  functionBody?: string;
  requestId: string;
  objectiveId?: string;
  source?: string;
  sourceHash?: string;
  completedObjectiveIds?: string[];
}

export interface SabotageReceipt {
  outcome: "SAVED";
  codeVersion: number;
  tokensRemaining: number;
  cost: number;
  nextAllowedAt: number;
}

interface Economy {
  tokens: number;
  nextAllowedAt: number;
  verified: Record<string, boolean>;
  acceptedRepairs: number;
  sabotages: number;
}

export interface SabotageSnapshot {
  outcome: string;
  room?: Room;
  privateChallenge?: GeneratedChallenge["serverOnly"];
  economy?: Economy;
  nowMs?: number;
  receipt?: SabotageReceipt;
}

const SCRIPT = ACTIVE_PLAYER_LUA + `
  local raw = redis.call("GET", KEYS[1])
  if not raw then
    return cjson.encode({outcome="NOT_FOUND"})
  end

  local room = cjson.decode(raw)
  local playerId = redis.call("HGET", KEYS[2], ARGV[1])
  local member = false

  for _, player in ipairs(room.players) do
    if player.id == playerId then member = true end
  end

  if not playerId or not member then
    return cjson.encode({outcome="UNAUTHORIZED"})
  end

  if redis.call("HGET", KEYS[3], playerId) ~= "HACKER" then
    return cjson.encode({outcome="FORBIDDEN"})
  end

  local privateRaw = redis.call("GET", KEYS[4])
  if not privateRaw or not room.challenge then
    return cjson.encode({outcome="NOT_ACTIVE"})
  end

  local private = cjson.decode(privateRaw)
  local challenge = room.challenge
  local p = cjson.decode(ARGV[3])
  local mode = ARGV[2]

  if mode ~= "READ" and room.judgePause then
    return cjson.encode({outcome="JUDGE_UNAVAILABLE"})
  end

  local clock = redis.call("TIME")
  local nowMs = tonumber(clock[1]) * 1000 +
    math.floor(tonumber(clock[2]) / 1000)

  local economy = private.sabotage or {
    tokens=3,
    nextAllowedAt=0,
    verified={},
    receipts={},
    acceptedRepairs=challenge.codeVersion,
    sabotages=0,
    attemptAfter=0
  }

  for _, id in ipairs(challenge.completedObjectiveIds or {}) do
    economy.verified[id] = true
  end

  if mode ~= "READ" then
    if p.matchId ~= challenge.matchId then
      return cjson.encode({outcome="MATCH_CHANGED"})
    end

    local previous = economy.receipts[p.requestId]

        if previous then
      if previous.playerId and previous.playerId ~= playerId then
        return cjson.encode({outcome="REQUEST_CONFLICT"})
      end

      if previous.baseVersion ~= p.baseVersion or
         previous.mutationId ~= p.mutationId then
        return cjson.encode({outcome="REQUEST_CONFLICT"})
      end

      return cjson.encode({
        outcome="REPLAYED",
        receipt=previous.receipt
      })
    end
  end

      if mode ~= "READ" and
     room.meeting and
     nowMs < tonumber(room.meeting.endsAt) then
    return cjson.encode({outcome="MEETING_ACTIVE"})
  end

  local codingStartsAt = tonumber(room.codingStartsAt)
  local matchEndsAt = tonumber(room.matchEndsAt)

  if room.phase ~= "IN_PROGRESS" or
     not codingStartsAt or
     not matchEndsAt or
     nowMs < codingStartsAt or
     nowMs >= matchEndsAt then
    return cjson.encode({outcome="NOT_ACTIVE"})
  end

  if mode ~= "READ" then
    if challenge.codeVersion ~= p.baseVersion then
      return cjson.encode({outcome="STALE_VERSION"})
    end

    local validObjective = false

    for _, objective in ipairs(challenge.objectives) do
      if objective.id == p.objectiveId then
        validObjective = true
      end
    end

    if not validObjective then
      return cjson.encode({outcome="INVALID_MUTATION"})
    end

      local doc = private.collaboration
    local target = doc and p.functionName and
      doc.functions[p.functionName] or nil

    if not target then
      return cjson.encode({outcome="START_A_FRESH_MATCH"})
    end

    if target.lock then
      return cjson.encode({outcome="FUNCTION_BUSY"})
    end

    if target.body ~= target.official then
      return cjson.encode({outcome="FUNCTION_HAS_UNSUBMITTED_EDITS"})
    end

    local cost = economy.verified[p.objectiveId] and 2 or 1

    if economy.tokens < cost then
      return cjson.encode({outcome="NO_TOKENS"})
    end

    if nowMs < economy.nextAllowedAt then
      return cjson.encode({outcome="COOLDOWN"})
    end

    if mode == "PREPARE" then
      if nowMs < (economy.attemptAfter or 0) then
        return cjson.encode({outcome="RATE_LIMIT"})
      end

      -- A short attempt limit also applies to unsuccessful verification.
      economy.attemptAfter = nowMs + 5000
      private.sabotage = economy

      redis.call(
        "SET", KEYS[4], cjson.encode(private), "KEEPTTL"
      )

        elseif mode == "COMMIT" then
      if type(p.functionBody) ~= "string" then
        return cjson.encode({outcome="INVALID_MUTATION"})
      end

      if gwRenderDocument(doc, p.functionName, p.functionBody) ~= p.source then
        return cjson.encode({outcome="INVALID_MUTATION"})
      end

      target.body = p.functionBody
      target.official = p.functionBody
      target.accepted = false
      target.revision = target.revision + 1
      doc.revision = doc.revision + 1

      challenge.source = p.source
      challenge.sourceHash = p.sourceHash
      challenge.completedObjectiveIds = p.completedObjectiveIds
      challenge.codeVersion = challenge.codeVersion + 1

      economy.tokens = economy.tokens - cost
      economy.nextAllowedAt =
        nowMs + (cost == 2 and 180000 or 120000)
      economy.sabotages = economy.sabotages + 1

      local receipt = {
        outcome="SAVED",
        codeVersion=challenge.codeVersion,
        tokensRemaining=economy.tokens,
        cost=cost,
        nextAllowedAt=economy.nextAllowedAt
      }

            economy.receipts[p.requestId] = {
        playerId=playerId,
        baseVersion=p.baseVersion,
        mutationId=p.mutationId,
        receipt=receipt
      }

      private.sabotage = economy

      redis.call(
        "SET", KEYS[1], cjson.encode(room), "KEEPTTL"
      )
      redis.call(
        "SET", KEYS[4], cjson.encode(private), "KEEPTTL"
      )

      return cjson.encode({
        outcome="SAVED",
        receipt=receipt
      })
    end
  end

  return cjson.encode({
    outcome="READY",
    room=room,
    privateChallenge=private,
    economy=economy,
    nowMs=nowMs
  })
`;

export async function sabotageStore(
  code: string,
  tokenHash: string,
  mode: "READ" | "PREPARE" | "COMMIT",
  request?: SabotageRequest,
): Promise<SabotageSnapshot> {
  const key = `ghost-writer:room:${code}`;

  const result = await redis.eval(SCRIPT, {
        keys: [
      key,
      `${key}:sessions`,
      `${key}:player-roles`,
      `${key}:server-challenge`,
      `${key}:join-requests`,
    ],
    arguments: [
      tokenHash,
      mode,
      JSON.stringify(request ?? {}),
    ],
  });

  if (typeof result !== "string") {
    throw new Error("Invalid sabotage store response.");
  }

  return JSON.parse(result, (key, value: unknown) =>
    key === "completedObjectiveIds" && !Array.isArray(value)
      ? []
      : value,
  ) as SabotageSnapshot;
}