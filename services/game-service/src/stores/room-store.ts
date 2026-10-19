import { redis } from "../config/redis.js";
import type { GeneratedChallenge } from "../services/challenge-generator.js";
import type { GameRole } from "../types/room.js";
import type { Player , Room } from "../types/room.js";

// Starter policy: rooms expire one hour after creation.
const ROOM_TTL_SECONDS = 60 * 60;

function roomKey(code: string): string {
  return `ghost-writer:room:${code}`;
}

function serverChallengeKey(code: string): string {
  return `ghost-writer:room:${code}:server-challenge`;
}

function playerRolesKey(code: string): string {
  return `ghost-writer:room:${code}:player-roles`;
}

export async function saveNewRoom(room: Room): Promise<boolean> {
  const result = await redis.set(
    roomKey(room.code),
    JSON.stringify(room),
    {
      EX: ROOM_TTL_SECONDS,
      NX: true,
    },
  );

  return result === "OK";
}

export async function findRoomByCode(
  code: string,
): Promise<Room | null> {
  const data = await redis.get(roomKey(code));

  if (data === null) {
    return null;
  }

  return JSON.parse(data) as Room;
}

export type JoinRoomResult =
  | { outcome: "JOINED"; room: Room; playerId: string }
  | { outcome: "NOT_FOUND" }
  | { outcome: "NOT_IN_LOBBY" }
  | { outcome: "FULL" }
  | { outcome: "REQUEST_CONFLICT" };

function joinRequestsKey(code: string): string {
  return `ghost-writer:room:${code}:join-requests`;
}

const JOIN_ROOM_SCRIPT = `
  local data = redis.call("GET", KEYS[1])

  if not data then
    return cjson.encode({ outcome = "NOT_FOUND" })
  end

  local room = cjson.decode(data)
  local player = cjson.decode(ARGV[1])
  local requestId = ARGV[2]

  -- Check whether this request already succeeded.
  local previousData = redis.call("HGET", KEYS[2], requestId)

  if previousData then
    local previous = cjson.decode(previousData)

    if previous.displayName ~= player.displayName then
      return cjson.encode({ outcome = "REQUEST_CONFLICT" })
    end

    return cjson.encode({
      outcome = "JOINED",
      room = room,
      playerId = previous.playerId
    })
  end

  if room.phase ~= "LOBBY" then
    return cjson.encode({ outcome = "NOT_IN_LOBBY" })
  end

  if #room.players >= room.maxPlayers then
    return cjson.encode({ outcome = "FULL" })
  end

  table.insert(room.players, player)

  redis.call("SET", KEYS[1], cjson.encode(room), "KEEPTTL")

  -- Remember the player created by this successful request.
  redis.call("HSET", KEYS[2], requestId, cjson.encode({
    playerId = player.id,
    displayName = player.displayName
  }))

  -- Give the request records the room's remaining lifetime.
  local ttl = redis.call("PTTL", KEYS[1])

  if ttl >= 0 then
    redis.call("PEXPIRE", KEYS[2], ttl)
  else
    redis.call("PERSIST", KEYS[2])
  end

  return cjson.encode({
    outcome = "JOINED",
    room = room,
    playerId = player.id
  })
`;

export async function addPlayerToRoom(
  code: string,
  player: Player,
  requestId: string,
): Promise<JoinRoomResult> {
  const result = await redis.eval(JOIN_ROOM_SCRIPT, {
    keys: [
      roomKey(code),
      joinRequestsKey(code),
    ],
    arguments: [
      JSON.stringify(player),
      requestId,
    ],
  });

  if (typeof result !== "string") {
    throw new Error("Unexpected response from Redis join operation.");
  }

  return JSON.parse(result) as JoinRoomResult;
}

function sessionsKey(code: string): string {
  return `ghost-writer:room:${code}:sessions`;
}

const CREATE_ROOM_WITH_SESSION_SCRIPT = `
  if redis.call("EXISTS", KEYS[1]) == 1 then
    return 0
  end

  local room = cjson.decode(ARGV[1])

  redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[3])

  -- A code might be reused after an older room expires.
  -- Remove any leftover metadata belonging to that older room.
  redis.call("DEL", KEYS[2], KEYS[3], KEYS[4])

  redis.call("HSET", KEYS[2], ARGV[2], room.hostPlayerId)

  local ttl = redis.call("PTTL", KEYS[1])
  redis.call("PEXPIRE", KEYS[2], ttl)

  return 1
`;

export async function saveNewRoomWithSession(
  room: Room,
  tokenHash: string,
): Promise<boolean> {
  const result = await redis.eval(
    CREATE_ROOM_WITH_SESSION_SCRIPT,
    {
      keys: [
  roomKey(room.code),
  sessionsKey(room.code),
  joinRequestsKey(room.code),
  playerRolesKey(room.code),
],
      arguments: [
        JSON.stringify(room),
        tokenHash,
        String(ROOM_TTL_SECONDS),
      ],
    },
  );

  return result === 1;
}

export type PlayerSessionResult =
  | {
      outcome: "AUTHENTICATED";
      roomId: string;
      player: Player;
      isHost: boolean;
    }
  | {
      outcome: "UNAUTHORIZED";
    };

    const FIND_PLAYER_SESSION_SCRIPT = `
  local data = redis.call("GET", KEYS[1])

  if not data then
    return cjson.encode({ outcome = "UNAUTHORIZED" })
  end

  local playerId = redis.call("HGET", KEYS[2], ARGV[1])

  if not playerId then
    return cjson.encode({ outcome = "UNAUTHORIZED" })
  end

  local room = cjson.decode(data)

  for _, player in ipairs(room.players) do
    if player.id == playerId then
      return cjson.encode({
        outcome = "AUTHENTICATED",
        roomId = room.id,
        player = player,
        isHost = room.hostPlayerId == player.id
      })
    end
  end

  return cjson.encode({ outcome = "UNAUTHORIZED" })
`;


export async function findPlayerSession(
  code: string,
  tokenHash: string,
): Promise<PlayerSessionResult> {
  const result = await redis.eval(
    FIND_PLAYER_SESSION_SCRIPT,
    {
      keys: [
        roomKey(code),
        sessionsKey(code),
      ],
      arguments: [tokenHash],
    },
  );

  if (typeof result !== "string") {
    throw new Error("Unexpected Redis session response.");
  }

  return JSON.parse(result) as PlayerSessionResult;
}

export type JoinRoomWithSessionResult =
  | JoinRoomResult
  | { outcome: "SESSION_IN_USE" };

const JOIN_ROOM_WITH_SESSION_SCRIPT = `
  local data = redis.call("GET", KEYS[1])

  if not data then
    return cjson.encode({ outcome = "NOT_FOUND" })
  end

  local room = cjson.decode(data)
  local player = cjson.decode(ARGV[1])
  local requestId = ARGV[2]
  local tokenHash = ARGV[3]

  local previousData = redis.call("HGET", KEYS[2], requestId)

  if previousData then
    local previous = cjson.decode(previousData)

    if previous.displayName ~= player.displayName
      or previous.tokenHash ~= tokenHash then
      return cjson.encode({ outcome = "REQUEST_CONFLICT" })
    end

    local existingPlayerId = redis.call("HGET", KEYS[3], tokenHash)

    if existingPlayerId ~= previous.playerId then
      return cjson.encode({ outcome = "REQUEST_CONFLICT" })
    end

    return cjson.encode({
      outcome = "JOINED",
      room = room,
      playerId = previous.playerId
    })
  end

  if redis.call("HEXISTS", KEYS[3], tokenHash) == 1 then
    return cjson.encode({ outcome = "SESSION_IN_USE" })
  end

  if room.phase ~= "LOBBY" then
    return cjson.encode({ outcome = "NOT_IN_LOBBY" })
  end

  if #room.players >= room.maxPlayers then
    return cjson.encode({ outcome = "FULL" })
  end

  table.insert(room.players, player)

  redis.call("SET", KEYS[1], cjson.encode(room), "KEEPTTL")

  redis.call("HSET", KEYS[2], requestId, cjson.encode({
    playerId = player.id,
    displayName = player.displayName,
    tokenHash = tokenHash
  }))

  redis.call("HSET", KEYS[3], tokenHash, player.id)

  local ttl = redis.call("PTTL", KEYS[1])

  if ttl >= 0 then
    redis.call("PEXPIRE", KEYS[2], ttl)
    redis.call("PEXPIRE", KEYS[3], ttl)
  else
    redis.call("PERSIST", KEYS[2])
    redis.call("PERSIST", KEYS[3])
  end

  return cjson.encode({
    outcome = "JOINED",
    room = room,
    playerId = player.id
  })
`;

export async function addPlayerToRoomWithSession(
  code: string,
  player: Player,
  requestId: string,
  tokenHash: string,
): Promise<JoinRoomWithSessionResult> {
  const result = await redis.eval(
    JOIN_ROOM_WITH_SESSION_SCRIPT,
    {
      keys: [
        roomKey(code),
        joinRequestsKey(code),
        sessionsKey(code),
      ],
      arguments: [
        JSON.stringify(player),
        requestId,
        tokenHash,
      ],
    },
  );

  if (typeof result !== "string") {
    throw new Error("Unexpected Redis session join response.");
  }

  return JSON.parse(result) as JoinRoomWithSessionResult;
}

export type SetPlayerReadyResult =
  | {
      outcome: "UPDATED";
      room: Room;
      playerId: string;
    }
  | { outcome: "NOT_FOUND" }
  | { outcome: "UNAUTHORIZED" }
  | { outcome: "NOT_IN_LOBBY" }
  | { outcome: "HOST_CANNOT_READY" };

const SET_PLAYER_READY_SCRIPT = `
  local data = redis.call("GET", KEYS[1])

  if not data then
    return cjson.encode({ outcome = "NOT_FOUND" })
  end

  local playerId = redis.call("HGET", KEYS[2], ARGV[1])

  if not playerId then
    return cjson.encode({ outcome = "UNAUTHORIZED" })
  end

  local room = cjson.decode(data)
  local targetPlayer = nil

  for _, player in ipairs(room.players) do
    if player.id == playerId then
      targetPlayer = player
      break
    end
  end

  if not targetPlayer then
    return cjson.encode({ outcome = "UNAUTHORIZED" })
  end

  if room.phase ~= "LOBBY" then
    return cjson.encode({ outcome = "NOT_IN_LOBBY" })
  end

  if room.hostPlayerId == playerId then
    return cjson.encode({ outcome = "HOST_CANNOT_READY" })
  end

  targetPlayer.isReady = ARGV[2] == "true"

  redis.call("SET", KEYS[1], cjson.encode(room), "KEEPTTL")

  return cjson.encode({
    outcome = "UPDATED",
    room = room,
    playerId = playerId
  })
`;

export async function setPlayerReadyInRoom(
  code: string,
  tokenHash: string,
  isReady: boolean,
): Promise<SetPlayerReadyResult> {
  const result = await redis.eval(
    SET_PLAYER_READY_SCRIPT,
    {
      keys: [
        roomKey(code),
        sessionsKey(code),
      ],
      arguments: [
        tokenHash,
        String(isReady),
      ],
    },
  );

  if (typeof result !== "string") {
    throw new Error("Unexpected Redis readiness response.");
  }

  return JSON.parse(result) as SetPlayerReadyResult;
}

export type StartRoomResult =
  | {
      outcome: "STARTED";
      room: Room;
    }
  | { outcome: "NOT_FOUND" }
  | { outcome: "UNAUTHORIZED" }
  | { outcome: "FORBIDDEN" }
  | { outcome: "NOT_IN_LOBBY" }
  | { outcome: "NOT_ENOUGH_PLAYERS" }
  | { outcome: "PLAYERS_NOT_READY" }
  | { outcome: "PLAYER_COUNT_CHANGED" }
  | { outcome: "RETRY_REQUIRED" };

const MIN_PLAYERS_TO_START = 2;

const START_ROOM_SCRIPT = `
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

  if room.phase == "IN_PROGRESS" then
    return cjson.encode({
      outcome = "STARTED",
      room = room
    })
  end

  if room.phase ~= "LOBBY" then
    return cjson.encode({ outcome = "NOT_IN_LOBBY" })
  end

  local minimumPlayers = tonumber(ARGV[2])

  if #room.players < minimumPlayers then
    return cjson.encode({ outcome = "NOT_ENOUGH_PLAYERS" })
  end

  local expectedPlayerCount = tonumber(ARGV[3])

  if #room.players ~= expectedPlayerCount then
    return cjson.encode({ outcome = "PLAYER_COUNT_CHANGED" })
  end

  for _, player in ipairs(room.players) do
    if player.id ~= room.hostPlayerId and player.isReady ~= true then
      return cjson.encode({ outcome = "PLAYERS_NOT_READY" })
    end
  end

  local challenge = cjson.decode(ARGV[4])
  local roles = cjson.decode(ARGV[5])

  room.phase = "IN_PROGRESS"
  room.countdownEndsAt = ARGV[6]

  if challenge then
    room.challenge = challenge.playerFacing
  end

  redis.call("SET", KEYS[1], cjson.encode(room), "KEEPTTL")

  if challenge then
    redis.call("SET", KEYS[3], cjson.encode(challenge.serverOnly))

    local ttl = redis.call("PTTL", KEYS[1])

    if ttl >= 0 then
      redis.call("PEXPIRE", KEYS[3], ttl)
    end
  end

  redis.call("DEL", KEYS[4])

  for assignedPlayerId, role in pairs(roles) do
    redis.call("HSET", KEYS[4], assignedPlayerId, role)
  end

  local roomTtl = redis.call("PTTL", KEYS[1])

  if roomTtl >= 0 then
    redis.call("PEXPIRE", KEYS[4], roomTtl)
  end

  return cjson.encode({
    outcome = "STARTED",
    room = room
  })
`;

export async function startRoomInStore(
  code: string,
  tokenHash: string,
  expectedPlayerCount: number,
  challenge: GeneratedChallenge | null,
  roleAssignments: Record<string, GameRole>,
  countdownEndsAt: number,
): Promise<StartRoomResult> {
  const result = await redis.eval(START_ROOM_SCRIPT, {
    keys: [
      roomKey(code),
      sessionsKey(code),
      serverChallengeKey(code),
      playerRolesKey(code),
    ],
    arguments: [
      tokenHash,
      String(MIN_PLAYERS_TO_START),
      String(expectedPlayerCount),
      JSON.stringify(challenge),
      JSON.stringify(roleAssignments),
      String(countdownEndsAt),
    ],
  });

  if (typeof result !== "string") {
    throw new Error("Unexpected Redis start-room response.");
  }

  return JSON.parse(result) as StartRoomResult;
}

export type PlayerRoleResult =
  | {
      outcome: "ROLE_READY";
      role: GameRole;
      countdownEndsAt: string;
    }
  | { outcome: "NOT_FOUND" }
  | { outcome: "UNAUTHORIZED" }
  | { outcome: "NOT_STARTED" }
    | { outcome: "COUNTDOWN_ACTIVE"; countdownEndsAt: number }
  | { outcome: "ROLE_UNAVAILABLE" };

const FIND_PLAYER_ROLE_SCRIPT = `
  local data = redis.call("GET", KEYS[1])

  if not data then
    return cjson.encode({ outcome = "NOT_FOUND" })
  end

  local playerId = redis.call("HGET", KEYS[2], ARGV[1])

  if not playerId then
    return cjson.encode({ outcome = "UNAUTHORIZED" })
  end

  local room = cjson.decode(data)

      if room.phase ~= "IN_PROGRESS" then
    return cjson.encode({ outcome = "NOT_STARTED" })
  end

  local redisTime = redis.call("TIME")
  local nowMs =
    tonumber(redisTime[1]) * 1000 +
    math.floor(tonumber(redisTime[2]) / 1000)

  if nowMs < tonumber(room.countdownEndsAt) then
    return cjson.encode({
      outcome = "COUNTDOWN_ACTIVE",
      countdownEndsAt = room.countdownEndsAt
    })
  end

  local role = redis.call("HGET", KEYS[3], playerId)

  if not role then
    return cjson.encode({ outcome = "ROLE_UNAVAILABLE" })
  end

  return cjson.encode({
    outcome = "ROLE_READY",
    role = role,
    countdownEndsAt = room.countdownEndsAt
  })
`;

export async function findPlayerRole(
  code: string,
  tokenHash: string,
): Promise<PlayerRoleResult> {
  const result = await redis.eval(FIND_PLAYER_ROLE_SCRIPT, {
    keys: [
      roomKey(code),
      sessionsKey(code),
      playerRolesKey(code),
    ],
    arguments: [tokenHash],
  });

  if (typeof result !== "string") {
    throw new Error("Unexpected Redis player-role response.");
  }

  return JSON.parse(result) as PlayerRoleResult;
}

export type LeaveRoomResult =
  | { outcome: "LEFT"; room: Room; playerId: string }
  | { outcome: "ROOM_CLOSED"; playerId: string }
  | { outcome: "NOT_FOUND" }
  | { outcome: "UNAUTHORIZED" };

const LEAVE_ROOM_SCRIPT = `
  local data = redis.call("GET", KEYS[1])

  if not data then
    return cjson.encode({ outcome = "NOT_FOUND" })
  end

  local playerId = redis.call("HGET", KEYS[2], ARGV[1])

  if not playerId then
    return cjson.encode({ outcome = "UNAUTHORIZED" })
  end

  local room = cjson.decode(data)
  local playerIndex = nil

  for index, player in ipairs(room.players) do
    if player.id == playerId then
      playerIndex = index
      break
    end
  end

  if not playerIndex then
    return cjson.encode({ outcome = "UNAUTHORIZED" })
  end

  if room.hostPlayerId == playerId then
   redis.call("DEL", KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5])

    return cjson.encode({
      outcome = "ROOM_CLOSED",
      playerId = playerId
    })
  end

  table.remove(room.players, playerIndex)

  redis.call("SET", KEYS[1], cjson.encode(room), "KEEPTTL")
  redis.call("HDEL", KEYS[2], ARGV[1])
  redis.call("HDEL", KEYS[5], playerId)

  return cjson.encode({
    outcome = "LEFT",
    room = room,
    playerId = playerId
  })
`;

export async function leaveRoomInStore(
  code: string,
  tokenHash: string,
): Promise<LeaveRoomResult> {
  const result = await redis.eval(LEAVE_ROOM_SCRIPT, {
    keys: [
  roomKey(code),
  sessionsKey(code),
  joinRequestsKey(code),
  serverChallengeKey(code),
  playerRolesKey(code),
],
    arguments: [tokenHash],
  });

  if (typeof result !== "string") {
    throw new Error("Unexpected Redis leave-room response.");
  }

  return JSON.parse(result) as LeaveRoomResult;
}