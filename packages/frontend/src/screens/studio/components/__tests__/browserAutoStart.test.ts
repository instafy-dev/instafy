import { beforeEach, describe, expect, it } from "vitest";
import type { ControllerRuntimeStatusEntry } from "../../../../services/runtimeController";
import {
  BROWSER_AUTO_START_COPY,
  browserAutoStartFailureReason,
  browserAutoStartPlan,
  browserAutoStartedRecently,
  claimBrowserAutoStart,
  forgetBrowserAutoStartsForTests,
  isBrowserAutoStartDeclined,
  markBrowserAutoStartDeclined,
  recordBrowserAutoStart,
  shouldAllowRoutineBrowsingForAutoStart,
  wasBrowserAutoStarted,
  type BrowserAutoStartPlanInput,
} from "../browserAutoStart";

const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = new Date().toISOString();

function runtime(overrides: Partial<ControllerRuntimeStatusEntry> = {}): ControllerRuntimeStatusEntry {
  return {
    runtimeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", status: "ready", provider: "instafy-cloud", idleTtlSeconds: 900,
    isLocal: false, isPreferred: true, health: "online", displayName: "hosted runtime", lastSeenAt: NOW, createdAt: NOW,
    ...overrides,
  };
}
const browserSession = runtime({
  runtimeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", displayName: "Browser session",
  origin: { originId: "origin-1", endpoint: "https://origin.test", protocols: ["http"] } as ControllerRuntimeStatusEntry["origin"],
});

function plan(overrides: Partial<BrowserAutoStartPlanInput> = {}) {
  return browserAutoStartPlan({
    transport: "shared", personalAvailable: false, personalOwnAi: false, projectId: PROJECT,
    runtimes: [runtime()], spaceBusy: false, boost: false, ...overrides,
  });
}

describe("browserAutoStartPlan", () => {
  it("reuses a browser session already running in this space, at no extra cost", () => {
    expect(plan({ runtimes: [runtime(), browserSession] })).toEqual({ kind: "reuse" });
  });

  it("opens the browser on this device for a person on their own AI", () => {
    expect(plan({ transport: "personal", personalAvailable: true, personalOwnAi: true })).toEqual({ kind: "personal" });
    expect(plan({ transport: "personal", personalAvailable: true, personalOwnAi: false }))
      .toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.personalNeedsOwnAi });
  });

  it("switches this space's one idle standard machine to the browser", () => {
    expect(plan()).toEqual({
      kind: "convert", runtimeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", projectId: PROJECT,
      provider: "instafy-cloud", displayName: "hosted runtime",
    });
    // A stopped machine is not this space's machine any more; starting one is a new slot.
    expect(plan({ runtimes: [runtime(), runtime({ runtimeId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", status: "stopped" })] }).kind)
      .toBe("convert");
  });

  it.each([
    ["the machine is busy or has queued work", { spaceBusy: true }, BROWSER_AUTO_START_COPY.stillWorking],
    ["the machine runs at Boost size", { boost: true }, BROWSER_AUTO_START_COPY.boost],
    ["there is no cloud machine in this space", { runtimes: [] }, BROWSER_AUTO_START_COPY.firstMachine],
    ["only a desktop or self-hosted machine runs here", {
      runtimes: [runtime({ provider: "desktop", isLocal: true }), runtime({ isPrivateSelfHosted: true })],
    }, BROWSER_AUTO_START_COPY.firstMachine],
    ["the space has several cloud machines", {
      runtimes: [runtime(), runtime({ runtimeId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" })],
    }, BROWSER_AUTO_START_COPY.anotherMachine],
    ["the machine is not this space's standard machine", { runtimes: [runtime({ displayName: "GPU worker" })] }, BROWSER_AUTO_START_COPY.secondMachine],
    ["several browser sessions are running", {
      runtimes: [browserSession, { ...browserSession, runtimeId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }],
    }, BROWSER_AUTO_START_COPY.severalSessions],
    ["the machine is still starting", { runtimes: [runtime({ status: "starting", health: "offline" })] }, BROWSER_AUTO_START_COPY.notReady],
    ["this space's runtimes are not known", { runtimes: null }, null],
  ] as const)("leaves the button when %s", (_name, overrides, reason) => {
    expect(plan(overrides as Partial<BrowserAutoStartPlanInput>)).toEqual({ kind: "button", reason });
  });

  it("explains a failed start without pressing anything else", () => {
    const limit = (blockerProjectId: string) => Object.assign(new Error("Runtime limit reached"), {
      code: "runtime_limit_reached",
      details: { activeCount: 1, maxActiveCount: 1, blockerProjectId, blockerRuntimeId: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
    });
    expect(browserAutoStartFailureReason(limit("99999999-9999-4999-8999-999999999999"), PROJECT))
      .toBe(BROWSER_AUTO_START_COPY.inUseElsewhere);
    expect(browserAutoStartFailureReason(limit(PROJECT), PROJECT)).toBe(BROWSER_AUTO_START_COPY.secondMachine);
    expect(browserAutoStartFailureReason(new Error("Out of credits."), PROJECT)).toBe("Out of credits.");
    expect(browserAutoStartFailureReason(null, PROJECT)).toBe(BROWSER_AUTO_START_COPY.timedOut);
  });

  it("writes its copy without em dashes", () => {
    for (const copy of Object.values(BROWSER_AUTO_START_COPY)) expect(copy).not.toMatch(/—/);
  });
});

describe("what this page remembers about automatic starts", () => {
  beforeEach(() => forgetBrowserAutoStartsForTests());

  it("claims a card once", () => {
    expect(claimBrowserAutoStart("job:1")).toBe(true);
    expect(claimBrowserAutoStart("job:1")).toBe(false);
    expect(claimBrowserAutoStart("")).toBe(false);
  });

  it("starts one card per conversation in ten minutes and remembers declines", () => {
    expect(wasBrowserAutoStarted("conversation")).toBe(false);
    recordBrowserAutoStart("conversation", 1_000);
    expect(wasBrowserAutoStarted("conversation")).toBe(true);
    expect(browserAutoStartedRecently("conversation", 1_000 + 9 * 60_000)).toBe(true);
    expect(browserAutoStartedRecently("conversation", 1_000 + 10 * 60_000)).toBe(false);
    expect(isBrowserAutoStartDeclined("conversation")).toBe(false);
    markBrowserAutoStartDeclined("conversation");
    expect(isBrowserAutoStartDeclined("conversation")).toBe(true);
    forgetBrowserAutoStartsForTests();
    expect(isBrowserAutoStartDeclined("conversation")).toBe(false);
  });
});

describe("routine browsing in a browser Octo opened by itself", () => {
  const request = { kind: "origin", runId: "run-1", initiatorUserId: "user-1", approvalId: "approval-1" };
  const input = {
    request, routineAvailable: true, currentUserId: "user-1",
    autoStartedRunIds: new Set(["run-1"]), alreadyDecidedApprovalId: null,
  };

  it("answers the first site prompt of a run it started, for the person who started it, once", () => {
    expect(shouldAllowRoutineBrowsingForAutoStart(input)).toBe(true);
    expect(shouldAllowRoutineBrowsingForAutoStart({ ...input, alreadyDecidedApprovalId: "approval-1" })).toBe(false);
  });

  it.each([
    ["an action prompt, such as a purchase or a submission", { request: { ...request, kind: "action" } }],
    ["a run the person started with a press or by typing", { autoStartedRunIds: new Set(["run-2"]) }],
    ["another person's run", { currentUserId: "user-2" }],
    ["a runtime that offers no routine browsing", { routineAvailable: false }],
    ["no prompt", { request: null }],
  ] as const)("leaves %s to the person", (_name, overrides) => {
    expect(shouldAllowRoutineBrowsingForAutoStart({ ...input, ...overrides })).toBe(false);
  });
});
