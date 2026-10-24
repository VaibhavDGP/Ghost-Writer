import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { generateProceduralChallenge } from "../src/services/procedural-generator.ts";
import { generateUniqueChallenge } from "../src/services/unique-challenge.ts";
import { applyMutation } from "../src/services/sabotage-policy.ts";

test("generates connected pipelines with the expected size", () => {
  for (const players of [2, 4, 5, 8]) {
    const challenge = generateProceduralChallenge(
      players,
      "size-check",
    );

    const objectives = players <= 4 ? 4 : 5;

    assert.equal(
      challenge.playerFacing.objectives.length,
      objectives,
    );

    assert.equal(
      challenge.serverOnly.selectedFunctionIds.length,
      objectives * 4,
    );

    assert.equal(
      (
        challenge.playerFacing.source.match(/^int /gm) ??
        []
      ).length,
      objectives * 4 + 2,
    );

    assert.ok(
      Buffer.byteLength(challenge.playerFacing.source) <
        65536,
    );

    const tests = [
      ...challenge.playerFacing.publicTests,
      ...challenge.serverOnly.hiddenTests,
    ];

    assert.ok(tests.length <= 10);

    for (const item of tests) {
      assert.ok(Buffer.byteLength(item.input) <= 8192);
      assert.ok(
        Buffer.byteLength(item.expectedOutput) <= 8192,
      );
      assert.equal(item.objectives.length, 1);
    }
  }
});

test("saved seeds reproduce code, tests and policy", () => {
  const first = generateProceduralChallenge(5, "reproduce");
  const second = generateProceduralChallenge(5, "reproduce");

  assert.notEqual(
    first.playerFacing.matchId,
    second.playerFacing.matchId,
  );

  assert.deepEqual(first.serverOnly, second.serverOnly);

  assert.deepEqual(
    { ...first.playerFacing, matchId: "" },
    { ...second.playerFacing, matchId: "" },
  );

  assert.equal(
    first.playerFacing.sourceHash,
    createHash("sha256")
      .update(first.playerFacing.source)
      .digest("hex"),
  );
});

test("different seeds vary specifications and source", () => {
  const hashes = new Set();
  const sources = new Set();

  for (let i = 0; i < 200; i++) {
    const challenge = generateProceduralChallenge(
      5,
      `variation-${i}`,
    );

    hashes.add(challenge.serverOnly.specificationHash);
    sources.add(challenge.playerFacing.sourceHash);
  }

  assert.equal(hashes.size, 200);
  assert.equal(sources.size, 200);
});

test("private verification data stays server-side", () => {
  const challenge = generateProceduralChallenge(4, "privacy");

  for (const key of [
    "seed",
    "referenceSource",
    "hiddenTests",
    "approvedMutations",
    "specificationHash",
  ]) {
    assert.equal(key in challenge.playerFacing, false);
  }

  for (const mutation of challenge.serverOnly.approvedMutations) {
    assert.notEqual(
      applyMutation(challenge.playerFacing.source, mutation),
      null,
    );

    assert.notEqual(
      applyMutation(
        challenge.serverOnly.referenceSource,
        mutation,
      ),
      null,
    );
  }
});

test("invalid generation inputs are rejected", () => {
  for (const count of [1, 9, 2.5, NaN]) {
    assert.throws(() => generateProceduralChallenge(count));
  }

  assert.throws(() => generateProceduralChallenge(2, ""));
  assert.throws(() =>
    generateProceduralChallenge(2, "x".repeat(257)),
  );
});

test("duplicate reservations retry instead of repeating", async () => {
  let attempts = 0;

  await generateUniqueChallenge(
    2,
    async () => ++attempts === 3,
  );

  assert.equal(attempts, 3);

  await assert.rejects(
    generateUniqueChallenge(2, async () => false),
    /reserve/,
  );
});