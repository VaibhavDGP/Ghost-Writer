import assert from "node:assert/strict";
import { judgePublicDraft } from "./judge.mjs";

const tests = [
  {
    id: "positive-numbers",
    input: "2 3",
    expectedOutput: "5",
  },
  {
    id: "negative-number",
    input: "-4 9",
    expectedOutput: "5",
  },
];

const correctSource = `
#include <iostream>

int main() {
    int a, b;
    if (!(std::cin >> a >> b)) return 1;
    std::cout << a + b << '\\n';
    return 0;
}
`;

async function main() {
  console.log("1. Checking a correct program...");
  const correct = await judgePublicDraft({
    source: correctSource,
    tests,
  });

  assert.equal(correct.status, "COMPLETED");
  assert.equal(correct.passed, 2);
  console.log("PASS: both public tests passed.");

  console.log("\n2. Checking a wrong answer...");
  const wrong = await judgePublicDraft({
    source: correctSource.replace("a + b", "a - b"),
    tests,
  });

  assert.equal(wrong.status, "COMPLETED");
  assert.equal(wrong.passed, 0);
  assert.ok(
    wrong.tests.every((result) => result.status === "WRONG_ANSWER"),
  );
  console.log("PASS: incorrect answers were detected.");

  console.log("\n3. Checking a compilation error...");
  const broken = await judgePublicDraft({
    source: "int main( {",
    tests: [tests[0]],
  });

  assert.equal(broken.status, "COMPILE_ERROR");
  console.log("PASS: compilation error was reported.");

  console.log("\n4. Checking an infinite loop...");
  const infinite = await judgePublicDraft({
    source: "int main() { while (true) {} }",
    tests: [tests[0]],
  });

  assert.equal(infinite.status, "COMPLETED");
  assert.equal(
    infinite.tests[0].status,
    "TIME_OR_RESOURCE_LIMIT",
  );
  console.log("PASS: infinite loop was stopped.");

  console.log("\n5. Checking excessive output...");
  const noisy = await judgePublicDraft({
    source: `
#include <iostream>

int main() {
    while (true) {
        std::cout << "too much output\\n";
    }
}
`,
    tests: [tests[0]],
  });

  assert.equal(noisy.status, "COMPLETED");
  assert.equal(noisy.tests[0].status, "OUTPUT_LIMIT");
  console.log("PASS: excessive output was stopped.");

  console.log("\nAll five judge smoke checks passed.");
}

main().catch((error) => {
  console.error("\nJudge check failed:");
  console.error(error);
  process.exitCode = 1;
});