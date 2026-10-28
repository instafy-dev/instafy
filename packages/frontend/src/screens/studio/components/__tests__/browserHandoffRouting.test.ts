import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunRecord } from "../../../../types";
import type { RuntimeBrowserSessionAction } from "../../../../sdk/instafy";
import {
  SHARED_BROWSER_FOLLOW_UP_WINDOW_MS,
  browserPageOrigin,
  continuedSharedBrowserRunId,
  selectSharedBrowserHumanInput,
  sharedBrowserAgentPageIds,
  sharedBrowserConversationRunIds,
  sharedBrowserFollowUp,
  sharedBrowserTakeoverJob,
} from "../browserHandoffRouting";

const JOB_ID = "00000000-0000-4000-8000-000000000001";
const RUN_ID = "00000000-0000-4000-8000-000000000002";
const USER_ID = "00000000-0000-4000-8000-000000000003";
const CURRENT_RUN_IDS = new Set([RUN_ID]);

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: RUN_ID, projectId: "project-1", conversationId: "conversation-1", sessionId: null,
    promptId: null, runType: "prompt", status: "in_progress", progress: 0,
    progressStage: null, previewUrl: null, lastMessage: null, createdAt: null, updatedAt: null,
    metadata: { browserTransport: "shared", browserRuntimeId: "runtime-1", browserPageId: "page-1", jobId: JOB_ID },
    ...overrides,
  };
}

function guidance(overrides: Partial<RuntimeBrowserSessionAction["humanInputRequest"]> = {}): RuntimeBrowserSessionAction {
  return {
    seq: 1, ts: 1000, type: "human_input", label: "Human input needed", url: null,
    pageId: "page-1", x: null, y: null, viewportW: null, viewportH: null,
    humanInputRequest: {
      version: 1, handoffId: "00000000-0000-4000-8000-000000000004", runId: RUN_ID,
      initiatorUserId: USER_ID, browserPageId: "page-1", origin: "https://example.test",
      createdAtMs: 1000, expiresAtMs: 10000, fields: [{ label: "Highlighted field 1" }],
      ...overrides,
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("browserPageOrigin", () => {
  it("normalizes only credential-free HTTP(S) URLs", () => {
    expect(browserPageOrigin("https://example.test:443/form?step=1#field")).toBe("https://example.test");
    expect(browserPageOrigin("http://example.test:8080/form")).toBe("http://example.test:8080");
    for (const value of [null, undefined, "", "not a URL", "file:///tmp/form", "about:blank", "javascript:alert(1)", "https://user:password@example.test/"]) {
      expect(browserPageOrigin(value)).toBeNull();
    }
  });
});

describe("sharedBrowserTakeoverJob on the agent's own tabs", () => {
  it("finds the runtime's one browser job from a tab the agent opened", () => {
    expect(sharedBrowserTakeoverJob([run()], "runtime-1", "agent-tab", { openedByAgent: true }))
      .toEqual({ jobId: JOB_ID, runId: RUN_ID });
  });

  it("never falls back for a person's tab, another runtime, or two jobs", () => {
    expect(sharedBrowserTakeoverJob([run()], "runtime-1", "agent-tab")).toBeNull();
    expect(sharedBrowserTakeoverJob([run()], "runtime-1", "agent-tab", { openedByAgent: false })).toBeNull();
    expect(sharedBrowserTakeoverJob([run()], "other-runtime", "agent-tab", { openedByAgent: true })).toBeNull();
    expect(sharedBrowserTakeoverJob([run(), run({ id: "another-run" })], "runtime-1", "agent-tab", { openedByAgent: true })).toBeNull();
    expect(sharedBrowserTakeoverJob([run({ status: "success" })], "runtime-1", "agent-tab", { openedByAgent: true })).toBeNull();
  });

  it("finds the runtime's one browser job from any tab while the agent holds the browser", () => {
    // A person's own tab on screen: Octo closed its last tab, or a page
    // opened one. The agent's control spans every tab, and so does Take over.
    expect(sharedBrowserTakeoverJob([run()], "runtime-1", "persons-tab", { agentHoldsBrowser: true }))
      .toEqual({ jobId: JOB_ID, runId: RUN_ID });
    expect(sharedBrowserTakeoverJob([run()], "other-runtime", "persons-tab", { agentHoldsBrowser: true })).toBeNull();
    expect(sharedBrowserTakeoverJob([run(), run({ id: "another-run" })], "runtime-1", "persons-tab", { agentHoldsBrowser: true })).toBeNull();
    expect(sharedBrowserTakeoverJob([run({ status: "success" })], "runtime-1", "persons-tab", { agentHoldsBrowser: true })).toBeNull();
    expect(sharedBrowserTakeoverJob([run()], "runtime-1", "persons-tab", { agentHoldsBrowser: false })).toBeNull();
  });

  it("never stops a queued run from a tab it is not bound to: another conversation's run holds the browser", () => {
    const queued = run({
      id: "queued-run", status: "queued",
      metadata: { ...run().metadata, browserPageId: "page-2", jobId: "00000000-0000-4000-8000-000000000009" },
    });
    for (const options of [{ agentHoldsBrowser: true }, { openedByAgent: true }]) {
      expect(sharedBrowserTakeoverJob([queued], "runtime-1", "persons-tab", options)).toBeNull();
      // The run of this conversation that has started is the one stopped.
      expect(sharedBrowserTakeoverJob([queued, run()], "runtime-1", "persons-tab", options))
        .toEqual({ jobId: JOB_ID, runId: RUN_ID });
    }
    // On the tab a queued run is bound to, that run is still the one found.
    expect(sharedBrowserTakeoverJob([queued], "runtime-1", "page-2", { agentHoldsBrowser: true }))
      .toEqual({ jobId: "00000000-0000-4000-8000-000000000009", runId: "queued-run" });
  });

  it("prefers the job bound to the page on screen", () => {
    const other = run({ id: "other-run", metadata: { ...run().metadata, browserPageId: "page-2", jobId: "00000000-0000-4000-8000-000000000009" } });
    expect(sharedBrowserTakeoverJob([run(), other], "runtime-1", "page-1", { openedByAgent: true }))
      .toEqual({ jobId: JOB_ID, runId: RUN_ID });
  });
});

describe("sharedBrowserAgentPageIds", () => {
  it("lists the pages this runtime's active browser runs are bound to, once each", () => {
    expect(sharedBrowserAgentPageIds([run(), run({ id: "again" }), run({ id: "done", status: "success", metadata: { ...run().metadata, browserPageId: "page-9" } })], "runtime-1"))
      .toEqual(["page-1"]);
    expect(sharedBrowserAgentPageIds([run()], "other-runtime")).toEqual([]);
    expect(sharedBrowserAgentPageIds([run()], null)).toEqual([]);
    expect(sharedBrowserAgentPageIds([run({ metadata: { ...run().metadata, browserTransport: "desktop-personal" } })], "runtime-1")).toEqual([]);
  });
});

describe("sharedBrowserTakeoverJob", () => {
  it.each(["queued", "in_progress", "awaiting_approval"] as const)("selects one exact active %s browser job", (status) => {
    expect(sharedBrowserTakeoverJob([run({ status })], "runtime-1", "page-1")).toEqual({ jobId: JOB_ID, runId: RUN_ID });
  });

  it("ignores unrelated jobs and never falls back to a conversation or runtime-wide target", () => {
    const base = run();
    for (const metadata of [null, { jobId: JOB_ID }, { ...base.metadata, browserTransport: "desktop-personal" }, { ...base.metadata, browserRuntimeId: "other-runtime" }, { ...base.metadata, browserPageId: "other-page" }]) {
      expect(sharedBrowserTakeoverJob([run({ metadata })], "runtime-1", "page-1")).toBeNull();
    }
    expect(sharedBrowserTakeoverJob([base], null, "page-1")).toBeNull();
    expect(sharedBrowserTakeoverJob([base], "runtime-1", null)).toBeNull();
    expect(sharedBrowserTakeoverJob([base, run({ id: "another-run" })], "runtime-1", "page-1")).toBeNull();
  });

  it.each(["success", "failed", "canceled", "merged"] as const)("does not cancel a terminal %s run", (status) => {
    expect(sharedBrowserTakeoverJob([run({ status })], "runtime-1", "page-1")).toBeNull();
  });

  it.each([null, "", "not-a-job", `${JOB_ID}\n`, ` ${JOB_ID}`, `${JOB_ID}/cancel`])("requires a complete exact job UUID: %j", (jobId) => {
    expect(sharedBrowserTakeoverJob([run({ metadata: { ...run().metadata, jobId } })], "runtime-1", "page-1")).toBeNull();
  });
});

describe("selectSharedBrowserHumanInput", () => {
  it("shows only a current request for this user, exact page and origin", () => {
    vi.useFakeTimers();
    vi.setSystemTime(2000);
    const action = guidance();
    expect(selectSharedBrowserHumanInput([action], USER_ID, "page-1", "https://example.test", CURRENT_RUN_IDS)).toEqual(action.humanInputRequest);
    for (const [userId, pageId, origin] of [[null, "page-1", "https://example.test"], ["other-user", "page-1", "https://example.test"], [USER_ID, null, "https://example.test"], [USER_ID, "page-2", "https://example.test"], [USER_ID, "page-1", null], [USER_ID, "page-1", "https://other.test"]]) {
      expect(selectSharedBrowserHumanInput([action], userId, pageId, origin, CURRENT_RUN_IDS)).toBeNull();
    }
    vi.setSystemTime(10000);
    expect(selectSharedBrowserHumanInput([action], USER_ID, "page-1", "https://example.test", CURRENT_RUN_IDS)).toBeNull();
  });

  it("does not resurrect an older request when a newer request belongs to another person", () => {
    vi.useFakeTimers();
    vi.setSystemTime(2000);
    const actions = [guidance(), guidance({ initiatorUserId: "another-user" })];
    expect(selectSharedBrowserHumanInput(actions, USER_ID, "page-1", "https://example.test", CURRENT_RUN_IDS)).toBeNull();
  });

  it("does not resurrect an older request behind a newer malformed or expired request", () => {
    vi.useFakeTimers();
    vi.setSystemTime(2000);
    for (const replacement of [{ ...guidance(), humanInputRequest: undefined }, guidance({ expiresAtMs: 1500 })]) {
      expect(selectSharedBrowserHumanInput([guidance(), replacement], USER_ID, "page-1", "https://example.test", CURRENT_RUN_IDS)).toBeNull();
    }
  });

  it.each(["navigate", "nav_result"] as const)("clears old field guidance after a fresh %s event", (type) => {
    vi.useFakeTimers();
    vi.setSystemTime(2000);
    const request = guidance();
    const observed = { ...request, seq: 2, type, humanInputRequest: undefined };
    expect(selectSharedBrowserHumanInput([request, observed], USER_ID, "page-1", "https://example.test", CURRENT_RUN_IDS)).toBeNull();
    const newerRequest = guidance({ handoffId: "00000000-0000-4000-8000-000000000005" });
    expect(selectSharedBrowserHumanInput([request, observed, newerRequest], USER_ID, "page-1", "https://example.test", CURRENT_RUN_IDS)).toEqual(newerRequest.humanInputRequest);
  });

  it("keeps a completed current-conversation request, then hides it on conversation switch", () => {
    vi.useFakeTimers();
    vi.setSystemTime(2000);
    const history = [run({ status: "failed" }), run({ id: "another-run", conversationId: "conversation-2", status: "success" })];
    const scope = { projectId: "project-1", conversationId: "conversation-1", runtimeId: "runtime-1", pageId: "page-1" };
    const currentRunIds = sharedBrowserConversationRunIds(history, scope);
    expect(currentRunIds).toEqual(CURRENT_RUN_IDS);
    expect(selectSharedBrowserHumanInput([guidance()], USER_ID, "page-1", "https://example.test", currentRunIds)).toEqual(guidance().humanInputRequest);
    const switchedRunIds = sharedBrowserConversationRunIds(history, { ...scope, conversationId: "conversation-2" });
    expect(selectSharedBrowserHumanInput([guidance()], USER_ID, "page-1", "https://example.test", switchedRunIds)).toBeNull();
  });

  it("fails closed until the current conversation's run history is available", () => {
    vi.useFakeTimers();
    vi.setSystemTime(2000);
    for (const runIds of [null, new Set<string>(), new Set(["unrelated-run"])]) {
      expect(selectSharedBrowserHumanInput([guidance()], USER_ID, "page-1", "https://example.test", runIds)).toBeNull();
    }
  });
});

describe("sharedBrowserConversationRunIds", () => {
  const scope = { projectId: "project-1", conversationId: "conversation-1", runtimeId: "runtime-1", pageId: "page-1" };

  it.each(["queued", "in_progress", "awaiting_approval", "success", "failed", "canceled"] as const)("includes exact %s run history independently of active-run UI filtering", (status) => {
    expect(sharedBrowserConversationRunIds([run({ status })], scope)).toEqual(CURRENT_RUN_IDS);
  });

  it("does not treat another conversation, project, runtime, page or browser transport as current history", () => {
    const current = run();
    for (const unrelated of [
      run({ conversationId: "conversation-2" }), run({ projectId: "project-2" }),
      run({ metadata: { ...current.metadata, browserRuntimeId: "runtime-2" } }),
      run({ metadata: { ...current.metadata, browserPageId: "page-2" } }),
      run({ metadata: { ...current.metadata, browserTransport: "desktop-personal" } }),
    ]) {
      expect(sharedBrowserConversationRunIds([unrelated], scope).size).toBe(0);
    }
    for (const key of ["projectId", "conversationId", "runtimeId", "pageId"] as const) {
      expect(sharedBrowserConversationRunIds([current], { ...scope, [key]: null }).size).toBe(0);
    }
  });
});

describe("continuedSharedBrowserRunId", () => {
  const scope = { conversationId: "conversation-1", runtimeId: "runtime-1", pageId: "page-1", userId: USER_ID };
  const ended = (overrides: Partial<RunRecord> = {}, metadata: Record<string, unknown> = {}) => run({
    status: "canceled", updatedAt: "2026-10-27T10:58:45Z", ...overrides,
    metadata: { ...run().metadata, initiatingUserId: USER_ID, ...metadata },
  });

  it("names the newest browser run the person started on this page that has ended", () => {
    const older = ended({ id: "00000000-0000-4000-8000-000000000010", status: "success", updatedAt: "2026-10-27T10:00:00Z" });
    expect(continuedSharedBrowserRunId([older, ended()], scope)).toBe(RUN_ID);
    // A run that stopped for the person's input has ended too.
    expect(continuedSharedBrowserRunId([ended({ status: "success" })], scope)).toBe(RUN_ID);
  });

  it("names no run that is still going, another person's, another page's or another conversation's", () => {
    for (const candidate of [
      ended({ status: "in_progress" }),
      ended({ status: "queued" }),
      ended({}, { initiatingUserId: "00000000-0000-4000-8000-000000000099" }),
      ended({}, { browserPageId: "page-2" }),
      ended({}, { browserRuntimeId: "runtime-2" }),
      ended({}, { browserTransport: "desktop-personal" }),
      ended({ conversationId: "conversation-2" }),
      ended({ id: "not-a-run-id" }),
    ]) {
      expect(continuedSharedBrowserRunId([candidate], scope)).toBeNull();
    }
    expect(continuedSharedBrowserRunId([ended()], { ...scope, userId: null })).toBeNull();
    expect(continuedSharedBrowserRunId([ended()], { ...scope, pageId: null })).toBeNull();
  });
});

// Local drive, Oct 28: a follow-up typed in the chat right after a browser
// turn got a new card, a second press and a second approval for the same
// site. It goes on in the open browser instead, continuing that run.
describe("sharedBrowserFollowUp", () => {
  const ENDED_AT = Date.parse("2026-10-28T19:55:10Z");
  const pages = [{ id: "page-1" }, { id: "page-2" }];
  const scope = { conversationId: "conversation-1", runtimeId: "runtime-1", userId: USER_ID, pages, nowMs: ENDED_AT + 60_000 };
  const browserTurn = (overrides: Partial<RunRecord> = {}, metadata: Record<string, unknown> = {}) => run({
    status: "success", createdAt: "2026-10-28T19:53:39Z", updatedAt: "2026-10-28T19:55:10Z", ...overrides,
    metadata: { ...run().metadata, initiatingUserId: USER_ID, ...metadata },
  });
  const earlierTurn = run({
    id: "00000000-0000-4000-8000-000000000010", status: "success",
    createdAt: "2026-10-28T19:49:19Z", updatedAt: "2026-10-28T19:49:26Z", metadata: { jobId: JOB_ID },
  });

  it("continues the person's browser turn when it was the chat's last, in its own tab", () => {
    expect(sharedBrowserFollowUp([earlierTurn, browserTurn()], scope))
      .toEqual(expect.objectContaining({ runId: RUN_ID, page: { id: "page-1" } }));
    // Within the time the runtime keeps that turn's approvals, and no longer.
    expect(sharedBrowserFollowUp([browserTurn()], { ...scope, nowMs: ENDED_AT + SHARED_BROWSER_FOLLOW_UP_WINDOW_MS }))
      .toEqual(expect.objectContaining({ runId: RUN_ID, page: { id: "page-1" } }));
    expect(sharedBrowserFollowUp([browserTurn()], { ...scope, nowMs: ENDED_AT + SHARED_BROWSER_FOLLOW_UP_WINDOW_MS + 1 }))
      .toBeNull();
  });

  // A browser turn has only the browser's tools. After the browser turn of a
  // card Octo builds from (a page, a map), the building turn owns the chat:
  // "Build the comparison page now with what you can verify" must reach a
  // turn that can build it, even when the browser read nothing and so handed
  // nothing back.
  it("leaves the message to the chat after the browser turn of a card Octo builds from", () => {
    expect(sharedBrowserFollowUp([browserTurn({}, { browserRequestOf: `job:${JOB_ID}`, browserHandsBack: true })], scope))
      .toBeNull();
    // A question's card: the follow-up goes on in the browser.
    expect(sharedBrowserFollowUp([browserTurn({}, { browserRequestOf: `job:${JOB_ID}` })], scope))
      .toEqual(expect.objectContaining({ runId: RUN_ID, page: { id: "page-1" } }));
  });

  it("says until when the follow-up applies", () => {
    expect(sharedBrowserFollowUp([browserTurn()], scope)?.endsAtMs).toBe(ENDED_AT + SHARED_BROWSER_FOLLOW_UP_WINDOW_MS);
  });

  it("leaves the message to the chat when a later turn was not in the browser", () => {
    const handBack = run({
      id: "00000000-0000-4000-8000-000000000011", status: "success",
      createdAt: "2026-10-28T19:55:11Z", updatedAt: "2026-10-28T19:55:30Z", metadata: { jobId: JOB_ID },
    });
    expect(sharedBrowserFollowUp([browserTurn(), handBack], scope)).toBeNull();
  });

  it("continues no browser turn that failed, was stopped, still runs, or is not this person's on this browser", () => {
    for (const candidate of [
      browserTurn({ status: "failed" }),
      browserTurn({ status: "canceled" }),
      browserTurn({ status: "in_progress" }),
      browserTurn({}, { initiatingUserId: "00000000-0000-4000-8000-000000000099" }),
      browserTurn({}, { browserRuntimeId: "runtime-2" }),
      browserTurn({}, { browserTransport: "desktop-personal" }),
      browserTurn({}, { browserPageId: "closed-tab" }),
      browserTurn({ conversationId: "conversation-2" }),
      browserTurn({ id: "not-a-run-id" }),
    ]) {
      expect(sharedBrowserFollowUp([candidate], scope)).toBeNull();
    }
    expect(sharedBrowserFollowUp([browserTurn()], { ...scope, userId: null })).toBeNull();
    expect(sharedBrowserFollowUp([browserTurn()], { ...scope, runtimeId: null })).toBeNull();
    expect(sharedBrowserFollowUp([browserTurn()], { ...scope, pages: [] })).toBeNull();
  });
});
