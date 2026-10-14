import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

const BASE_URL = "http://localhost:3001";

async function request(path, { method = "GET", body } = {}) {
  if (method === "POST" && path === "/rooms" && body !== undefined) {
  body = {
    sessionToken: randomBytes(32).toString("hex"),
    ...body,
  };
}
  
  if (
  method === "POST" &&
  path.endsWith("/join") &&
  body !== undefined
) {
  body = {
    requestId: randomUUID(),
    ...body,
  };
}
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body === undefined
      ? {}
      : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const data = await response.json();

  return {
    status: response.status,
    data,
  };
}

async function createTestRoom() {
  const response = await request("/rooms", {
    method: "POST",
    body: { displayName: "Test Host" },
  });

  assert.equal(response.status, 201);

  return response.data.room;
}

test("creates a room and retrieves the same room", async () => {
  const room = await createTestRoom();

  assert.match(room.code, /^[0-9A-F]{6}$/);
  assert.equal(room.phase, "LOBBY");
  assert.equal(room.players.length, 1);
  assert.equal(room.players[0].displayName, "Test Host");
  assert.equal(room.hostPlayerId, room.players[0].id);

  const fetched = await request(`/rooms/${room.code}`);

  assert.equal(fetched.status, 200);
  assert.deepEqual(fetched.data.room, room);
});

test("rejects invalid player names", async () => {
  const invalidNames = ["", "   ", 123, "A".repeat(41)];

  for (const displayName of invalidNames) {
    const response = await request("/rooms", {
      method: "POST",
      body: { displayName },
    });

    assert.equal(response.status, 400);
  }

  const missingName = await request("/rooms", {
    method: "POST",
    body: {},
  });

  assert.equal(missingName.status, 400);
});

test("rejects an invalid room-code format", async () => {
  const fetched = await request("/rooms/XYZ");
  assert.equal(fetched.status, 400);

  const joined = await request("/rooms/XYZ/join", {
    method: "POST",
    body: { displayName: "Guest" },
  });

  assert.equal(joined.status, 400);
});

test("adds a player and preserves the host", async () => {
  const room = await createTestRoom();

  const joined = await request(
    `/rooms/${room.code.toLowerCase()}/join`,
    {
      method: "POST",
      body: { displayName: "  Test Guest  " },
    },
  );

  assert.equal(joined.status, 200);
  assert.equal(joined.data.room.id, room.id);
  assert.equal(joined.data.room.hostPlayerId, room.hostPlayerId);
  assert.equal(joined.data.room.players.length, 2);
  assert.equal(
    joined.data.room.players[1].displayName,
    "Test Guest",
  );

  const fetched = await request(`/rooms/${room.code}`);

  assert.equal(fetched.status, 200);
  assert.deepEqual(fetched.data.room, joined.data.room);
});

test("simultaneous joins respect capacity and retain every accepted player",
  async () => {
    const room = await createTestRoom();
    const availablePlaces = room.maxPlayers - room.players.length;
    const requestCount = availablePlaces + 5;

    const results = await Promise.all(
      Array.from({ length: requestCount }, (_, index) =>
        request(`/rooms/${room.code}/join`, {
          method: "POST",
          body: { displayName: `Concurrent Guest ${index}` },
        }),
      ),
    );

    const accepted = results.filter((result) => result.status === 200);
    const rejected = results.filter((result) => result.status === 409);

    assert.equal(accepted.length, availablePlaces);
    assert.equal(rejected.length, 5);

    for (const result of rejected) {
      assert.equal(result.data.error, "Room is full.");
    }

    const fetched = await request(`/rooms/${room.code}`);

    assert.equal(fetched.status, 200);

    const finalRoom = fetched.data.room;

    assert.equal(finalRoom.players.length, room.maxPlayers);
    assert.equal(finalRoom.hostPlayerId, room.hostPlayerId);

    const playerIds = finalRoom.players.map((player) => player.id);
    assert.equal(new Set(playerIds).size, room.maxPlayers);

    for (let index = 0; index < results.length; index++) {
      if (results[index].status === 200) {
        assert.ok(
          finalRoom.players.some(
            (player) => player.displayName === `Concurrent Guest ${index}`,
          ),
        );
      }
    }
  },
);

test("retrying a join returns the same player without adding another",
  async () => {
    const room = await createTestRoom();

    const body = {
      displayName: "Retry Guest",
      requestId: randomUUID(),
    };

    const first = await request(`/rooms/${room.code}/join`, {
      method: "POST",
      body,
    });

    const retry = await request(`/rooms/${room.code}/join`, {
      method: "POST",
      body,
    });

    assert.equal(first.status, 200);
    assert.equal(retry.status, 200);
    assert.equal(typeof first.data.playerId, "string");
    assert.equal(retry.data.playerId, first.data.playerId);

    const fetched = await request(`/rooms/${room.code}`);

    assert.equal(fetched.status, 200);
    assert.equal(fetched.data.room.players.length, 2);
    assert.ok(
      fetched.data.room.players.some(
        (player) => player.id === first.data.playerId,
      ),
    );
  },
);

test("simultaneous retries create only one player", async () => {
  const room = await createTestRoom();

  const body = {
    displayName: "Concurrent Retry Guest",
    requestId: randomUUID(),
  };

  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      request(`/rooms/${room.code}/join`, {
        method: "POST",
        body,
      }),
    ),
  );

  for (const result of results) {
    assert.equal(result.status, 200);
    assert.equal(typeof result.data.playerId, "string");
  }

  const returnedIds = results.map((result) => result.data.playerId);

  assert.equal(new Set(returnedIds).size, 1);

  const fetched = await request(`/rooms/${room.code}`);

  assert.equal(fetched.status, 200);
  assert.equal(fetched.data.room.players.length, 2);
});

test("rejects reusing a request ID with a different name", async () => {
  const room = await createTestRoom();
  const requestId = randomUUID();

  const first = await request(`/rooms/${room.code}/join`, {
    method: "POST",
    body: {
      displayName: "Original Guest",
      requestId,
    },
  });

  assert.equal(first.status, 200);

  const conflicting = await request(`/rooms/${room.code}/join`, {
    method: "POST",
    body: {
      displayName: "Different Guest",
      requestId,
    },
  });

  assert.equal(conflicting.status, 409);

  const fetched = await request(`/rooms/${room.code}`);

  assert.equal(fetched.status, 200);
  assert.equal(fetched.data.room.players.length, 2);
  assert.equal(
    fetched.data.room.players[1].displayName,
    "Original Guest",
  );
});

test("identifies the host using their private session token", async () => {
  const sessionToken = randomBytes(32).toString("hex");

  const created = await request("/rooms", {
    method: "POST",
    body: {
      displayName: "Session Host",
      sessionToken,
    },
  });

  assert.equal(created.status, 201);

  const room = created.data.room;

  const response = await fetch(
    `${BASE_URL}/rooms/${room.code}/me`,
    {
      headers: {
        Authorization: `Bearer ${sessionToken}`,
      },
    },
  );

  assert.equal(response.status, 200);

  const identity = await response.json();

  assert.equal(identity.roomId, room.id);
  assert.equal(identity.player.id, room.hostPlayerId);
  assert.equal(identity.isHost, true);

  const publicRoom = await request(`/rooms/${room.code}`);

  assert.equal(publicRoom.status, 200);
  assert.deepEqual(publicRoom.data.room, room);
  assert.equal(JSON.stringify(created.data).includes(sessionToken), false);
  assert.equal(JSON.stringify(publicRoom.data).includes(sessionToken), false);
});

test("rejects missing and incorrect session tokens", async () => {
  const room = await createTestRoom();

  const missing = await request(`/rooms/${room.code}/me`);

  assert.equal(missing.status, 401);

  const incorrect = await fetch(
    `${BASE_URL}/rooms/${room.code}/me`,
    {
      headers: {
        Authorization: `Bearer ${randomBytes(32).toString("hex")}`,
      },
    },
  );

  assert.equal(incorrect.status, 401);
});