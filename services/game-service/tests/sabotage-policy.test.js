import assert from "node:assert/strict";
import test from "node:test";
import {
  mutations,
  applyMutation,
  hasBoundedDamage,
} from "../src/services/sabotage-policy.ts";

const mutation = mutations.find(
  (item) => item.id === "sabotage-sum-digits",
);

assert.ok(mutation);

test("sabotage changes only its target function and ignores comments", () => {
  const source = `
#include <iostream>

int other(int value) {
  int sum = 0;
  sum += value % 10;
  return sum;
}

int sumDigits(int value) {
  int sum = 0;
  // sum += value % 10
  while (value > 0) {
    sum += value % 10;
    value /= 10;
  }
  return sum;
}
`;

  const changed = applyMutation(source, mutation);

  assert.ok(changed);
  assert.ok(changed.includes("sum -= value % 10"));
  assert.ok(changed.includes("// sum += value % 10"));
  assert.ok(
    changed.includes(
      "int other(int value) {\n  int sum = 0;\n  sum += value % 10;",
    ),
  );
  assert.equal(applyMutation(changed, mutation), null);
});

test("sabotage rejects ambiguous matches and unsupported macros", () => {
  assert.equal(
    applyMutation(
      `int sumDigits(int value) {
        int sum = 0;
        sum += value % 10;
        sum += value % 10;
        return sum;
      }`,
      mutation,
    ),
    null,
  );

  assert.throws(() =>
    applyMutation(
      `#define sumDigits replacement
       int sumDigits(int value) {
         int sum = 0;
         sum += value % 10;
         return sum;
       }`,
      mutation,
    ),
  );
});

test("damage must be meaningful and confined to the target objective", () => {
  const cases = [
    { id: "a", objectives: ["digit-sum"] },
    { id: "b", objectives: ["digit-count"] },
  ];

  const before = [
    { id: "a", status: "PASSED" },
    { id: "b", status: "PASSED" },
  ];

  assert.equal(
    hasBoundedDamage(
      cases,
      before,
      [
        { id: "a", status: "WRONG_ANSWER" },
        { id: "b", status: "PASSED" },
      ],
      "digit-sum",
    ),
    true,
  );

  assert.equal(
    hasBoundedDamage(cases, before, before, "digit-sum"),
    false,
  );

  assert.equal(
    hasBoundedDamage(
      cases,
      before,
      [
        { id: "a", status: "PASSED" },
        { id: "b", status: "WRONG_ANSWER" },
      ],
      "digit-sum",
    ),
    false,
  );

  assert.equal(
    hasBoundedDamage(
      cases,
      before,
      [
        { id: "a", status: "RUNTIME_ERROR" },
        { id: "b", status: "PASSED" },
      ],
      "digit-sum",
    ),
    false,
  );
});