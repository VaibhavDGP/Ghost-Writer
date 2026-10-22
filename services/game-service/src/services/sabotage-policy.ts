import { readFile } from "node:fs/promises";

export interface Mutation {
  id: string;
  label: string;
  functionName: string;
  objectiveId: string;
  from: string;
  to: string;
}

export const mutations = JSON.parse(
  await readFile(
    new URL(
      "../../../../challenges/templates/numeric-001/sabotage/approved-mutations.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Mutation[];

interface Token {
  value: string;
  start: number;
  end: number;
}

function tokenize(source: string): Token[] {
  // This deliberately supports the numeric template's ordinary C++ syntax.
  // Unsupported syntax makes sabotage unavailable; it is never guessed at.
  const text = source.replace(
    /^[ \t]*#include[ \t]*<(?:iostream|string)>[ \t]*\r?$/gm,
    (line) => " ".repeat(line.length),
  );

  if (/#|\\\r?\n|\?\?|<%|%>|<:|:>|\b(?:u8|u|U|L)?R"/.test(text)) {
    throw new Error("This source uses syntax outside the sabotage policy.");
  }

  const scanner =
    /\s+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[A-Za-z_]\w*|\d+|::|<<|>>|<=|>=|==|!=|&&|\|\||\+\+|--|\+=|-=|\*=|\/=|%=|->|[{}()[\];,.:?~!%^&*+\-/|<>=]/gy;

  const tokens: Token[] = [];
  let position = 0;

  while (position < text.length) {
    if (
      text.startsWith("/*", position) &&
      text.indexOf("*/", position + 2) < 0
    ) {
      throw new Error("Unclosed comment.");
    }

    scanner.lastIndex = position;
    const match = scanner.exec(text);

    if (!match) {
      throw new Error("Unsupported source syntax.");
    }

    const value = match[0];
    const end = scanner.lastIndex;

    if (
      !/^\s/.test(value) &&
      !value.startsWith("//") &&
      !value.startsWith("/*")
    ) {
      tokens.push({ value, start: position, end });
    }

    position = end;
  }

  return tokens;
}

export function applyMutation(
  source: string,
  mutation: Mutation,
): string | null {
  const tokens = tokenize(source);
  const needle = tokenize(mutation.from).map((token) => token.value);

  if (needle.length === 0) return null;

  let depth = 0;
  const bodies: Array<[number, number]> = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;

    if (
      depth === 0 &&
      token.value === "int" &&
      tokens[i + 1]?.value === mutation.functionName &&
      tokens[i + 2]?.value === "("
    ) {
      let endParameters = i + 3;

      while (
        endParameters < tokens.length &&
        tokens[endParameters]!.value !== ")"
      ) {
        endParameters++;
      }

      if (tokens[endParameters + 1]?.value === "{") {
        const start = endParameters + 2;
        let nested = 1;
        let end = start;

        while (end < tokens.length && nested > 0) {
          if (tokens[end]!.value === "{") nested++;
          if (tokens[end]!.value === "}") nested--;
          if (nested > 0) end++;
        }

        if (nested !== 0) {
          throw new Error("Unbalanced function.");
        }

        bodies.push([start, end]);
      }
    }

    if (token.value === "{") depth++;
    if (token.value === "}") depth--;

    if (depth < 0) {
      throw new Error("Unbalanced source.");
    }
  }

  if (depth !== 0 || bodies.length !== 1) return null;

  const [start, end] = bodies[0]!;
  const matches: number[] = [];

  for (let i = start; i + needle.length <= end; i++) {
    if (
      needle.every(
        (value, offset) => tokens[i + offset]?.value === value,
      )
    ) {
      matches.push(i);
    }
  }

  // Ambiguous or missing patterns are not mutated.
  if (matches.length !== 1) return null;

  const index = matches[0]!;

  return (
    source.slice(0, tokens[index]!.start) +
    mutation.to +
    source.slice(tokens[index + needle.length - 1]!.end)
  );
}

export interface StatusCase {
  id: string;
  status: string;
}

export interface TrustedCase {
  id: string;
  objectives: string[];
}

export function hasBoundedDamage(
  cases: TrustedCase[],
  before: StatusCase[],
  after: StatusCase[],
  objectiveId: string,
): boolean {
  if (
    before.length !== cases.length ||
    after.length !== cases.length
  ) {
    return false;
  }

  let damaged = false;

  for (let i = 0; i < cases.length; i++) {
    const test = cases[i]!;
    const oldResult = before[i]!;
    const newResult = after[i]!;

    if (
      oldResult.id !== test.id ||
      newResult.id !== test.id
    ) {
      return false;
    }

    if (
      ![oldResult.status, newResult.status].every(
        (status) =>
          status === "PASSED" || status === "WRONG_ANSWER",
      )
    ) {
      return false;
    }

    if (oldResult.status === newResult.status) continue;

    // Only a passing case belonging solely to the target may become wrong.
    // Reject crashes, cross-objective damage, and mixed repair/sabotage.
    if (
      oldResult.status !== "PASSED" ||
      newResult.status !== "WRONG_ANSWER" ||
      test.objectives.length !== 1 ||
      test.objectives[0] !== objectiveId
    ) {
      return false;
    }

    damaged = true;
  }

  return damaged;
}