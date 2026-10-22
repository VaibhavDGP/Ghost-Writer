import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

interface ManifestFunction {
  id: string;
  name: string;
  description: string;
  starterFile: string;
  referenceFile: string;
}

interface Objective {
  id: string;
  description: string;
  functionIds: string[];
  required: boolean;
}

interface TestCase {
  id: string;
  input: string;
  expectedOutput: string;
  objectives: string[];
  starterExpected?: "PASS" | "FAIL";
}

interface ChallengeManifest {
  id: string;
  functions: ManifestFunction[];
  objectives: Objective[];
  tests: {
    publicFile: string;
    hiddenFile: string;
  };
}

interface GenerationConfig {
  functionCountByPlayerCount: Array<{
    minPlayers: number;
    maxPlayers: number;
    minFunctions: number;
    maxFunctions: number;
  }>;
  functions: Array<{
    id: string;
    operation: string;
    argumentCount: number;
  }>;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readPackageFile(
  packageDirectory: string,
  packagePath: string,
): Promise<string> {
  const fullPath = resolve(packageDirectory, packagePath);
  const pathFromPackage = relative(packageDirectory, fullPath);

  if (
    pathFromPackage === ".." ||
    pathFromPackage.startsWith(`..${sep}`) ||
    isAbsolute(pathFromPackage)
  ) {
    throw new Error(`Package path escapes its folder: ${packagePath}`);
  }

  return readFile(fullPath, "utf8");
}

function makeProgram(
  functions: Array<{
    name: string;
    operation: string;
    argumentCount: number;
    source: string;
  }>,
): string {
  const dispatch = functions.map((fn) => {
    const declarations = Array.from(
      { length: fn.argumentCount },
      (_, index) => `        int arg${index};`,
    ).join("\n");

    const reads = Array.from(
      { length: fn.argumentCount },
      (_, index) => `arg${index}`,
    ).join(" >> ");

    const argumentsList = Array.from(
      { length: fn.argumentCount },
      (_, index) => `arg${index}`,
    ).join(", ");

    return `    if (operation == "${fn.operation}") {
${declarations}
        if (!(std::cin >> ${reads})) return 1;
        std::cout << ${fn.name}(${argumentsList}) << '\\n';
        return 0;
    }`;
  }).join(" else ");

  const definitions = functions.map((fn) => fn.source.trim()).join("\n\n");

  return `#include <iostream>
#include <string>

${definitions}

int main() {
    std::string operation;
    if (!(std::cin >> operation)) return 1;

${dispatch}

    return 2;
}
`;
}

function stripAuthoringField(testCase: TestCase) {
  const { starterExpected: _starterExpected, ...playerTest } = testCase;
  return playerTest;
}

// Deterministic challenge selection only; never use this for sessions or roles.
function seededRandomInt(seed: string) {
  let counter = 0;
  return (min: number, max: number): number => {
    const range = max - min;
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) ||
        range < 1 || range > 0x100000000) {
      throw new Error("Invalid random integer range.");
    }
    const limit = Math.floor(0x100000000 / range) * range;
    let value: number;
    do {
      value = createHash("sha256")
        .update(JSON.stringify([seed, counter++]))
        .digest().readUInt32BE(0);
    } while (value >= limit);
    return min + (value % range);
  };
}

export async function generateChallenge(
  packageDirectory: string,
  playerCount: number,
  seed: string = randomBytes(16).toString("hex"),
) {
  if (!Number.isInteger(playerCount)) {
    throw new Error("Player count must be an integer.");
  }
  if (typeof seed !== "string" || seed.length === 0 || seed.length > 256) {
    throw new Error("Seed must contain between 1 and 256 characters.");
  }
  const randomInt = seededRandomInt(seed);
  const manifest = await readJson<ChallengeManifest>(
    resolve(packageDirectory, "challenge.json"),
  );
  const config = await readJson<GenerationConfig>(
    resolve(packageDirectory, "generation.json"),
  );

  const playerRule = config.functionCountByPlayerCount.find(
    (rule) =>
      playerCount >= rule.minPlayers &&
      playerCount <= rule.maxPlayers,
  );

  if (!playerRule) {
    throw new Error(`No generation rule for ${playerCount} players.`);
  }

  if (!Number.isInteger(playerRule.minFunctions) ||
      !Number.isInteger(playerRule.maxFunctions) ||
      playerRule.minFunctions < 1 ||
      playerRule.maxFunctions < playerRule.minFunctions ||
      playerRule.maxFunctions > config.functions.length ||
      new Set(config.functions.map((fn) => fn.id)).size !== config.functions.length) {
    throw new Error("Invalid function selection rules.");
  }

  const functionCount = randomInt(
    playerRule.minFunctions,
    playerRule.maxFunctions + 1,
  );

  const shuffledRules = [...config.functions];

  for (let index = shuffledRules.length - 1; index > 0; index--) {
    const swapIndex = randomInt(0, index + 1);
    [shuffledRules[index], shuffledRules[swapIndex]] =
      [shuffledRules[swapIndex]!, shuffledRules[index]!];
  }

  const selectedRules = shuffledRules.slice(0, functionCount);
  const manifestFunctions = new Map(
    manifest.functions.map((fn) => [fn.id, fn]),
  );

  const selectedFunctions = await Promise.all(
    selectedRules.map(async (rule) => {
      const manifestFunction = manifestFunctions.get(rule.id);

      if (!manifestFunction) {
        throw new Error(`Unknown function id: ${rule.id}`);
      }

      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(manifestFunction.name) ||
        !/^[a-z][a-z0-9_]*$/.test(rule.operation) ||
        !Number.isInteger(rule.argumentCount) ||
        rule.argumentCount < 1
      ) {
        throw new Error(`Invalid generator metadata for ${rule.id}.`);
      }

      const [starterSource, referenceSource] = await Promise.all([
        readPackageFile(packageDirectory, manifestFunction.starterFile),
        readPackageFile(packageDirectory, manifestFunction.referenceFile),
      ]);

      return {
        id: rule.id,
        name: manifestFunction.name,
        operation: rule.operation,
        argumentCount: rule.argumentCount,
        starterSource,
        referenceSource,
      };
    }),
  );

  const selectedIds = new Set(selectedFunctions.map((fn) => fn.id));
  const selectedObjectives = manifest.objectives.filter(
    (objective) =>
      objective.functionIds.length > 0 &&
      objective.functionIds.every((id) => selectedIds.has(id)),
  );
  const selectedObjectiveIds = new Set(
    selectedObjectives.map((objective) => objective.id),
  );

  const [publicCases, hiddenCases] = await Promise.all([
    readJson<TestCase[]>(
      resolve(packageDirectory, manifest.tests.publicFile),
    ),
    readJson<TestCase[]>(
      resolve(packageDirectory, manifest.tests.hiddenFile),
    ),
  ]);

  const relevantCases = (cases: TestCase[]) =>
    cases.filter((testCase) =>
      testCase.objectives.every((id) => selectedObjectiveIds.has(id)),
    );

  const filteredPublicCases = relevantCases(publicCases);
  const filteredHiddenCases = relevantCases(hiddenCases);

  if (filteredPublicCases.length === 0 || filteredHiddenCases.length === 0) {
    throw new Error("Selected functions must have public and hidden tests.");
  }

  const starterSource = makeProgram(
    selectedFunctions.map((fn) => ({
      name: fn.name,
      operation: fn.operation,
      argumentCount: fn.argumentCount,
      source: fn.starterSource,
    })),
  );

  const referenceSource = makeProgram(
    selectedFunctions.map((fn) => ({
      name: fn.name,
      operation: fn.operation,
      argumentCount: fn.argumentCount,
      source: fn.referenceSource,
    })),
  );

  return {
    playerFacing: {
      matchId: randomUUID(),
      templateId: manifest.id,
      language: "cpp" as const,
      source: starterSource,
      sourceHash: createHash("sha256")
        .update(starterSource)
        .digest("hex"),
        codeVersion: 0,
        completedObjectiveIds: [] as string[],
      objectives: selectedObjectives.map(
        ({ id, description, required }) => ({ id, description, required }),
      ),
      publicTests: filteredPublicCases.map(stripAuthoringField),
    },
    serverOnly: {
      seed,
      selectedFunctionIds: selectedFunctions.map((fn) => fn.id),
      referenceSource,
      hiddenTests: filteredHiddenCases,
    },
  };
}

export type GeneratedChallenge = Awaited<
  ReturnType<typeof generateChallenge>
>;
