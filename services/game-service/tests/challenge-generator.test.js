import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { generateChallenge } from "../src/services/challenge-generator.ts";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const templateDirectory = resolve(
  currentDirectory,
  "../../../challenges/templates/numeric-001",
);

const functionsById = {
  "clamp-value": { name: "clampValue", operation: "clamp" },
  "sum-digits": { name: "sumDigits", operation: "sum" },
  "count-digits": { name: "countDigits", operation: "count" },
};

test("generates a two-function challenge for 2–4 players", async () => {
  for (const playerCount of [2, 3, 4]) {
    const result = await generateChallenge(templateDirectory, playerCount);
    const selectedIds = result.serverOnly.selectedFunctionIds;

    assert.equal(selectedIds.length, 2);
    assert.equal(result.playerFacing.objectives.length, 2);

    for (const id of selectedIds) {
      assert.ok(result.playerFacing.source.includes(functionsById[id].name));
      assert.ok(
        result.playerFacing.source.includes(
          `operation == "${functionsById[id].operation}"`,
        ),
      );
    }

    for (const testCase of [
      ...result.playerFacing.publicTests,
      ...result.serverOnly.hiddenTests,
    ]) {
      for (const objectiveId of testCase.objectives) {
        assert.ok(
          result.playerFacing.objectives.some(
            (objective) => objective.id === objectiveId,
          ),
        );
      }
    }
  }
});

test("generates all three functions for 5–8 players", async () => {
  for (const playerCount of [5, 6, 7, 8]) {
    const result = await generateChallenge(templateDirectory, playerCount);

    assert.equal(result.serverOnly.selectedFunctionIds.length, 3);
    assert.equal(result.playerFacing.objectives.length, 3);
    assert.ok(result.playerFacing.source.includes("clampValue"));
    assert.ok(result.playerFacing.source.includes("sumDigits"));
    assert.ok(result.playerFacing.source.includes("countDigits"));
  }
});

test("keeps reference code and hidden tests out of player-facing data", async () => {
  const result = await generateChallenge(templateDirectory, 5);

  assert.equal("referenceSource" in result.playerFacing, false);
  assert.equal("hiddenTests" in result.playerFacing, false);
  assert.equal("seed" in result.playerFacing, false);

  assert.equal("referenceSource" in result.serverOnly, true);
  assert.equal("hiddenTests" in result.serverOnly, true);

  for (const testCase of result.playerFacing.publicTests) {
    assert.equal("starterExpected" in testCase, false);
  }
});

test("provides a matching SHA-256 hash for the generated starter code", async () => {
  const result = await generateChallenge(templateDirectory, 5);
  const expectedHash = createHash("sha256")
    .update(result.playerFacing.source)
    .digest("hex");

  assert.equal(result.playerFacing.sourceHash, expectedHash);
});

test("creates a different match ID for each generated challenge", async () => {
  const first = await generateChallenge(templateDirectory, 5);
  const second = await generateChallenge(templateDirectory, 5);

  assert.notEqual(first.playerFacing.matchId, second.playerFacing.matchId);
});

test("rejects player counts without a generation rule", async () => {
  await assert.rejects(
    generateChallenge(templateDirectory, 1),
    /No generation rule for 1 players/,
  );

  await assert.rejects(
    generateChallenge(templateDirectory, 9),
    /No generation rule for 9 players/,
  );
});