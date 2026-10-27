import { tokenize } from "./sabotage-policy.js";

export interface FunctionDocument {
  parts: string[];
  names: string[];
  bodies: Record<string, string>;
}

/**
 * Splits the generated program into protected scaffolding and editable
 * function bodies. Includes, function signatures, braces and main()
 * remain protected.
 */
export function splitFunctions(source: string): FunctionDocument {
  const tokens = tokenize(source);
  const parts: string[] = [];
  const names: string[] = [];
  const bodies: Record<string, string> = {};

  let cursor = 0;
  let depth = 0;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;

    if (
      depth === 0 &&
      token.value === "int" &&
      /^[A-Za-z_]\w*$/.test(tokens[index + 1]?.value ?? "") &&
      tokens[index + 1]?.value !== "main" &&
      tokens[index + 2]?.value === "("
    ) {
      const name = tokens[index + 1]!.value;

      let endParameters = index + 3;
      let parameterDepth = 1;

      while (endParameters < tokens.length && parameterDepth > 0) {
        const value = tokens[endParameters]!.value;

        if (value === "(") parameterDepth++;
        if (value === ")") parameterDepth--;

        if (parameterDepth > 0) endParameters++;
      }

      const opening = tokens[endParameters + 1];

      if (opening?.value !== "{") {
        throw new Error("Unsupported function declaration.");
      }

      let closingIndex = endParameters + 2;
      let bodyDepth = 1;

      while (closingIndex < tokens.length && bodyDepth > 0) {
        const value = tokens[closingIndex]!.value;

        if (value === "{") bodyDepth++;
        if (value === "}") bodyDepth--;

        if (bodyDepth > 0) closingIndex++;
      }

      const closing = tokens[closingIndex];

      if (bodyDepth !== 0 || !closing) {
        throw new Error("Unbalanced function body.");
      }

      if (Object.hasOwn(bodies, name)) {
        throw new Error("Duplicate function name.");
      }

      parts.push(source.slice(cursor, opening.end));
      names.push(name);
      bodies[name] = source.slice(opening.end, closing.start);

      cursor = closing.start;
      index = closingIndex;
      continue;
    }

    if (token.value === "{") depth++;
    if (token.value === "}") depth--;

    if (depth < 0) {
      throw new Error("Unbalanced program.");
    }
  }

  if (depth !== 0 || names.length === 0) {
    throw new Error("No supported editable functions were found.");
  }

  parts.push(source.slice(cursor));

  return { parts, names, bodies };
}

export function createSharedDocument(matchId: string, source: string) {
  const parsed = splitFunctions(source);

  return {
    matchId,
    revision: 0,
    parts: parsed.parts,
    names: parsed.names,
    functions: Object.fromEntries(
      parsed.names.map((name) => [
        name,
        {
          body: parsed.bodies[name]!,
          official: parsed.bodies[name]!,
          revision: 0,
          accepted: false,
        },
      ]),
    ),
  };
}

export function assertSameScaffold(
  original: string,
  candidate: string,
): void {
  const before = splitFunctions(original);
  const after = splitFunctions(candidate);

  if (
    JSON.stringify(before.names) !== JSON.stringify(after.names) ||
    JSON.stringify(before.parts) !== JSON.stringify(after.parts)
  ) {
    throw new Error(
      "Only the contents of your claimed function may change. " +
        "Keep function signatures, outer braces, includes and main() unchanged.",
    );
  }
}