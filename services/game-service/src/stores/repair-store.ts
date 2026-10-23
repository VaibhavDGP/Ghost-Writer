import { redis } from "../config/redis.js";
import { ACTIVE_PLAYER_LUA } from "./voting-lua.js";
export interface SaveRepairRequest {
  code: string;
  tokenHash: string;
  matchId: string;
  baseVersion: number;
  source: string;
  sourceHash: string;
  completedObjectiveIds: string[];
}

export type SaveRepairResult =
  | {
      outcome: "SAVED";
      codeVersion: number;
      completedObjectiveIds: string[];
    }
  | {
      outcome:
        | "NOT_FOUND"
        | "UNAUTHORIZED"
        | "NOT_STARTED"
        | "COUNTDOWN_ACTIVE"
        | "MATCH_EXPIRED"
        | "NOT_CODER"
        | "MATCH_CHANGED"
        | "STALE_VERSION"
        | "OBJECTIVE_REGRESSION"
        | "NO_PROGRESS"
        | "INVALID_OBJECTIVE";
    };

const SAVE_REPAIR_SCRIPT = ACTIVE_PLAYER_LUA + `
  local data = redis.call("GET", KEYS[1])
  if not data then
    return cjson.encode({ outcome = "NOT_FOUND" })
  end

  local playerId = redis.call("HGET", KEYS[2], ARGV[1])
  if not playerId then
    return cjson.encode({ outcome = "UNAUTHORIZED" })
  end

  local room = cjson.decode(data)
  if room.phase ~= "IN_PROGRESS" or not room.challenge then
    return cjson.encode({ outcome = "NOT_STARTED" })
  end

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

  if redis.call("HGET", KEYS[3], playerId) ~= "CODER" then
    return cjson.encode({ outcome = "NOT_CODER" })
  end

  local redisTime = redis.call("TIME")
  local nowMs = tonumber(redisTime[1]) * 1000 +
    math.floor(tonumber(redisTime[2]) / 1000)

    local codingStartsAt = tonumber(room.codingStartsAt)
  local matchEndsAt = tonumber(room.matchEndsAt)

  if not codingStartsAt or not matchEndsAt then
    return cjson.encode({ outcome = "NOT_STARTED" })
  end

  if nowMs < codingStartsAt then
    return cjson.encode({ outcome = "COUNTDOWN_ACTIVE" })
  end

    if room.meeting and nowMs < tonumber(room.meeting.endsAt) then
    return cjson.encode({ outcome = "NOT_STARTED" })
  end

  if nowMs >= matchEndsAt then
    return cjson.encode({ outcome = "MATCH_EXPIRED" })
  end

  local challenge = room.challenge

  if challenge.matchId ~= ARGV[2] then
    return cjson.encode({ outcome = "MATCH_CHANGED" })
  end

  local currentVersion = tonumber(challenge.codeVersion)
  if not currentVersion or currentVersion ~= tonumber(ARGV[3]) then
    return cjson.encode({ outcome = "STALE_VERSION" })
  end

  local completed = cjson.decode(ARGV[6])
  local allowedObjectives = {}

  for _, objective in ipairs(challenge.objectives) do
    allowedObjectives[objective.id] = true
  end

  local requested = {}
  for _, objectiveId in ipairs(completed) do
    if not allowedObjectives[objectiveId] or requested[objectiveId] then
      return cjson.encode({ outcome = "INVALID_OBJECTIVE" })
    end
    requested[objectiveId] = true
  end

  local previous = {}
  for _, objectiveId in ipairs(challenge.completedObjectiveIds or {}) do
    previous[objectiveId] = true
    if not requested[objectiveId] then
      return cjson.encode({ outcome = "OBJECTIVE_REGRESSION" })
    end
  end

  local newCount = 0
  for objectiveId, _ in pairs(requested) do
    if not previous[objectiveId] then
      newCount = newCount + 1
    end
  end

  if newCount == 0 then
    return cjson.encode({ outcome = "NO_PROGRESS" })
  end

    local privateRaw = redis.call("GET", KEYS[4])

  if not privateRaw then
    return cjson.encode({ outcome = "NOT_STARTED" })
  end

  local private = cjson.decode(privateRaw)

  local economy = private.sabotage or {
    tokens = 3,
    nextAllowedAt = 0,
    verified = {},
    receipts = {},
    acceptedRepairs = currentVersion,
    sabotages = 0,
    attemptAfter = 0
  }

  -- Historical protection survives a later sabotage.
  for _, objectiveId in ipairs(challenge.completedObjectiveIds or {}) do
    economy.verified[objectiveId] = true
  end

  for _, objectiveId in ipairs(completed) do
    economy.verified[objectiveId] = true
  end

  economy.acceptedRepairs = economy.acceptedRepairs + 1
  private.sabotage = economy

  challenge.source = ARGV[4]
  challenge.sourceHash = ARGV[5]
  challenge.completedObjectiveIds = completed
  challenge.codeVersion = currentVersion + 1

  redis.call("SET", KEYS[4], cjson.encode(private), "KEEPTTL")

  local requiredCount = 0
  local allRequiredComplete = true

  for _, objective in ipairs(challenge.objectives) do
    if objective.required == true then
      requiredCount = requiredCount + 1
      if not requested[objective.id] then
        allRequiredComplete = false
      end
    end
  end

  if requiredCount > 0 and allRequiredComplete then
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
      winner = "CODERS",
      reason = "ALL_REPAIRED",
      finishedAt = nowMs,
      expiresAt = nowMs + 60000,
            durationMs = math.max(
        0,
        nowMs - codingStartsAt - (room.meetingPausedMs or 0)
      ),
      acceptedRepairs = economy.acceptedRepairs,
      successfulSabotages = economy.sabotages,
      completedObjectives = #completed,
      totalObjectives = #challenge.objectives,
      players = resultPlayers
    }
  end

  redis.call("SET", KEYS[1], cjson.encode(room), "KEEPTTL")

  if room.phase == "RESULTS" then
    -- Apply one shared deadline to the room and all related metadata.
    -- This is atomic with saving the final repair.
    for _, key in ipairs(KEYS) do
      redis.call("PEXPIREAT", key, room.results.expiresAt)
    end
  end

  return cjson.encode({
    outcome = "SAVED",
    codeVersion = challenge.codeVersion,
    completedObjectiveIds = challenge.completedObjectiveIds
  })
`;

export async function saveVerifiedRepair(
  request: SaveRepairRequest,
): Promise<SaveRepairResult> {
  const prefix = `ghost-writer:room:${request.code}`;

  const result = await redis.eval(SAVE_REPAIR_SCRIPT, {
    keys: [
      prefix,
      `${prefix}:sessions`,
      `${prefix}:player-roles`,
      `${prefix}:server-challenge`,
      `${prefix}:join-requests`,
    ],
    arguments: [
      request.tokenHash,
      request.matchId,
      String(request.baseVersion),
      request.source,
      request.sourceHash,
      JSON.stringify(request.completedObjectiveIds),
    ],
  });

  if (typeof result !== "string") {
    throw new Error("Unexpected Redis repair response.");
  }

  return JSON.parse(result) as SaveRepairResult;
}