import assert from "node:assert/strict";
import { generateProceduralChallenge } from "../src/services/procedural-generator.ts";
import {
  applyMutation,
  hasBoundedDamage,
} from "../src/services/sabotage-policy.ts";
import { judgePublicDraft } from "../../../workers/code-judge/judge.mjs";

const seeds = process.argv.slice(2);

if (seeds.length === 0) {
  seeds.push("validation-a");
}

function functionText(source, name) {
  const start = source.indexOf(`int ${name}(`);
  assert.ok(start >= 0);

  const open = source.indexOf("{", start);
  let depth = 1;
  let end = open + 1;

  while (depth > 0 && end < source.length) {
    if (source[end] === "{") depth++;
    if (source[end] === "}") depth--;
    end++;
  }

  assert.equal(depth, 0);
  return source.slice(start, end);
}

for (const seed of seeds) {
  for (const players of [2, 5]) {
    const challenge = generateProceduralChallenge(
      players,
      seed,
    );

    const cases = [
      ...challenge.playerFacing.publicTests,
      ...challenge.serverOnly.hiddenTests,
    ];

    const tests = cases.map(
      ({ id, input, expectedOutput }) => ({
        id,
        input,
        expectedOutput,
      }),
    );

    const check = (source) =>
      judgePublicDraft({ source, tests });

    console.log(
      `Checking seed ${seed}, ${players} players...`,
    );

    const reference = await check(
      challenge.serverOnly.referenceSource,
    );

    assert.equal(reference.status, "COMPLETED");
    assert.equal(
      reference.passed,
      tests.length,
      "Reference must pass every test.",
    );

    const starter = await check(
      challenge.playerFacing.source,
    );

    assert.equal(
      starter.status,
      "COMPLETED",
      "Starter must compile.",
    );

    assert.ok(
      starter.tests.every((item) =>
        ["PASSED", "WRONG_ANSWER"].includes(item.status),
      ),
    );

    for (const objective of challenge.playerFacing.objectives) {
      assert.ok(
        cases.some(
          (item, index) =>
            item.objectives.includes(objective.id) &&
            starter.tests[index].status === "WRONG_ANSWER",
        ),
        `${objective.id} must begin incomplete.`,
      );
    }

    let repairedSource = challenge.playerFacing.source;
    let previous = starter;

    for (const objective of challenge.playerFacing.objectives) {
      const operation = objective.id.replace(/-rules$/, "");

      for (let step = 1; step <= 3; step++) {
        const name = `${operation}Step${step}`;

        repairedSource = repairedSource.replace(
          functionText(repairedSource, name),
          functionText(
            challenge.serverOnly.referenceSource,
            name,
          ),
        );
      }

      const next = await check(repairedSource);

      assert.equal(next.status, "COMPLETED");
      assert.ok(
        next.passed > previous.passed,
        "Each repair must make progress.",
      );

      previous.tests.forEach((item, index) => {
        if (item.status === "PASSED") {
          assert.equal(
            next.tests[index].status,
            "PASSED",
            "A repair must not regress passing tests.",
          );
        }
      });

      previous = next;
    }

    assert.equal(
      previous.passed,
      tests.length,
      "All objectives must be repairable.",
    );

    for (const mutation of challenge.serverOnly.approvedMutations) {
      const baselines = [
        [challenge.playerFacing.source, starter],
        [challenge.serverOnly.referenceSource, reference],
      ];

      for (const [source, before] of baselines) {
        const altered = applyMutation(source, mutation);
        assert.notEqual(altered, null);

        const after = await check(altered);
        assert.equal(after.status, "COMPLETED");

        assert.ok(
          hasBoundedDamage(
            cases,
            before.tests,
            after.tests,
            mutation.objectiveId,
          ),
          `${mutation.id} must damage only its objective.`,
        );
      }
    }

    console.log(
      `Passed: ${seed}, ${players} players.`,
    );
  }
}

console.log("Generated C++ validation passed.");