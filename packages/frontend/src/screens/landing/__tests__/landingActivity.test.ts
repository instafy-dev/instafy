import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../studio/types";
import { summarizeTurnActivity, type TurnActivityPhase } from "../../studio/components/turnActivity";
import { SESSION_SCENARIOS } from "../landingTurnScript";

// The landing demo's activity lines are the studio's own: each run below is
// the steps the scenario plays, with the activity runtime-agent attaches to
// them (jobs/activity_labels.rs), and the studio's summarizer must say exactly
// what the demo shows, while each step runs and once the run ends.
const JOB = "landing-job";
const TOOL = {
  v: 1, key: "tool/use", role: "content", live: "Using a tool",
  done: { one: "used a tool", other: "used {n} tools", some: "used tools" }, count: 1, also: [],
};
const TESTS = { v: 1, key: "builtin/test", role: "content", live: "Running tests", done: "ran tests", count: 1, also: [] };
const TUNNEL = { v: 1, key: "instafy/tunnel", role: "content", live: "Making a public link", done: "made a public link", count: 1, also: [] };
const HOST = "k7m2qa.instafy.site";
const PRICING = "a1b2c3d4e5f60718";
const browser = (key: string, live: string, done: unknown, step: string, extra: Record<string, unknown> = {}) => ({
  v: 1, key, role: done ? "content" : "quiet", live, ...(done ? { done } : {}), count: 1,
  ...(done ? { when: "success" } : {}), host: HOST, step, also: [], ...extra,
});
const OPEN = browser("browser/open", "Opening {host}", {
  one: "opened {host}", other: "opened {n} pages on {host}", some: "opened pages on {host}",
}, "navigate", { pageKey: PRICING, approval: "once" });
const READ = browser("browser/read", "Reading {host}", {
  one: "read a page on {host}", other: "read {n} pages on {host}", some: "read pages on {host}",
}, "snapshot", { pageKey: PRICING });
const BROWSE = (step: string) => browser("browser/browse", "Browsing {host}", null, step);

type Step =
  | { type: "command"; activity: unknown }
  | { type: "tool"; activity: unknown }
  | { type: "edit"; paths: string[] }
  | { type: "plan" }
  // The step waits on a prompt only the viewer can answer.
  | { type: "waiting"; activity: unknown };

let sequence = 0;
function message(type: string, status: string, metadata: Record<string, unknown>, details: Record<string, unknown> = {}): ChatMessage {
  sequence += 1;
  return {
    id: `m-${sequence}`,
    role: "assistant",
    content: type,
    timestamp: sequence,
    messageType: type,
    metadata: { source: "agent", jobId: JOB, messageType: type, details: { itemId: `i-${sequence}`, status, ...details }, ...metadata },
  };
}

function messagesOf(steps: readonly Step[], runningLast: boolean): ChatMessage[] {
  return steps.map((step, index) => {
    const status = runningLast && index === steps.length - 1 ? "in_progress" : "completed";
    switch (step.type) {
      case "command":
        return message("command_execution", status, step.activity ? { activity: step.activity } : {}, { exitCode: status === "completed" ? 0 : null });
      case "tool":
      case "waiting":
        return message("mcp_tool_call", status, { activity: step.activity });
      case "edit":
        return message("file_change", status, {
          activity: { v: 1, key: "builtin/edit", role: "content", live: "Editing files",
            done: { one: "edited a file", other: "edited {n} files", some: "edited files" }, count: 1, also: [] },
        }, { paths: step.paths });
      case "plan":
        return message("todo_list", "completed", {});
    }
  });
}

function lineAt(steps: readonly Step[], index: number): string | null {
  const shown = steps.slice(0, index + 1);
  const last = shown[shown.length - 1];
  const phase: TurnActivityPhase = "running";
  return summarizeTurnActivity(messagesOf(shown, last.type !== "plan"), {
    jobId: JOB,
    phase,
    viewerCanAnswer: last.type === "waiting",
  }).live;
}

function doneLine(steps: readonly Step[]): string | null {
  return summarizeTurnActivity(messagesOf(steps, false), { jobId: JOB, phase: "completed" }).summary;
}

const RUNS: Record<string, Step[]> = {
  // A tool reads the bank export, a script reconciles it, Quill's tool checks
  // the VAT lines, and the review file is written.
  books: [
    { type: "tool", activity: TOOL },
    { type: "command", activity: null },
    { type: "plan" },
    { type: "tool", activity: TOOL },
    { type: "edit", paths: ["ledger/2026-02-review.csv"] },
  ],
  code: [
    { type: "edit", paths: ["packages/checkout/index.ts", "apps/api/src/router.ts", "packages/checkout/checkout.test.ts"] },
    { type: "command", activity: TESTS },
    { type: "plan" },
    { type: "command", activity: TESTS },
    { type: "command", activity: null },
  ],
  site: [
    { type: "edit", paths: ["site/pricing.html"] },
    { type: "command", activity: null },
    { type: "plan" },
    { type: "edit", paths: ["site/pricing.css"] },
    { type: "command", activity: TUNNEL },
  ],
};

const BROWSER_RUN: Step[] = [
  { type: "waiting", activity: OPEN },
  { type: "tool", activity: OPEN },
  { type: "tool", activity: READ },
  { type: "tool", activity: BROWSE("scroll") },
  { type: "tool", activity: BROWSE("click") },
];

describe("the landing demo's activity lines", () => {
  it("are what the studio's line says while each step runs and once the run ends", () => {
    for (const scenario of SESSION_SCENARIOS) {
      const run = RUNS[scenario.id];
      expect(run, scenario.id).toBeDefined();
      expect(scenario.steps.map((_, index) => lineAt(run, index))).toEqual(scenario.steps.map((step) => step.live));
      expect(doneLine(run), scenario.id).toBe(scenario.activity);
    }
  });

  it("are what the studio's line says for Octo's browser run", () => {
    const browserScript = SESSION_SCENARIOS.find((scenario) => scenario.browser)!.browser!;
    // While the prompt waits the step itself has started (its host is known).
    expect(browserScript.steps.map((_, index) => lineAt(BROWSER_RUN, index))).toEqual(
      browserScript.steps.map((step) => step.live),
    );
    // The prompt it waited on is the navigation's, allowed once.
    expect(doneLine(BROWSER_RUN.slice(1))).toBe(browserScript.activity);
  });
});
