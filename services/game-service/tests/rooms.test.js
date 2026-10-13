import test from "node:test";
import assert from "node:assert/strict";

const BASE_URL = "http://localhost:3001";

async function request(path, { method = "GET", body } = {}) {
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