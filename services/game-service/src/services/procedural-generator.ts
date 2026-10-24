import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { GeneratedChallenge } from "./challenge-generator.js";
import type { Mutation } from "./sabotage-policy.js";

type Kind =
  | "discount"
  | "scale"
  | "blocks"
  | "cap"
  | "floor"
  | "bonus";

interface Stage {
  kind: Kind;
  a: number;
  b: number;
}

interface Pipeline {
  operation: string;
  title: string;
  stages: Stage[];
  brokenStage: number;
}

const kinds: Kind[] = [
  "discount",
  "scale",
  "blocks",
  "cap",
  "floor",
  "bonus",
];

const operations = [
  "invoice",
  "freight",
  "warehouse",
  "credit",
  "loyalty",
];

function randomFor(seed: string) {
  let counter = 0;

  return (min: number, max: number) => {
    const range = max - min;
    const limit = Math.floor(0x100000000 / range) * range;

    let value: number;

    do {
      value = createHash("sha256")
        .update(JSON.stringify([seed, counter++]))
        .digest()
        .readUInt32BE(0);
    } while (value >= limit);

    return min + (value % range);
  };
}

function describe(stage: Stage): string {
  switch (stage.kind) {
    case "discount":
      return `subtract ${stage.b} when the value is at least ${stage.a}, keeping the result non-negative`;

    case "scale":
      return `multiply by ${stage.a}/100 and round down`;

    case "blocks":
      return `charge ${stage.b} per started block of ${stage.a} (zero blocks for zero)`;

    case "cap":
      return `limit the value to at most ${stage.a}`;

    case "floor":
      return `raise the value to at least ${stage.a}`;

    case "bonus":
      return `add ${stage.b} for every complete group of ${stage.a} in the incoming value`;
  }
}

function evaluateStage(
  stage: Stage,
  value: number,
  broken: boolean,
): number {
  switch (stage.kind) {
    case "discount":
      return (broken ? value > stage.a : value >= stage.a)
        ? Math.max(0, value - stage.b)
        : value;

    case "scale":
      return (broken ? Math.ceil : Math.floor)(
        (value * stage.a) / 100,
      );

    case "blocks":
      return (
        (broken ? Math.floor : Math.ceil)(value / stage.a) *
        stage.b
      );

    case "cap":
      return value > stage.a
        ? stage.a + (broken ? 1 : 0)
        : value;

    case "floor":
      return value < stage.a
        ? broken
          ? 0
          : stage.a
        : value;

    case "bonus":
      return (
        value +
        Math.floor(
          Math.max(0, value - (broken ? 1 : 0)) / stage.a,
        ) *
          stage.b
      );
  }
}

function evaluate(
  pipeline: Pipeline,
  input: number,
  broken: boolean,
): number {
  return pipeline.stages.reduce(
    (value, stage, index) =>
      evaluateStage(
        stage,
        value,
        broken && index === pipeline.brokenStage,
      ),
    Math.max(0, Math.min(1000, input)),
  );
}

function renderStage(
  stage: Stage,
  name: string,
  broken: boolean,
): string {
  let body: string;

  switch (stage.kind) {
    case "discount":
      body = `    if (value ${broken ? ">" : ">="} ${stage.a}) {
        int reduced = value - ${stage.b};
        if (reduced < 0) return 0;
        return reduced;
    }
    return value;`;
      break;

    case "scale":
      body = `    int product = value * ${stage.a};
    int whole = product / 100;
    int remainder = product % 100;
    if (remainder != 0) {
        return whole${broken ? " + 1" : ""};
    }
    return whole;`;
      break;

    case "blocks":
      body = `    int blocks = value / ${stage.a};
    int remainder = value % ${stage.a};
    if (remainder ${broken ? "<" : ">"} 0) {
        ++blocks;
    }
    return blocks * ${stage.b};`;
      break;

    case "cap":
      body = `    const int maximum = ${stage.a};
    if (value > maximum) {
        return maximum${broken ? " + 1" : ""};
    }
    return value;`;
      break;

    case "floor":
      body = `    const int minimum = ${stage.a};
    if (value < minimum) {
        return ${broken ? "0" : "minimum"};
    }
    return value;`;
      break;

    case "bonus":
      body = `    int remaining = value;
    int bonus = 0;
    while (remaining ${broken ? ">" : ">="} ${stage.a}) {
        bonus += ${stage.b};
        remaining -= ${stage.a};
    }
    return value + bonus;`;
      break;
  }

  return `int ${name}(int value) {\n${body}\n}`;
}

function render(
  pipelines: Pipeline[],
  broken: boolean,
): string {
  const definitions = pipelines.map((pipeline) => {
    const steps = pipeline.stages.map((stage, index) =>
      renderStage(
        stage,
        `${pipeline.operation}Step${index + 1}`,
        broken && index === pipeline.brokenStage,
      ),
    );

    return `${steps.join("\n\n")}

int process_${pipeline.operation}(int input) {
    int value = clampInput(input);
    value = ${pipeline.operation}Step1(value);
    value = ${pipeline.operation}Step2(value);
    value = ${pipeline.operation}Step3(value);
    return value;
}`;
  });

  const dispatch = pipelines
    .map(
      (pipeline) => `        if (operation == "${pipeline.operation}") {
            std::cout << process_${pipeline.operation}(input) << '\\n';
        }`,
    )
    .join(" else ");

  return `#include <iostream>
#include <string>

// Processing service. Each input line contains: operation integer
// Inputs are clamped to 0..1000 before processing.
// Apply each operation's three documented rules in order.
// Print one integer result for each input line.

int clampInput(int value) {
    if (value < 0) return 0;
    if (value > 1000) return 1000;
    return value;
}

${definitions.join("\n\n")}

int main() {
    std::string operation;
    int input;

    while (std::cin >> operation >> input) {
${dispatch} else {
            return 2;
        }
    }

    return std::cin.eof() ? 0 : 1;
}
`;
}

export function generateProceduralChallenge(
  playerCount: number,
  seed = randomBytes(16).toString("hex"),
): GeneratedChallenge {
  if (
    !Number.isInteger(playerCount) ||
    playerCount < 2 ||
    playerCount > 8
  ) {
    throw new Error(
      "Player count must be an integer from 2 to 8.",
    );
  }

  if (
    typeof seed !== "string" ||
    seed.length < 1 ||
    seed.length > 256
  ) {
    throw new Error("Seed must contain 1–256 characters.");
  }

  const random = randomFor(seed);
  const count = playerCount <= 4 ? 4 : 5;

  const pipelines: Pipeline[] = [];

  const publicTests:
    GeneratedChallenge["playerFacing"]["publicTests"] = [];

  const hiddenTests:
    GeneratedChallenge["serverOnly"]["hiddenTests"] = [];

  const approvedMutations: Mutation[] = [];

  function makeStage(kind: Kind): Stage {
    switch (kind) {
      case "discount":
        return {
          kind,
          a: random(20, 601),
          b: random(1, 20),
        };

      case "scale":
        return {
          kind,
          a: [75, 90, 110, 125, 150][random(0, 5)]!,
          b: 0,
        };

      case "blocks":
        return {
          kind,
          a: random(3, 21),
          b: random(1, 13),
        };

      case "cap":
        return { kind, a: random(50, 901), b: 0 };

      case "floor":
        return { kind, a: random(10, 101), b: 0 };

      case "bonus":
        return {
          kind,
          a: random(4, 26),
          b: random(1, 11),
        };
    }
  }

  for (let index = 0; index < count; index++) {
    let selected: Pipeline | undefined;
    let passing: number[] = [];
    let failing: number[] = [];

    for (let attempt = 0; attempt < 500; attempt++) {
      const pool = [...kinds];
      const steps: Stage[] = [];

      for (let i = 0; i < 3; i++) {
        const kind = pool.splice(
          random(0, pool.length),
          1,
        )[0]!;

        steps.push(makeStage(kind));
      }

      const pipeline: Pipeline = {
        operation: operations[index]!,
        title: operations[index]!,
        stages: steps,
        brokenStage: random(0, 3),
      };

      passing = [];
      failing = [];

      for (let input = 0; input <= 1000; input++) {
        const correct = evaluate(pipeline, input, false);
        const buggy = evaluate(pipeline, input, true);

        (correct === buggy ? passing : failing).push(input);
      }

      // Reject defects hidden by later stages.
      // Also retain some initially passing behavior for sabotage.
      if (passing.length > 0 && failing.length > 0) {
        selected = pipeline;
        break;
      }
    }

    if (!selected) {
      throw new Error(
        "Could not generate a repairable pipeline.",
      );
    }

    const pipeline = selected;
    pipelines.push(pipeline);

    const objectiveId = `${pipeline.operation}-rules`;

    const examples = [
      ...new Set([
        passing[0]!,
        passing[Math.floor(passing.length / 2)]!,
        passing[passing.length - 1]!,
      ]),
    ];

    const checks = new Set([
      -1,
      0,
      1,
      999,
      1000,
      1001,
      failing[0]!,
      failing[failing.length - 1]!,
    ]);

    for (let i = 0; i < 24; i++) {
      checks.add(random(0, 1001));
    }

    const makeTest = (id: string, inputs: number[]) => ({
      id,
      input: inputs
        .map((input) => `${pipeline.operation} ${input}`)
        .join("\n"),
      expectedOutput: inputs
        .map((input) =>
          String(evaluate(pipeline, input, false)),
        )
        .join("\n"),
      objectives: [objectiveId],
    });

    publicTests.push(
      makeTest(`${pipeline.operation}-examples`, examples),
    );

    hiddenTests.push(
      makeTest(
        `${pipeline.operation}-verification`,
        [...checks],
      ),
    );

    approvedMutations.push({
      id: `invert-${pipeline.operation}`,
      label: `Corrupt ${pipeline.operation} output`,
      functionName: `process_${pipeline.operation}`,
      objectiveId,
      from: "return value;",
      to: "return -value - 1;",
    });
  }

  // Excludes the seed, match ID, and source-layout shuffle.
  const specificationHash = createHash("sha256")
    .update(JSON.stringify({ version: 1, pipelines }))
    .digest("hex");

  for (let i = pipelines.length - 1; i > 0; i--) {
    const j = random(0, i + 1);

    [pipelines[i], pipelines[j]] = [
      pipelines[j]!,
      pipelines[i]!,
    ];
  }

  const source = render(pipelines, true);

  return {
    playerFacing: {
      matchId: randomUUID(),
      templateId: "procedural-v1",
      language: "cpp",
      source,
      sourceHash: createHash("sha256")
        .update(source)
        .digest("hex"),
      codeVersion: 0,
      completedObjectiveIds: [],

      objectives: pipelines.map((pipeline) => ({
        id: `${pipeline.operation}-rules`,
        required: true,
        description:
          `${pipeline.title}: clamp input to 0..1000; then ` +
          pipeline.stages.map(describe).join("; then ") +
          ".",
      })),

      publicTests,
    },

    serverOnly: {
      seed,
      specificationHash,

      selectedFunctionIds: pipelines.flatMap((pipeline) => [
        `${pipeline.operation}Step1`,
        `${pipeline.operation}Step2`,
        `${pipeline.operation}Step3`,
        `process_${pipeline.operation}`,
      ]),

      referenceSource: render(pipelines, false),
      hiddenTests,
      approvedMutations,
    },
  };
}