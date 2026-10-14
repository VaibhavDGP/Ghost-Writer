import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

const BASE_URL = "http://localhost:3001";

async function request(path, { method = "GET", body } = {}) {
  if (
    method === "POST" &&
    (path === "/rooms" || path.endsWith("/join")) &&
    body !== undefined
  ) {
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
  sessionToken: randomBytes(32).toString("hex"),
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
  sessionToken: randomBytes(32).toString("hex"),
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
  const sessionToken = randomBytes(32).toString("hex");

  const first = await request(`/rooms/${room.code}/join`, {
    method: "POST",
    body: {
      displayName: "Original Guest",
      requestId,
      sessionToken,
    },
  });

  assert.equal(first.status, 200);

  const conflicting = await request(`/rooms/${room.code}/join`, {
    method: "POST",
    body: {
      displayName: "Different Guest",
      requestId,
      sessionToken,
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

test("identifies a guest and restricts their token to their room", async () => {
  const room = await createTestRoom();
  const sessionToken = randomBytes(32).toString("hex");

  const joined = await request(`/rooms/${room.code}/join`, {
    method: "POST",
    body: {
      displayName: "Session Guest",
      sessionToken,
    },
  });

  assert.equal(joined.status, 200);

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

  assert.equal(identity.player.id, joined.data.playerId);
  assert.equal(identity.player.displayName, "Session Guest");
  assert.equal(identity.roomId, room.id);
  assert.equal(identity.isHost, false);

  const publicRoom = await request(`/rooms/${room.code}`);

  assert.equal(publicRoom.status, 200);
  assert.equal(
    JSON.stringify(publicRoom.data).includes(sessionToken),
    false,
  );
  assert.equal(
    JSON.stringify(joined.data).includes(sessionToken),
    false,
  );

  const otherRoom = await createTestRoom();

  const otherRoomResponse = await fetch(
    `${BASE_URL}/rooms/${otherRoom.code}/me`,
    {
      headers: {
        Authorization: `Bearer ${sessionToken}`,
      },
    },
  );

  assert.equal(otherRoomResponse.status, 401);
});

test("rejects retrying someone else's join with a different token", async () => {
  const room = await createTestRoom();
  const requestId = randomUUID();
  const originalToken = randomBytes(32).toString("hex");
  const otherToken = randomBytes(32).toString("hex");

  const first = await request(`/rooms/${room.code}/join`, {
    method: "POST",
    body: {
      displayName: "Original Guest",
      requestId,
      sessionToken: originalToken,
    },
  });

  assert.equal(first.status, 200);

  const takeover = await request(`/rooms/${room.code}/join`, {
    method: "POST",
    body: {
      displayName: "Original Guest",
      requestId,
      sessionToken: otherToken,
    },
  });

  assert.equal(takeover.status, 409);

  const unauthorized = await fetch(
    `${BASE_URL}/rooms/${room.code}/me`,
    {
      headers: {
        Authorization: `Bearer ${otherToken}`,
      },
    },
  );

  assert.equal(unauthorized.status, 401);

  const originalSession = await fetch(
    `${BASE_URL}/rooms/${room.code}/me`,
    {
      headers: {
        Authorization: `Bearer ${originalToken}`,
      },
    },
  );

  assert.equal(originalSession.status, 200);

  const identity = await originalSession.json();
  assert.equal(identity.player.id, first.data.playerId);

  const fetched = await request(`/rooms/${room.code}`);

  assert.equal(fetched.status, 200);
  assert.equal(fetched.data.room.players.length, 2);
});

test("rejects using one session for another player in the same room", async () => {
  const room = await createTestRoom();
  const sessionToken = randomBytes(32).toString("hex");

  const first = await request(`/rooms/${room.code}/join`, {
    method: "POST",
    body: {
      displayName: "First Guest",
      requestId: randomUUID(),
      sessionToken,
    },
  });

  assert.equal(first.status, 200);

  const second = await request(`/rooms/${room.code}/join`, {
    method: "POST",
    body: {
      displayName: "Second Guest",
      requestId: randomUUID(),
      sessionToken,
    },
  });

  assert.equal(second.status, 409);
  assert.equal(
    second.data.error,
    "This session already belongs to a player in this room.",
  );

  const fetched = await request(`/rooms/${room.code}`);

  assert.equal(fetched.status, 200);
  assert.equal(fetched.data.room.players.length, 2);
});

test("rejects joining without a valid session token", async () => {
  const room = await createTestRoom();

  // Use fetch directly so the helper cannot supply a token.
  for (const sessionToken of [undefined, "", "invalid", 123]) {
    const response = await fetch(
      `${BASE_URL}/rooms/${room.code}/join`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          displayName: "Invalid Session Guest",
          requestId: randomUUID(),
          sessionToken,
        }),
      },
    );

    assert.equal(response.status, 400);
  }

  const fetched = await request(`/rooms/${room.code}`);

  assert.equal(fetched.status, 200);
  assert.equal(fetched.data.room.players.length, 1);
});

async function createReadinessFixture() {
  const hostToken = randomBytes(32).toString("hex");

  const created = await request("/rooms", {
    method: "POST",
    body: {
      displayName: "Readiness Host",
      sessionToken: hostToken,
    },
  });

  assert.equal(created.status, 201);

  const room = created.data.room;
  const guests = [];

  for (const displayName of ["Guest One", "Guest Two"]) {
    const token = randomBytes(32).toString("hex");

    const joined = await request(`/rooms/${room.code}/join`, {
      method: "POST",
      body: {
        displayName,
        sessionToken: token,
      },
    });

    assert.equal(joined.status, 200);

    guests.push({
      token,
      playerId: joined.data.playerId,
    });
  }

  return { room, hostToken, guests };
}

async function updateReadiness(code, token, body) {
  const headers = {
    "Content-Type": "application/json",
  };

  if (token !== undefined) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(
    `${BASE_URL}/rooms/${code}/ready`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    },
  );

  return {
    status: response.status,
    data: await response.json(),
  };
}

test("a guest updates only their own readiness and can become unready",
  async () => {
    const { room, guests } = await createReadinessFixture();
    const [firstGuest, secondGuest] = guests;

    const before = await request(`/rooms/${room.code}`);
    assert.equal(before.status, 200);

    // Supplying another player's ID must not change who is updated.
    const ready = await updateReadiness(
      room.code,
      firstGuest.token,
      {
        isReady: true,
        playerId: secondGuest.playerId,
      },
    );

    assert.equal(ready.status, 200);
    assert.equal(ready.data.playerId, firstGuest.playerId);

    const fetched = await request(`/rooms/${room.code}`);
    assert.equal(fetched.status, 200);

    const firstPlayer = fetched.data.room.players.find(
      (player) => player.id === firstGuest.playerId,
    );

    assert.ok(firstPlayer);
    assert.equal(firstPlayer.isReady, true);

    for (const player of fetched.data.room.players) {
      if (player.id !== firstGuest.playerId) {
        const original = before.data.room.players.find(
          (entry) => entry.id === player.id,
        );

        assert.deepEqual(player, original);
      }
    }

    // Sending true twice should remain ready rather than toggle.
    const repeated = await updateReadiness(
      room.code,
      firstGuest.token,
      { isReady: true },
    );

    assert.equal(repeated.status, 200);

    const repeatedPlayer = repeated.data.room.players.find(
      (player) => player.id === firstGuest.playerId,
    );

    assert.equal(repeatedPlayer.isReady, true);

    const unready = await updateReadiness(
      room.code,
      firstGuest.token,
      { isReady: false },
    );

    assert.equal(unready.status, 200);

    const finalRoom = await request(`/rooms/${room.code}`);
    assert.equal(finalRoom.status, 200);

    const finalPlayer = finalRoom.data.room.players.find(
      (player) => player.id === firstGuest.playerId,
    );

    assert.equal(finalPlayer.isReady, false);
    assert.equal(finalRoom.data.room.hostPlayerId, room.hostPlayerId);
    assert.equal(finalRoom.data.room.phase, "LOBBY");
  },
);

test("rejects the host attempting to mark ready", async () => {
  const { room, hostToken } = await createReadinessFixture();

  const before = await request(`/rooms/${room.code}`);
  assert.equal(before.status, 200);

  const result = await updateReadiness(
    room.code,
    hostToken,
    { isReady: true },
  );

  assert.equal(result.status, 403);

  const after = await request(`/rooms/${room.code}`);
  assert.equal(after.status, 200);
  assert.deepEqual(after.data.room, before.data.room);
});

test("rejects readiness changes without a session belonging to the room",
  async () => {
    const { room } = await createReadinessFixture();

    const otherRoomToken = randomBytes(32).toString("hex");

    const otherRoom = await request("/rooms", {
      method: "POST",
      body: {
        displayName: "Other Host",
        sessionToken: otherRoomToken,
      },
    });

    assert.equal(otherRoom.status, 201);

    const before = await request(`/rooms/${room.code}`);
    assert.equal(before.status, 200);

    const invalidTokens = [
      undefined,
      "invalid",
      randomBytes(32).toString("hex"),
      otherRoomToken,
    ];

    for (const token of invalidTokens) {
      const result = await updateReadiness(
        room.code,
        token,
        { isReady: true },
      );

      assert.equal(result.status, 401);
    }

    const after = await request(`/rooms/${room.code}`);
    assert.equal(after.status, 200);
    assert.deepEqual(after.data.room, before.data.room);
  },
);

test("rejects invalid readiness values and malformed room codes",
  async () => {
    const { room, guests } = await createReadinessFixture();
    const token = guests[0].token;

    const before = await request(`/rooms/${room.code}`);
    assert.equal(before.status, 200);

    for (const isReady of [undefined, null, "true", 1, {}]) {
      const result = await updateReadiness(
        room.code,
        token,
        { isReady },
      );

      assert.equal(result.status, 400);
    }

    const invalidCode = await updateReadiness(
      "XYZ",
      token,
      { isReady: true },
    );

    assert.equal(invalidCode.status, 400);

    const after = await request(`/rooms/${room.code}`);
    assert.equal(after.status, 200);
    assert.deepEqual(after.data.room, before.data.room);
  },
);

async function startGameRequest(code, token, body = {}) {
  const headers = {
    "Content-Type": "application/json",
  };

  if (token !== undefined) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(
    `${BASE_URL}/rooms/${code}/start`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
  );

  return {
    status: response.status,
    data: await response.json(),
  };
}

async function readyAllGuests(fixture) {
  for (const guest of fixture.guests) {
    const result = await updateReadiness(
      fixture.room.code,
      guest.token,
      { isReady: true },
    );

    assert.equal(result.status, 200);
  }
}

test("the host starts a room when every guest is ready", async () => {
  const fixture = await createReadinessFixture();

  await readyAllGuests(fixture);

  const started = await startGameRequest(
    fixture.room.code,
    fixture.hostToken,
  );

  assert.equal(started.status, 200);
  assert.equal(started.data.room.phase, "IN_PROGRESS");
  assert.equal(started.data.room.id, fixture.room.id);
  assert.equal(
    started.data.room.hostPlayerId,
    fixture.room.hostPlayerId,
  );

  const fetched = await request(`/rooms/${fixture.room.code}`);

  assert.equal(fetched.status, 200);
  assert.deepEqual(fetched.data.room, started.data.room);
});

test("rejects start requests without the host's session", async () => {
  const fixture = await createReadinessFixture();

  await readyAllGuests(fixture);

  const otherHostToken = randomBytes(32).toString("hex");

  const otherRoom = await request("/rooms", {
    method: "POST",
    body: {
      displayName: "Other Host",
      sessionToken: otherHostToken,
    },
  });

  assert.equal(otherRoom.status, 201);

  for (const token of [
    undefined,
    "invalid",
    randomBytes(32).toString("hex"),
    otherHostToken,
  ]) {
    const result = await startGameRequest(
      fixture.room.code,
      token,
    );

    assert.equal(result.status, 401);
  }

  // A guest cannot become the host by supplying the host's ID.
  const guestAttempt = await startGameRequest(
    fixture.room.code,
    fixture.guests[0].token,
    { playerId: fixture.room.hostPlayerId },
  );

  assert.equal(guestAttempt.status, 403);

  const fetched = await request(`/rooms/${fixture.room.code}`);

  assert.equal(fetched.status, 200);
  assert.equal(fetched.data.room.phase, "LOBBY");
});

test("rejects starting a room containing only the host", async () => {
  const hostToken = randomBytes(32).toString("hex");

  const created = await request("/rooms", {
    method: "POST",
    body: {
      displayName: "Solo Host",
      sessionToken: hostToken,
    },
  });

  assert.equal(created.status, 201);

  const result = await startGameRequest(
    created.data.room.code,
    hostToken,
  );

  assert.equal(result.status, 409);
  assert.equal(
    result.data.error,
    "At least two players are required to start.",
  );
});

test("rejects starting while any guest is not ready", async () => {
  const fixture = await createReadinessFixture();

  // Missing isReady is treated as not ready.
  const initial = await startGameRequest(
    fixture.room.code,
    fixture.hostToken,
  );

  assert.equal(initial.status, 409);
  assert.equal(
    initial.data.error,
    "Every guest must be ready before starting.",
  );

  const firstReady = await updateReadiness(
    fixture.room.code,
    fixture.guests[0].token,
    { isReady: true },
  );

  assert.equal(firstReady.status, 200);

  const onlyOneReady = await startGameRequest(
    fixture.room.code,
    fixture.hostToken,
  );

  assert.equal(onlyOneReady.status, 409);

  await readyAllGuests(fixture);

  const becameUnready = await updateReadiness(
    fixture.room.code,
    fixture.guests[1].token,
    { isReady: false },
  );

  assert.equal(becameUnready.status, 200);

  const finalAttempt = await startGameRequest(
    fixture.room.code,
    fixture.hostToken,
  );

  assert.equal(finalAttempt.status, 409);

  const fetched = await request(`/rooms/${fixture.room.code}`);

  assert.equal(fetched.status, 200);
  assert.equal(fetched.data.room.phase, "LOBBY");
});

test("simultaneous start requests safely return the same started room",
  async () => {
    const fixture = await createReadinessFixture();

    await readyAllGuests(fixture);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        startGameRequest(
          fixture.room.code,
          fixture.hostToken,
        ),
      ),
    );

    for (const result of results) {
      assert.equal(result.status, 200);
      assert.equal(result.data.room.phase, "IN_PROGRESS");
      assert.deepEqual(result.data.room, results[0].data.room);
    }

    const fetched = await request(`/rooms/${fixture.room.code}`);

    assert.equal(fetched.status, 200);
    assert.deepEqual(fetched.data.room, results[0].data.room);
  },
);

test("blocks joining and readiness changes after the game starts",
  async () => {
    const fixture = await createReadinessFixture();

    await readyAllGuests(fixture);

    const started = await startGameRequest(
      fixture.room.code,
      fixture.hostToken,
    );

    assert.equal(started.status, 200);

    const lateJoin = await request(
      `/rooms/${fixture.room.code}/join`,
      {
        method: "POST",
        body: {
          displayName: "Late Guest",
        },
      },
    );

    assert.equal(lateJoin.status, 409);

    const readinessChange = await updateReadiness(
      fixture.room.code,
      fixture.guests[0].token,
      { isReady: false },
    );

    assert.equal(readinessChange.status, 409);

    const fetched = await request(`/rooms/${fixture.room.code}`);

    assert.equal(fetched.status, 200);
    assert.deepEqual(fetched.data.room, started.data.room);
  },
);

test("a simultaneous unready request and start leave a consistent room",
  async () => {
    const fixture = await createReadinessFixture();

    await readyAllGuests(fixture);

    const [startResult, unreadyResult] = await Promise.all([
      startGameRequest(
        fixture.room.code,
        fixture.hostToken,
      ),
      updateReadiness(
        fixture.room.code,
        fixture.guests[0].token,
        { isReady: false },
      ),
    ]);

    const fetched = await request(`/rooms/${fixture.room.code}`);

    assert.equal(fetched.status, 200);

    const room = fetched.data.room;
    const guest = room.players.find(
      (player) => player.id === fixture.guests[0].playerId,
    );

    assert.ok(guest);

    if (startResult.status === 200) {
      // Start happened first, so readiness changes were blocked.
      assert.equal(unreadyResult.status, 409);
      assert.equal(room.phase, "IN_PROGRESS");
      assert.equal(guest.isReady, true);
    } else {
      // Unready happened first, so starting was blocked.
      assert.equal(startResult.status, 409);
      assert.equal(unreadyResult.status, 200);
      assert.equal(room.phase, "LOBBY");
      assert.equal(guest.isReady, false);
    }
  },
);