import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * ChatPanel renders a read-only run trace when it has a job thread. That
 * branch returns before the RunFailureRetryProvider, so its failed-run cards
 * cannot show a countdown, its Cancel or "Trying again automatically". The
 * panel still runs the retry hook on the whole conversation, so it must turn
 * automatic retries off whenever it renders the trace; otherwise a prompt is
 * sent again with nothing on screen to show or stop it.
 *
 * ChatPanel is wired to a dozen providers, so mounting it in jsdom is not
 * practical (see conversationRosterPlacement.test.ts). These assertions read
 * the source; useRunFailureRetryActions.test.tsx covers what the flag does.
 */
const componentsDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const chatPanel = fs.readFileSync(path.resolve(componentsDir, "ChatPanel.tsx"), "utf8");

function callArguments(source: string, callee: string): string {
  const start = source.indexOf(`${callee}({`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("});", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("automatic retry in the read-only run trace", () => {
  it("is off whenever the panel renders the run trace", () => {
    const retryActions = callArguments(chatPanel, "useRunFailureRetryActions");
    expect(retryActions).toContain("autoRetryEnabled: normalizedJobThread === null");

    // The run trace is the branch taken when normalizedJobThread is set, and
    // it returns before the provider that shows the countdown.
    const traceBranch = chatPanel.indexOf("if (normalizedJobThread) {");
    const provider = chatPanel.indexOf("<RunFailureRetryProvider");
    expect(traceBranch).toBeGreaterThan(-1);
    expect(chatPanel.indexOf("if (normalizedJobThread) {", traceBranch + 1)).toBe(-1);
    expect(provider).toBeGreaterThan(traceBranch);
    expect(chatPanel.slice(traceBranch, provider)).toContain("Read-only run trace");
  });
});
