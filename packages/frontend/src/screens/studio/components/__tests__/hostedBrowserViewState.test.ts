import { describe, expect, it } from "vitest";
import type { SharedBrowserHostSnapshot } from "../../../../services/runtimeController/browserSession";
import { BROWSER_CHROME_STATE_LABELS } from "../BrowserChromeShell";
import {
  HOSTED_BROWSER_SETUP_COPY,
  HOSTED_BROWSER_VIEW_ACTION,
  hostedBrowserAttachAfterLateMachine,
  hostedBrowserAttachWhileOff,
  hostedBrowserPagesActive,
  hostedBrowserStartedByOther,
  hostedBrowserViewState,
  type HostedBrowserFailure,
} from "../hostedBrowserViewState";
import { SHARED_BROWSER_HOST_COPY, SPACE_MACHINE_LATE_READY_WINDOW_MS } from "../sharedBrowserHostAttach";

type Status = Parameters<typeof hostedBrowserViewState>[0]["status"];

const view = (status: Status, failure: HostedBrowserFailure | null = null, hasConnection = false) =>
  hostedBrowserViewState({ status, failure, hasConnection });

describe("hostedBrowserViewState", () => {
  it.each([
    ["connected with a connection", view("connected", null, true), { kind: "live", sentence: null, action: null }],
    ["connected without one (it looks the browser up again)", view("connected"), { kind: "opening", sentence: SHARED_BROWSER_HOST_COPY.opening, action: null }],
    ["idle", view("idle"), { kind: "opening", sentence: SHARED_BROWSER_HOST_COPY.opening, action: null }],
    ["selecting", view("selecting"), { kind: "opening", sentence: SHARED_BROWSER_HOST_COPY.opening, action: null }],
    ["connecting with a connection", view("connecting", null, true), { kind: "opening", sentence: SHARED_BROWSER_HOST_COPY.opening, action: null }],
    ["off", view("error", { kind: "off", reason: "space machine not running" }),
      { kind: "off", sentence: "Instafy's browser is off.", action: "Open browser" }],
    ["failed", view("error", { kind: "failed", reason: "origin grant refused (403)" }),
      { kind: "failed", sentence: "Instafy's browser did not open. Try again.", action: "Try again" }],
    ["an error without a kind", view("error"),
      { kind: "failed", sentence: "Instafy's browser did not open. Try again.", action: "Try again" }],
    ["the machine did not start", view("error", { kind: "machine", reason: "space machine ensure failed" }),
      { kind: "failed", sentence: "This space's machine did not start. Try again.", action: "Try again" }],
    ["policy off", view("error", { kind: "blocked", reason: SHARED_BROWSER_HOST_COPY.policyOff }),
      { kind: "blocked", sentence: "Instafy's browser is turned off for this space.", action: null }],
    ["a viewer with an idle browser", view("error", { kind: "blocked", reason: SHARED_BROWSER_HOST_COPY.askBuilder }),
      { kind: "blocked", sentence: "Ask a space builder to open Instafy's browser.", action: null }],
    ["poisoned", view("error", { kind: "blocked", reason: SHARED_BROWSER_HOST_COPY.poisoned }),
      { kind: "blocked", sentence: SHARED_BROWSER_HOST_COPY.poisoned, action: null }],
    ["a plain notice", view("error", { kind: "notice", reason: "No Shared session is available. Ask a space builder to start one." }),
      { kind: "failed", sentence: "No Shared session is available. Ask a space builder to start one.", action: "Try again" }],
    ["a missing provider", view("error", { kind: "failed", reason: "provider 'test-cloud' is not configured on this controller" }),
      { kind: "failed", sentence: HOSTED_BROWSER_SETUP_COPY, action: "Try again" }],
  ] as const)("%s", (_name, state, expected) => {
    expect(state).toEqual(expected);
  });

  it("says the space's machine is still starting once its start has taken over a minute, and only while opening", () => {
    const slow = (status: Status, failure: HostedBrowserFailure | null = null, hasConnection = false) =>
      hostedBrowserViewState({ status, failure, hasConnection, machineStartSlow: true });
    expect(slow("connecting")).toEqual({ kind: "opening", sentence: "Still starting this space's machine…", action: null });
    expect(slow("idle")).toEqual({ kind: "opening", sentence: SHARED_BROWSER_HOST_COPY.stillStartingMachine, action: null });
    // The pill and the action follow the kind, which does not change.
    expect(slow("connected", null, true)).toEqual({ kind: "live", sentence: null, action: null });
    expect(slow("error", { kind: "machine", reason: "space machine did not come up in time" })).toEqual(
      { kind: "failed", sentence: SHARED_BROWSER_HOST_COPY.machineDidNotStart, action: "Try again" });
    expect(hostedBrowserViewState({ status: "connecting", failure: null, hasConnection: false, machineStartSlow: false }).sentence)
      .toBe(SHARED_BROWSER_HOST_COPY.opening);
  });

  it("says a boot-time browser is starting again while the machine restarts it, and why it cannot open once it gave up", () => {
    expect(hostedBrowserViewState({ status: "connecting", failure: null, hasConnection: false, browserRestarting: true }))
      .toEqual({ kind: "opening", sentence: "Instafy's browser stopped. Starting it again…", action: null });
    expect(hostedBrowserViewState({
      status: "error",
      failure: { kind: "blocked", reason: SHARED_BROWSER_HOST_COPY.stoppedForGood },
      hasConnection: false,
      browserRestarting: true,
    })).toEqual({
      kind: "blocked",
      sentence: "Instafy's browser stopped and did not start again. Restart this space's machine to open it.",
      action: null,
    });
  });

  it("never shows a raw reason as its sentence unless the reason is a sentence of its own", () => {
    for (const kind of ["off", "failed", "machine"] as const) {
      const state = view("error", { kind, reason: "Browser session is unavailable (origin token request failed)." });
      expect(state.sentence).not.toContain("origin token");
    }
  });

  it("writes all of its copy short, plain and without em dashes", () => {
    const copy = [
      ...Object.values(SHARED_BROWSER_HOST_COPY),
      ...Object.values(HOSTED_BROWSER_VIEW_ACTION),
      HOSTED_BROWSER_SETUP_COPY,
      ...Object.values(BROWSER_CHROME_STATE_LABELS),
    ];
    for (const text of copy) {
      expect(text).not.toMatch(/[—–]/);
      expect(text).not.toMatch(/Click Retry|Press Retry/);
    }
    // One sentence per state the view shows (the setup notice keeps its two).
    for (const text of Object.values(SHARED_BROWSER_HOST_COPY)) {
      expect(text.split(/(?<=[.…])\s+/).filter(Boolean).length).toBeLessThanOrEqual(2);
    }
  });
});

const snapshot = (overrides: Partial<SharedBrowserHostSnapshot> = {}): SharedBrowserHostSnapshot => ({
  version: 1, mode: "lazy", state: "ready", generation: "gen-1", failure: null, startedByYou: false,
  othersPresent: false, controlledByOther: false, agentRunActive: false, agentRunStartedByYou: false, ...overrides,
});

describe("hostedBrowserStartedByOther", () => {
  it("notices an agent or another viewer running the browser", () => {
    expect(hostedBrowserStartedByOther(snapshot({ agentRunActive: true }), undefined)).toBe(true);
    expect(hostedBrowserStartedByOther(snapshot({ state: "starting", othersPresent: true }), undefined)).toBe(true);
    expect(hostedBrowserStartedByOther(snapshot({ controlledByOther: true }), undefined)).toBe(true);
  });

  it("leaves a browser nobody uses, or one that is not running, to a press", () => {
    expect(hostedBrowserStartedByOther(snapshot(), undefined)).toBe(false);
    expect(hostedBrowserStartedByOther(snapshot({ state: "idle", agentRunActive: true }), undefined)).toBe(false);
    expect(hostedBrowserStartedByOther(snapshot({ state: "failed", othersPresent: true }), undefined)).toBe(false);
    expect(hostedBrowserStartedByOther(null, undefined)).toBe(false);
  });

  it("attaches to each run of the browser once", () => {
    expect(hostedBrowserStartedByOther(snapshot({ agentRunActive: true }), "gen-1")).toBe(false);
    expect(hostedBrowserStartedByOther(snapshot({ agentRunActive: true, generation: "gen-2" }), "gen-1")).toBe(true);
  });
});

describe("hostedBrowserAttachWhileOff", () => {
  const offAt = 1_000_000;
  const input = (overrides: Partial<Parameters<typeof hostedBrowserAttachWhileOff>[0]> = {}) => ({
    off: true, snapshot: snapshot({ agentRunActive: true }), fetchedAtMs: offAt, offSinceMs: offAt,
    attachedGeneration: undefined, ...overrides,
  });

  it("attaches on a reading asked for since the view went off", () => {
    expect(hostedBrowserAttachWhileOff(input())).toBe(true);
    expect(hostedBrowserAttachWhileOff(input({ fetchedAtMs: offAt + 10_000 }))).toBe(true);
  });

  it("never attaches on a reading from before the view went off, or without one", () => {
    // It may show a run that has ended, or one from before the machine restarted.
    expect(hostedBrowserAttachWhileOff(input({ fetchedAtMs: offAt - 1 }))).toBe(false);
    expect(hostedBrowserAttachWhileOff(input({ fetchedAtMs: null }))).toBe(false);
    expect(hostedBrowserAttachWhileOff(input({ offSinceMs: null }))).toBe(false);
  });

  it("attaches only while off, to a browser someone else runs, once per run", () => {
    expect(hostedBrowserAttachWhileOff(input({ off: false }))).toBe(false);
    expect(hostedBrowserAttachWhileOff(input({ snapshot: snapshot() }))).toBe(false);
    expect(hostedBrowserAttachWhileOff(input({ attachedGeneration: "gen-1" }))).toBe(false);
    expect(hostedBrowserAttachWhileOff(input({ attachedGeneration: "gen-0" }))).toBe(true);
  });
});

describe("hostedBrowserAttachAfterLateMachine", () => {
  const failedAt = 1_000_000;
  const input = (overrides: Partial<Parameters<typeof hostedBrowserAttachAfterLateMachine>[0]> = {}) => ({
    kind: "failed" as const, error: { message: SHARED_BROWSER_HOST_COPY.machineDidNotStart, atMs: failedAt },
    hostRuntimeId: "space", nowMs: failedAt + 60_000, attachedForAtMs: null, ...overrides,
  });

  it("attaches once the machine a press gave up on is a live host, within five minutes of the failure", () => {
    expect(hostedBrowserAttachAfterLateMachine(input())).toBe(true);
    expect(hostedBrowserAttachAfterLateMachine(input({ nowMs: failedAt + SPACE_MACHINE_LATE_READY_WINDOW_MS }))).toBe(true);
    expect(SPACE_MACHINE_LATE_READY_WINDOW_MS).toBe(5 * 60_000);
  });

  it("never attaches after the window, twice for one failure, or before the machine is a live host", () => {
    expect(hostedBrowserAttachAfterLateMachine(input({ nowMs: failedAt + SPACE_MACHINE_LATE_READY_WINDOW_MS + 1 }))).toBe(false);
    expect(hostedBrowserAttachAfterLateMachine(input({ attachedForAtMs: failedAt }))).toBe(false);
    expect(hostedBrowserAttachAfterLateMachine(input({ attachedForAtMs: failedAt - 1 }))).toBe(true);
    expect(hostedBrowserAttachAfterLateMachine(input({ hostRuntimeId: null }))).toBe(false);
  });

  it("only follows the machine's own failure, never a view that is off, blocked or failed otherwise", () => {
    for (const kind of ["off", "blocked", "opening", "live", null] as const) {
      expect(hostedBrowserAttachAfterLateMachine(input({ kind }))).toBe(false);
    }
    expect(hostedBrowserAttachAfterLateMachine(input({ error: { message: SHARED_BROWSER_HOST_COPY.didNotOpen, atMs: failedAt } }))).toBe(false);
    expect(hostedBrowserAttachAfterLateMachine(input({ error: null }))).toBe(false);
  });
});

describe("hostedBrowserPagesActive", () => {
  it.each([
    [null, true],
    ["opening", true],
    ["live", true],
    ["off", false],
    ["failed", false],
    ["blocked", false],
  ] as const)("reads the pages for a view that is %s: %s", (kind, expected) => {
    expect(hostedBrowserPagesActive(kind)).toBe(expected);
  });
});
