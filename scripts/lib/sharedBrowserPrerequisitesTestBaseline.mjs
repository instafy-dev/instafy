import assert from "node:assert/strict";

const step = "      - name: Install fixture display, database and compiler prerequisites\n";
const current = `${step}        timeout-minutes: 10\n`;
const previous = `${step}        timeout-minutes: 5\n`;

// Test-only inverse for the two prerequisite budget increases. Use only when
// reconstructing historical whole-workflow hashes; current workflow contracts
// inspect the actual budgets, commands and job placement without normalization.
export function withoutSharedPrerequisiteTimeout(file, source) {
  if (file !== "browser-e2e.yml") return source;
  assert.equal(source.split(step).length - 1, 2, "exactly two Shared prerequisite steps must remain");
  assert.equal(source.split(current).length - 1, 2, "both Shared prerequisite steps must have the reviewed 10-minute budget");
  return source.replaceAll(current, previous);
}
