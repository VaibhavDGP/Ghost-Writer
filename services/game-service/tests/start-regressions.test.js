import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { redis } from "../src/config/redis.ts";
import { startRoomInStore } from "../src/stores/room-store.ts";
import { hashSessionToken } from "../src/services/session-service.ts";

// Run against a local/test game service and the same Redis URL, never production.
const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3001";
const ownedCodes = new Set();
const token = () => randomBytes(32).toString("hex");
const keys = (code) => [
  `ghost-writer:room:${code}`,
  `ghost-writer:room:${code}:sessions`,
  `ghost-writer:room:${code}:server-challenge`,
  `ghost-writer:room:${code}:player-roles`,
  `ghost-writer:room:${code}:join-requests`,
];

before(async () => { await redis.connect(); });
after(async () => {
  try {
    for (const code of ownedCodes) await redis.del(keys(code));
  } finally {
    if (redis.isOpen) await redis.quit();
  }
});

async function request(path, method = "GET", body, session) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(session ? { Authorization: `Bearer ${session}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

async function fixture() {
  const hostToken = token();
  const guestToken = token();
  const created = await request("/rooms", "POST", { displayName: "Regression host", sessionToken: hostToken });
  assert.equal(created.status, 201);
  const code = created.body.room.code;
  ownedCodes.add(code);
  const joined = await request(`/rooms/${code}/join`, "POST", {
    displayName: "Regression guest", sessionToken: guestToken, requestId: randomUUID(),
  });
  assert.equal(joined.status, 200);
  const ready = await request(`/rooms/${code}/ready`, "PATCH", { isReady: true }, guestToken);
  assert.equal(ready.status, 200);
  return { code, hostToken, guestToken, room: ready.body.room };
}

test("start returns a numeric deadline and retains every related key", async () => {
  const f = await fixture();
  const [roomKey, sessionKey, , , requestsKey] = keys(f.code);
  for (const key of [roomKey, sessionKey, requestsKey]) await redis.pExpire(key, 60_000);
  const result = await request(`/rooms/${f.code}/start`, "POST", undefined, f.hostToken);
  assert.equal(result.status, 200);
  assert.equal(typeof result.body.room.countdownEndsAt, "number");
  assert.ok(Number.isFinite(result.body.room.countdownEndsAt));
    const startedRoom = result.body.room;

  assert.equal(
    startedRoom.codingStartsAt,
    startedRoom.countdownEndsAt + 5000,
  );

  assert.ok(startedRoom.matchEndsAt > startedRoom.codingStartsAt);

  for (const key of keys(f.code)) {
    const expiresAt = Number(
      await redis.sendCommand(["PEXPIRETIME", key]),
    );

    assert.equal(
      expiresAt,
      startedRoom.matchEndsAt + 60_000,
      key,
    );
  }
  const fetched = await request(`/rooms/${f.code}`);
  assert.equal(typeof fetched.body.room.countdownEndsAt, "number");
});

test("roles are private, gated by countdown, and include exactly one hacker", async () => {
  const f = await fixture();
  assert.equal((await request(`/rooms/${f.code}/start`, "POST", undefined, f.hostToken)).status, 200);
  const roomKey = keys(f.code)[0];
  let stored = JSON.parse(await redis.get(roomKey));
  // Keep this test deterministic even on a slow machine.
  stored.countdownEndsAt = Date.now() + 60_000;
  await redis.set(roomKey, JSON.stringify(stored));
  assert.equal((await request(`/rooms/${f.code}/me/role`, "GET", undefined, f.hostToken)).status, 409);
  assert.equal((await request(`/rooms/${f.code}/me/role`, "GET", undefined, token())).status, 401);

  stored.countdownEndsAt = Date.now() - 1000;
  await redis.set(roomKey, JSON.stringify(stored));
  const host = await request(`/rooms/${f.code}/me/role`, "GET", undefined, f.hostToken);
  const guest = await request(`/rooms/${f.code}/me/role`, "GET", undefined, f.guestToken);
  assert.equal(host.status, 200);
  assert.equal(guest.status, 200);
  assert.deepEqual([host.body.role, guest.body.role].sort(), ["CODER", "HACKER"]);
  assert.equal(typeof host.body.countdownEndsAt, "number");
  const publicRoom = await request(`/rooms/${f.code}`);
  const json = JSON.stringify(publicRoom.body);
  for (const secret of ["HACKER", "referenceSource", "hiddenTests", "selectedFunctionIds"]) {
    assert.equal(json.includes(secret), false, secret);
  }
});

test("same-size roster replacement rejects stale role assignments without starting", async () => {
  const f = await fixture();
  const roles = Object.fromEntries(f.room.players.map((p) => [p.id, p.id === f.room.hostPlayerId ? "CODER" : "HACKER"]));
  assert.equal((await request(`/rooms/${f.code}/players/me`, "DELETE", undefined, f.guestToken)).status, 200);
  const replacementToken = token();
  const replacement = await request(`/rooms/${f.code}/join`, "POST", {
    displayName: "Replacement", sessionToken: replacementToken, requestId: randomUUID(),
  });
  assert.equal(replacement.status, 200);
  assert.equal((await request(`/rooms/${f.code}/ready`, "PATCH", { isReady: true }, replacementToken)).status, 200);
  // The original roster still has two assignments, but one belongs to a departed guest.
  const outcome = await startRoomInStore(f.code, hashSessionToken(f.hostToken), 2, null, roles);
  assert.equal(outcome.outcome, "ROSTER_CHANGED");
  assert.equal(JSON.parse(await redis.get(keys(f.code)[0])).phase, "LOBBY");
  const started = await request(`/rooms/${f.code}/start`, "POST", undefined, f.hostToken);
  assert.equal(started.status, 200);
  const storedRoles = await redis.hGetAll(keys(f.code)[3]);
  assert.deepEqual(Object.keys(storedRoles).sort(), started.body.room.players.map((p) => p.id).sort());
  assert.equal(Object.values(storedRoles).filter((role) => role === "HACKER").length, 1);
});


test("expired matches reject repairs, show stable results, and can replay", async () => {
  const f = await fixture();

  const started = await request(
    `/rooms/${f.code}/start`,
    "POST",
    undefined,
    f.hostToken,
  );

  assert.equal(started.status, 200);

  const roomKey = keys(f.code)[0];
  const stored = JSON.parse(await redis.get(roomKey));
  const originalMatchId = stored.challenge.matchId;

  const clock = await redis.sendCommand(["TIME"]);
  const nowMs =
    Number(clock[0]) * 1000 + Math.floor(Number(clock[1]) / 1000);

  // Move only this test room past its deadline without waiting 30 minutes.
  stored.countdownEndsAt = nowMs - 66_000;
  stored.codingStartsAt = nowMs - 61_000;
  stored.matchEndsAt = nowMs - 1000;

  await redis.set(roomKey, JSON.stringify(stored), {
    PX: 60_000,
  });

  const roles = await redis.hGetAll(keys(f.code)[3]);

  const coderToken =
    roles[stored.hostPlayerId] === "CODER"
      ? f.hostToken
      : f.guestToken;

  const { saveVerifiedRepair } = await import(
    "../src/stores/repair-store.ts"
  );

  const rejected = await saveVerifiedRepair({
    code: f.code,
    tokenHash: hashSessionToken(coderToken),
    matchId: originalMatchId,
    baseVersion: stored.challenge.codeVersion,
    source: stored.challenge.source,
    sourceHash: stored.challenge.sourceHash,
    completedObjectiveIds: stored.challenge.objectives.map(
      (objective) => objective.id,
    ),
  });

  assert.equal(rejected.outcome, "MATCH_EXPIRED");

  const first = await request(`/rooms/${f.code}`);
  const second = await request(`/rooms/${f.code}`);

  assert.equal(first.status, 200);
  assert.equal(first.body.room.phase, "RESULTS");
  assert.equal(first.body.room.results.winner, "HACKER");
  assert.equal(first.body.room.results.reason, "TIME_EXPIRED");
  assert.equal(
    first.body.room.results.finishedAt,
    stored.matchEndsAt,
  );
  assert.equal(
    first.body.room.results.expiresAt,
    stored.matchEndsAt + 60_000,
  );

  // Repeated polling must not restart the results countdown.
  assert.deepEqual(
    second.body.room.results,
    first.body.room.results,
  );

  const replay = await request(
    `/rooms/${f.code}/replay`,
    "POST",
    { matchId: originalMatchId },
    f.hostToken,
  );

  assert.equal(replay.status, 200);

  const lobby = await request(`/rooms/${f.code}`);

  assert.equal(lobby.body.room.phase, "LOBBY");
  assert.equal(lobby.body.room.codingStartsAt, undefined);
  assert.equal(lobby.body.room.matchEndsAt, undefined);
});