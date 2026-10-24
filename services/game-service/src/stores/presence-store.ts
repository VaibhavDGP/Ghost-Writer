import { redis } from "../config/redis.js";
import type { Room } from "../types/room.js";
import type { LeaveRoomResult } from "./room-store.js";
import { readTimedRoom } from "./match-clock.js";
import { SETTLE_VOTE_LUA } from "./voting-lua.js";

type HeartbeatResult =
  | {
      outcome: "OK";
      room: Room;
      playerId: string;
      serverNowMs: number;
    }
  | { outcome: "NOT_FOUND" }
  | { outcome: "UNAUTHORIZED" };

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

if ARGV[2] == "LEAVE" then
  gwPresence(playerId, false)

  local updated = redis.call("GET", KEYS[1])

  if not updated then
    return cjson.encode({
      outcome="ROOM_CLOSED",
      playerId=playerId
    })
  end

  return cjson.encode({
    outcome="LEFT",
    room=cjson.decode(updated),
    playerId=playerId
  })
end

local clock = redis.call("TIME")
local now = tonumber(clock[1]) * 1000 +
  math.floor(tonumber(clock[2]) / 1000)

member.lastSeenAt = now
member.connected = true

redis.call("SET", KEYS[1], cjson.encode(room), "KEEPTTL")

return cjson.encode({
  outcome="OK",
  room=room,
  playerId=playerId,
  serverNowMs=now
})
`;

async function execute<T>(
  code: string,
  tokenHash: string,
  mode: "HEARTBEAT" | "LEAVE",
): Promise<T> {
  // Resolve a match deadline before processing a heartbeat or departure.
  await readTimedRoom(code);

  const key = `ghost-writer:room:${code}`;

  const raw = await redis.eval(SCRIPT, {
    keys: [
      key,
      `${key}:sessions`,
      `${key}:player-roles`,
      `${key}:server-challenge`,
      `${key}:join-requests`,
    ],
    arguments: [tokenHash, mode],
  });

  if (typeof raw !== "string") {
    throw new Error("Invalid presence-store response.");
  }

  return JSON.parse(raw, (key: string, value: unknown) => {
    const arrayFields = [
      "players",
      "departedPlayers",
      "eligibleIds",
      "completedObjectiveIds",
      "tally",
    ];

    if (
      arrayFields.includes(key) &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    ) {
      return [];
    }

    return value;
  }) as T;
}

export function heartbeatRoom(
  code: string,
  tokenHash: string,
): Promise<HeartbeatResult> {
  return execute<HeartbeatResult>(code, tokenHash, "HEARTBEAT");
}

export function leaveRoomWithPresence(
  code: string,
  tokenHash: string,
): Promise<LeaveRoomResult> {
  return execute<LeaveRoomResult>(code, tokenHash, "LEAVE");
}

// Also process departures when nobody is making requests.
// Overlapping sweeps are prevented within this server process.
export function startPresenceSweeper(): () => void {
  let busy = false;
  let stopped = false;

  async function sweep() {
    if (busy || stopped) return;
    busy = true;

    try {
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
          throw new Error("Invalid Redis SCAN response.");
        }

        cursor = String(reply[0]);

        for (const entry of reply[1]) {
          if (stopped) return;

          const key = String(entry);
          const code = key.slice("ghost-writer:room:".length);

          if (/^[0-9A-F]{6}$/.test(code)) {
            await readTimedRoom(code);
          }
        }
      } while (cursor !== "0" && !stopped);
    } catch (error) {
      console.error("Presence sweep failed:", error);
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(() => {
    void sweep();
  }, 5000);

  timer.unref();
  void sweep();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}