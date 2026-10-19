import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

const BASE_URL = "http://localhost:3001";

const hostToken = randomBytes(32).toString("hex");
const guestToken = randomBytes(32).toString("hex");

async function request(
  path,
  { method = "GET", token, body } = {},
) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
      ...(token
        ? { Authorization: `Bearer ${token}` }
        : {}),
    },
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body) }),
  });

  return {
    status: response.status,
    data: await response.json(),
  };
}

function expectStatus(response, status) {
  assert.equal(
    response.status,
    status,
    JSON.stringify(response.data),
  );
}

async function main() {
  let code;

  try {
    const created = await request("/rooms", {
      method: "POST",
      body: {
        displayName: "Judge test host",
        sessionToken: hostToken,
      },
    });

    expectStatus(created, 201);
    code = created.data.room.code;

    const joined = await request(`/rooms/${code}/join`, {
      method: "POST",
      body: {
        displayName: "Judge test guest",
        sessionToken: guestToken,
        requestId: randomUUID(),
      },
    });

    expectStatus(joined, 200);

    const ready = await request(`/rooms/${code}/ready`, {
      method: "PATCH",
      token: guestToken,
      body: { isReady: true },
    });

    expectStatus(ready, 200);

    const beforeStart = await request(`/rooms/${code}/run`, {
      method: "POST",
      token: hostToken,
      body: {
        source: "int main() { return 0; }",
        matchId: randomUUID(),
      },
    });

    expectStatus(beforeStart, 409);
    console.log("PASS: running in the lobby is rejected.");

    const started = await request(`/rooms/${code}/start`, {
      method: "POST",
      token: hostToken,
    });

    expectStatus(started, 200);

    const room = started.data.room;
    const challenge = room.challenge;

    assert.ok(challenge);

    const body = {
      source: challenge.source,
      matchId: challenge.matchId,
    };

    const unauthenticated = await request(
      `/rooms/${code}/run`,
      {
        method: "POST",
        body,
      },
    );

    expectStatus(unauthenticated, 401);
    console.log("PASS: missing authentication is rejected.");

    const wrongMatch = await request(`/rooms/${code}/run`, {
      method: "POST",
      token: hostToken,
      body: {
        ...body,
        matchId: randomUUID(),
      },
    });

    expectStatus(wrongMatch, 409);
    console.log("PASS: a different match ID is rejected.");

    const customTests = await request(`/rooms/${code}/run`, {
      method: "POST",
      token: hostToken,
      body: {
        ...body,
        tests: [],
      },
    });

    expectStatus(customTests, 400);
    console.log("PASS: client-supplied tests are rejected.");

    const waitMs = Math.max(
      0,
      room.countdownEndsAt - Date.now() + 1000,
    );

    console.log("Waiting for the start countdown...");
    await new Promise((resolve) => setTimeout(resolve, waitMs));

    const preview = await request(`/rooms/${code}/run`, {
      method: "POST",
      token: hostToken,
      body,
    });

    expectStatus(preview, 200);
    assert.equal(preview.data.matchId, challenge.matchId);
    assert.equal(preview.data.result.status, "COMPLETED");
    assert.equal(
      preview.data.result.total,
      challenge.publicTests.length,
    );

    console.log("PASS: the backend returned public-test results.");
    console.log(
      JSON.stringify(preview.data.result, null, 2),
    );

    const fetched = await request(`/rooms/${code}`);

    expectStatus(fetched, 200);
    assert.deepEqual(
      fetched.data.room.challenge,
      challenge,
    );

    console.log("PASS: the official challenge was not changed.");
    console.log("\nAll API smoke checks passed.");
  } finally {
    if (code) {
      const cleanup = await request(
        `/rooms/${code}/players/me`,
        {
          method: "DELETE",
          token: hostToken,
        },
      );

      if (cleanup.status !== 200 && cleanup.status !== 404) {
        console.error("Test-room cleanup failed:", cleanup.data);
      }
    }
  }
}

main().catch((error) => {
  console.error("\nAPI smoke check failed:");
  console.error(error);
  process.exitCode = 1;
});