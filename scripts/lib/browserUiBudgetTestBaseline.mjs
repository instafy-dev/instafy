import assert from "node:assert/strict";

// Test-only inverse for historical whole-workflow hashes. Current workflow
// contracts assert the 40-minute job and 20-minute suite budgets directly.
export function withoutBrowserUiJobBudget(file, source) {
  if (file !== "browser-e2e.yml") return source;
  const marker = "\n  browser-ui:\n";
  const parts = source.split(marker);
  assert.equal(parts.length, 2, "exactly one Browser UI job must remain");
  const job = parts[1].split(/\n  [\w-]+:\n/u)[0];
  assert.deepEqual(job.match(/^    timeout-minutes: .*$/gmu),
    ["    timeout-minutes: 40"], "Browser UI must retain its reviewed 40-minute budget");
  return source.replace(marker + job,
    marker + job.replace("    timeout-minutes: 40", "    timeout-minutes: 30"));
}
