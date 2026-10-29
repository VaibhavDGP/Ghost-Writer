import { redis } from "../config/redis.js";
import { SETTLE_VOTE_LUA } from "./voting-lua.js";

export type DocumentAction =
  | "READ"
  | "ACQUIRE"
  | "EDIT"
  | "RELEASE"
  | "CHECK"
  | "THAW";

export interface DocumentInput {
  matchId?: string;
  name?: string;
  lockId?: string;
  revision?: number;
  body?: string;
  checkId?: string;
}

export interface DocumentResult {
  outcome: string;
  snapshot?: unknown;
  source?: string;
  originalSource?: string;
  baseVersion?: number;
}

const SCRIPT = SETTLE_VOTE_LUA + `
local raw = redis.call("GET", KEYS[1])
if not raw then
  return cjson.encode({outcome="NOT_FOUND"})
end

local room = cjson.decode(raw)
local playerId = redis.call("HGET", KEYS[2], ARGV[1])
local member = nil

for _, player in ipairs(room.players) do
  if player.id == playerId then
    member = player
    break
  end
end

if not member then
  return cjson.encode({outcome="UNAUTHORIZED"})
end

local privateRaw = redis.call("GET", KEYS[4])
if not privateRaw or not room.challenge then
  return cjson.encode({outcome="NOT_ACTIVE"})
end

local private = cjson.decode(privateRaw)
local doc = private.collaboration
local challenge = room.challenge

if not doc or doc.matchId ~= challenge.matchId then
  return cjson.encode({outcome="START_A_FRESH_MATCH"})
end

if room.phase ~= "IN_PROGRESS" then
  return cjson.encode({outcome="NOT_ACTIVE"})
end

local action = ARGV[2]
local p = cjson.decode(ARGV[3])

if p.matchId and p.matchId ~= challenge.matchId then
  return cjson.encode({outcome="MATCH_CHANGED"})
end

local clock = redis.call("TIME")
local now = tonumber(clock[1]) * 1000 +
  math.floor(tonumber(clock[2]) / 1000)

local paused =
  room.meeting and now < tonumber(room.meeting.endsAt) or false

local editable =
  not member.eliminated and
  not paused and
  now >= tonumber(room.codingStartsAt or 0) and
  now < tonumber(room.matchEndsAt or 0)

local fn = p.name and doc.functions[p.name] or nil
local changed = false
local source = nil
local baseVersion = nil

if action == "THAW" then
  if fn and fn.lock and
     fn.lock.owner == playerId and
     fn.lock.id == p.lockId and
     fn.lock.checking and
     fn.lock.checking.id == p.checkId then
    fn.lock.checking = nil
    changed = true
  end
elseif action ~= "READ" then
  if not editable then
    return cjson.encode({outcome="EDITING_PAUSED"})
  end

  if not fn then
    return cjson.encode({outcome="UNKNOWN_FUNCTION"})
  end

  if action == "ACQUIRE" then
    for _, name in ipairs(doc.names) do
      local other = doc.functions[name]
      if other.lock and other.lock.owner == playerId then
        if name ~= p.name or other.lock.id ~= p.lockId then
          return cjson.encode({outcome="ALREADY_EDITING_A_FUNCTION"})
        end
      end
    end

    if fn.lock then
      if fn.lock.owner ~= playerId or fn.lock.id ~= p.lockId then
        return cjson.encode({outcome="FUNCTION_BUSY"})
      end
    else
      fn.lock = {
        owner=playerId,
        id=p.lockId,
        baseline=fn.body,
        hacker=redis.call("HGET", KEYS[3], playerId) == "HACKER"
      }
      changed = true
    end
  else
    local lock = fn.lock

    if not lock or
       lock.owner ~= playerId or
       lock.id ~= p.lockId then
      return cjson.encode({outcome="LOCK_LOST"})
    end

    if lock.checking then
      return cjson.encode({outcome="FUNCTION_BEING_CHECKED"})
    end

    if action == "EDIT" then
      if fn.body ~= p.body then
        if fn.revision ~= p.revision then
          return cjson.encode({outcome="STALE_FUNCTION_REVISION"})
        end

        local oldBody = fn.body
        fn.body = p.body

        if #gwRenderDocument(doc, "*", nil) > 65536 then
          fn.body = oldBody
          return cjson.encode({outcome="DOCUMENT_TOO_LARGE"})
        end

        fn.revision = fn.revision + 1
        changed = true
      end
    elseif action == "RELEASE" then
      gwReleaseFunction(doc, fn)
      changed = true
    elseif action == "CHECK" then
      if redis.call("HGET", KEYS[3], playerId) ~= "CODER" then
        return cjson.encode({outcome="ONLY_CODERS_CAN_SUBMIT"})
      end

      source = gwRenderDocument(doc, p.name, fn.body)
      baseVersion = challenge.codeVersion

      if #source > 65536 then
        return cjson.encode({outcome="DOCUMENT_TOO_LARGE"})
      end

      lock.checking = {
        id=p.checkId,
        source=source,
        revision=fn.revision,
        baseVersion=baseVersion,
        expiresAt=now + 180000
      }
      changed = true
    else
      return cjson.encode({outcome="INVALID_ACTION"})
    end
  end
end

if changed then
  doc.revision = doc.revision + 1
  redis.call("SET", KEYS[4], cjson.encode(private), "KEEPTTL")
end

local functions = {}
local assignments = {}

for _, name in ipairs(doc.names) do
  local item = doc.functions[name]
  local lock = item.lock

  functions[name] = {
    body=item.body,
    revision=item.revision,
    ownerId=lock and lock.owner or cjson.null,
    lockId=lock and lock.owner == playerId and lock.id or cjson.null,
    checking=lock and lock.checking ~= nil or false,
    accepted=item.accepted == true and item.body == item.official
  }

  if lock then
    assignments[lock.owner] = {
      name=name,
      checking=lock.checking ~= nil
    }
  end
end

local players = {}
for _, player in ipairs(room.players) do
  local assignment = assignments[player.id]
  local status = "Available"

  if player.eliminated then
    status = "Spectator"
  elseif player.connected == false then
    status = "Reconnecting"
  elseif assignment then
    status = assignment.checking and "Checking" or "Editing"
  end

  table.insert(players, {
    id=player.id,
    displayName=player.displayName,
    functionName=assignment and assignment.name or cjson.null,
    status=status
  })
end

return cjson.encode({
  outcome="OK",
  source=source,
  originalSource=source and challenge.source or nil,
  baseVersion=baseVersion,
  snapshot={
    matchId=challenge.matchId,
    revision=doc.revision,
    codeVersion=challenge.codeVersion,
    playerId=playerId,
        editable=editable,
    paused=paused,
    judgePaused=room.judgePause ~= nil,
    parts=doc.parts,
    names=doc.names,
    functions=functions,
    players=players,
    objectives=challenge.objectives,
    completedObjectiveIds=challenge.completedObjectiveIds or {},
    publicTests=challenge.publicTests
  }
})
`;

export async function sharedDocumentStore(
  code: string,
  tokenHash: string,
  action: DocumentAction,
  input: DocumentInput = {},
): Promise<DocumentResult> {
  const key = `ghost-writer:room:${code}`;

  const result = await redis.eval(SCRIPT, {
    keys: [
      key,
      `${key}:sessions`,
      `${key}:player-roles`,
      `${key}:server-challenge`,
      `${key}:join-requests`,
    ],
    arguments: [tokenHash, action, JSON.stringify(input)],
  });

  if (typeof result !== "string") {
    throw new Error("Unexpected shared-document response.");
  }

  return JSON.parse(result, (key, value: unknown) =>
    key === "completedObjectiveIds" && !Array.isArray(value) ? [] : value,
  ) as DocumentResult;
}