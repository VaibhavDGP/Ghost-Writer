import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const challengeDirectory = dirname(fileURLToPath(import.meta.url));
const temporaryDirectory = mkdtempSync(
  join(tmpdir(), "ghost-writer-billing-"),
);

function compile(sourcePath, outputPath) {
  const result = spawnSync(
    "g++",
    [
      "-std=gnu++98",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      sourcePath,
      "-o",
      outputPath,
    ],
    { encoding: "utf8" },
  );

  if (result.error) {
    throw result.error;
  }

  assert.equal(
    result.status,
    0,
    `Compilation failed:\n${result.stderr}`,
  );
}

function runCase(executablePath, testCase) {
  const result = spawnSync(
    executablePath,
    [],
    {
      input: `${testCase.input}\n`,
      encoding: "utf8",
    },
  );

  if (result.error) {
    throw result.error;
  }

  assert.equal(
    result.status,
    0,
    `${testCase.id} exited with an error:\n${result.stderr}`,
  );

  return result.stdout.trim();
}

function readCases(relativePath) {
  return JSON.parse(
    readFileSync(join(challengeDirectory, relativePath), "utf8"),
  );
}

try {
  const executableName =
    process.platform === "win32" ? "challenge.exe" : "challenge";

  const starterExecutable = join(
    temporaryDirectory,
    `starter-${executableName}`,
  );

  const referenceExecutable = join(
    temporaryDirectory,
    `reference-${executableName}`,
  );

  compile(
    join(challengeDirectory, "starter", "main.cpp"),
    starterExecutable,
  );

  compile(
    join(challengeDirectory, "reference", "main.cpp"),
    referenceExecutable,
  );

  const cases = [
    ...readCases("tests/public/cases.json"),
    ...readCases("tests/hidden/cases.json"),
  ];

  for (const testCase of cases) {
    const referenceOutput = runCase(referenceExecutable, testCase);

    assert.equal(
      referenceOutput,
      testCase.expectedOutput,
      `Reference failed case "${testCase.id}".`,
    );

    const starterOutput = runCase(starterExecutable, testCase);
    const starterPassed = starterOutput === testCase.expectedOutput;

    assert.equal(
      starterPassed,
      testCase.starterExpected === "PASS",
      `Starter had an unexpected result for "${testCase.id}".`,
    );
  }

  console.log(
    `Challenge validated: reference passed ${cases.length} cases; ` +
    "starter failures match the challenge plan.",
  );
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}