import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunRecord } from "../../../../types";
import type { RuntimeBrowserSessionAction } from "../../../../sdk/instafy";
import { browserPageOrigin, selectSharedBrowserHumanInput, sharedBrowserConversationRunIds, sharedBrowserTakeoverJob } from "../browserHandoffRouting";

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
