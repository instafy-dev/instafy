import { describe, expect, it } from "vitest";
import type { SharedBrowserHostSnapshot } from "../../../../services/runtimeController/browserSession";
import { BROWSER_CHROME_STATE_LABELS } from "../BrowserChromeShell";
import {
  HOSTED_BROWSER_SETUP_COPY,
  HOSTED_BROWSER_VIEW_ACTION,
  hostedBrowserStartedByOther,
  hostedBrowserViewState,
  type HostedBrowserFailure,
} from "../hostedBrowserViewState";
import { SHARED_BROWSER_HOST_COPY } from "../sharedBrowserHostAttach";

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
