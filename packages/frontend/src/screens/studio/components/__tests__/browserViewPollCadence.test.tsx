// @vitest-environment jsdom
//
// The browser view's three pollers (action log, approval lane, page list) at
// the cadences measurement B (a live, idle, docked browser: 34 + 18 + 14 reads
// in 33 s) asked for: fast only while a run is active, the agent controls or a
// prompt is shown; a slow safety read otherwise; nothing while hidden.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchActions: vi.fn(),
  fetchPendingApproval: vi.fn(),
  decideApproval: vi.fn(),
  fetchPages: vi.fn(),
  fetchCapabilities: vi.fn(),
  commandPage: vi.fn(),
  focusPage: vi.fn(),
}));

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    browserSessions: {
      fetchActions: (...args: unknown[]) => mocks.fetchActions(...args),
      fetchPendingApproval: (...args: unknown[]) => mocks.fetchPendingApproval(...args),
      decideApproval: (...args: unknown[]) => mocks.decideApproval(...args),
      fetchPages: (...args: unknown[]) => mocks.fetchPages(...args),
      fetchCapabilities: (...args: unknown[]) => mocks.fetchCapabilities(...args),
      commandPage: (...args: unknown[]) => mocks.commandPage(...args),
      focusPage: (...args: unknown[]) => mocks.focusPage(...args),
      isCapabilitiesIncompatibleError: () => false,
      isUnavailableError: () => false,
    },
  },
}));

import { useBrowserSessionActions } from "../useBrowserSessionActions";
import { useSharedBrowserApproval } from "../useSharedBrowserApproval";
import { useBrowserSessionPages } from "../useBrowserSessionPages";

const RUNTIME_ID = "11111111-1111-4111-8111-111111111111";
const APPROVAL_RTT_MS = 400;

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => state === "hidden" });
  document.dispatchEvent(new Event("visibilitychange"));
}

function touch() {
  window.dispatchEvent(new Event("pointerdown"));
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(10_000_000);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.fetchActions.mockResolvedValue({ actions: [], cursor: 0 });
  mocks.fetchPendingApproval.mockImplementation(
    () => new Promise((resolve) => setTimeout(() => resolve(null), APPROVAL_RTT_MS)),
  );
  mocks.fetchPages.mockResolvedValue([
    { id: "page-1", url: "https://example.test/", host: "example.test", label: "Example", title: "Example", isActive: true, canGoBack: false, canGoForward: false },
  ]);
  mocks.fetchCapabilities.mockResolvedValue({ viewerKinds: ["cdp-screencast"] });
  setVisibility("visible");
  touch(); // the person was here a moment ago: gate "active"
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  setVisibility("visible");
  vi.useRealTimers();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

async function advance(ms: number, stepMs = 100) {
  for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(stepMs);
    });
  }
}

function Actions({ agentActive }: { agentActive: boolean }) {
  useBrowserSessionActions({ enabled: true, browserSessionId: "s", projectId: "p", preferRuntimeId: RUNTIME_ID, pageId: "page-1", transportActive: true, agentActive });
  return null;
}
function Approval({ runActive }: { runActive: boolean }) {
  useSharedBrowserApproval({ active: true, projectId: "p", browserSessionId: "s", runtimeId: RUNTIME_ID, browserPageId: "page-1", originEndpoint: "https://o.test", originAccessToken: "t", runActive });
  return null;
}
function Pages({ pollFast, surfaceVisible = true }: { pollFast: boolean; surfaceVisible?: boolean }) {
  useBrowserSessionPages({ enabled: true, browserSessionId: "s", projectId: "p", preferRuntimeId: RUNTIME_ID, includePlaceholder: true, pollPages: true, pollFast, surfaceVisible });
  return null;
}

describe("browser view poll cadence", () => {
  it("reads the action log every 10 s and approvals every 15 s with no run (measurement B)", async () => {
    await act(async () => root.render(<><Actions agentActive={false} /><Approval runActive={false} /><Pages pollFast={false} /></>));
    await advance(33_000);
    const a = mocks.fetchActions.mock.calls.length;
    const p = mocks.fetchPendingApproval.mock.calls.length;
    const g = mocks.fetchPages.mock.calls.length;
    expect(a).toBe(4); // 0, 10, 20, 30 s
    expect(p).toBe(3); // 0, 15.4, 30.8 s
    // 2.5 s while visible and the person is around, then every 5 s while the
    // tabs come back unchanged: 0, 2.5, 7.5 … 32.5 s.
    expect(g).toBe(8);
  });

  it("person away three minutes: actions 30 s, approval 30 s, pages 15 s", async () => {
    await act(async () => root.render(<><Actions agentActive={false} /><Approval runActive={false} /><Pages pollFast={false} /></>));
    await advance(181_000, 500);
    for (const m of Object.values(mocks)) m.mockClear();
    await advance(60_000, 500);
    const a = mocks.fetchActions.mock.calls.length;
    const p = mocks.fetchPendingApproval.mock.calls.length;
    const g = mocks.fetchPages.mock.calls.length;
    expect(a).toBe(2);
    expect(p).toBe(2);
    expect(g).toBe(4);
  });

  // Live test, Oct 27: one Studio tab made about 4,900 requests in 30 min,
  // most of them while a run drove Instafy's browser. Between its actions the
  // agent is thinking, and the tail read an empty log every second.
  it("run active with nothing new: approvals keep 1.5 s, the action log backs off to 4 s and the tabs to 5 s, even with no input for minutes", async () => {
    await act(async () => root.render(<><Actions agentActive /><Approval runActive /><Pages pollFast /></>));
    await advance(200_000, 500); // no input: gate goes idle, fast must not care
    for (const m of Object.values(mocks)) m.mockClear();
    await advance(33_000);
    const a = mocks.fetchActions.mock.calls.length;
    const p = mocks.fetchPendingApproval.mock.calls.length;
    const g = mocks.fetchPages.mock.calls.length;
    expect(a).toBeGreaterThanOrEqual(8);
    expect(a).toBeLessThanOrEqual(9);
    expect(p).toBeGreaterThanOrEqual(17);
    expect(g).toBeGreaterThanOrEqual(6);
    expect(g).toBeLessThanOrEqual(7);
  });

  it("run active: a new action brings back the 1 s tail at once, and a quiet log backs off 1, 2, 4 s", async () => {
    let cursor = 0;
    let pending = 0;
    mocks.fetchActions.mockImplementation(async () => {
      if (pending > 0) {
        pending -= 1;
        cursor += 10;
        return { actions: [{ seq: cursor, ts: cursor, pageId: "page-1", type: "click", label: "Click", url: null, x: 1, y: 1, viewportW: 10, viewportH: 10 }], cursor };
      }
      return { actions: [], cursor };
    });
    await act(async () => root.render(<Actions agentActive />));
    await advance(30_000);
    const times = () => mocks.fetchActions.mock.invocationCallOrder.length;
    mocks.fetchActions.mockClear();
    await advance(12_000);
    // Quiet for a while: every 4 s.
    expect(times()).toBe(3);
    // The agent acts: the next read (at most 4 s later) finds it, and the
    // tail is back to 1 s while it keeps acting.
    pending = 6;
    await advance(4_000);
    expect(cursor).toBeGreaterThan(0);
    mocks.fetchActions.mockClear();
    await advance(4_000);
    expect(times()).toBe(4);
  });

  it("a changed tab list brings back the 2.5 s page reads", async () => {
    await act(async () => root.render(<Pages pollFast />));
    await advance(60_000);
    mocks.fetchPages.mockClear();
    await advance(10_000);
    expect(mocks.fetchPages.mock.calls.length).toBe(2); // unchanged: every 5 s
    let url = 0;
    mocks.fetchPages.mockImplementation(async () => {
      url += 1;
      return [{ id: "page-1", url: `https://example.test/${url}`, host: "example.test", label: "Example", title: "Example", isActive: true, canGoBack: true, canGoForward: false }];
    });
    mocks.fetchPages.mockClear();
    await advance(10_000);
    expect(mocks.fetchPages.mock.calls.length).toBeGreaterThanOrEqual(4); // changing: every 2.5 s
  });

  it("a run starting reads at once and then fast: an approval raised 300 ms later shows within ~2 s", async () => {
    await act(async () => root.render(<><Actions agentActive={false} /><Approval runActive={false} /></>));
    await advance(5_000);
    mocks.fetchActions.mockClear();
    mocks.fetchPendingApproval.mockClear();
    await act(async () => root.render(<><Actions agentActive /><Approval runActive /></>));
    await advance(100);
    expect(mocks.fetchActions).toHaveBeenCalledTimes(1);
    // Read at once on the rising edge, then 1.5 s after each answer.
    await advance(2_400);
    const approvalTimes = mocks.fetchPendingApproval.mock.calls.length;
    expect(approvalTimes).toBeGreaterThanOrEqual(2);
  });

  it("a run ending takes one trailing actions read, then slows; the buffer is kept", async () => {
    let cursor = 0;
    mocks.fetchActions.mockImplementation(async ({ sinceCursor }: { sinceCursor: number }) => {
      if (sinceCursor === 0) {
        cursor = 100;
        return { actions: [{ seq: 1, ts: 1, pageId: "page-1", type: "human_input", label: "Human input needed", url: null, x: null, y: null, viewportW: null, viewportH: null }], cursor };
      }
      return { actions: [], cursor };
    });
    let latest: ReturnType<typeof useBrowserSessionActions> | null = null;
    function Probe({ agentActive }: { agentActive: boolean }) {
      latest = useBrowserSessionActions({ enabled: true, browserSessionId: "s", projectId: "p", preferRuntimeId: RUNTIME_ID, pageId: "page-1", transportActive: true, agentActive });
      return null;
    }
    await act(async () => root.render(<Probe agentActive />));
    await advance(3_000);
    const before = mocks.fetchActions.mock.calls.length;
    await act(async () => root.render(<Probe agentActive={false} />));
    await advance(100);
    expect(mocks.fetchActions.mock.calls.length).toBe(before + 1); // trailing read
    expect(latest!.actions.map((x) => x.type)).toEqual(["human_input"]); // not reset
    await advance(9_800);
    expect(mocks.fetchActions.mock.calls.length).toBe(before + 1);
    await advance(200);
    expect(mocks.fetchActions.mock.calls.length).toBe(before + 2);
    const lastSince = (mocks.fetchActions.mock.calls.at(-1)?.[0] as { sinceCursor: number }).sinceCursor;
    expect(lastSince).toBe(100); // still tailing, not re-reading from 0
  });

  it("a visible prompt survives runActive going false, and keeps the 400 ms cadence", async () => {
    const live = {
      runtimeId: RUNTIME_ID,
      request: {
        version: 1, approvalId: "22222222-2222-4222-8222-222222222222", kind: "action", ownerId: "o", runId: "r",
        initiatorUserId: "u", browserPageId: "page-1", operation: "click", sourceOrigin: null, destinationOrigin: null,
        destinationFingerprint: "a", snapshotId: null, targetFingerprint: null, payloadFingerprint: null,
        requestedAtMs: Date.now(), expiresAtMs: Date.now() + 600_000, requestFingerprint: "f",
        display: { label: "click", destinationOrigin: null },
      },
    };
    mocks.fetchPendingApproval.mockResolvedValue(live);
    let latest: ReturnType<typeof useSharedBrowserApproval> | null = null;
    function Probe({ runActive }: { runActive: boolean }) {
      latest = useSharedBrowserApproval({ active: true, projectId: "p", browserSessionId: "s", runtimeId: RUNTIME_ID, browserPageId: "page-1", originEndpoint: "https://o.test", originAccessToken: "t", runActive });
      return null;
    }
    await act(async () => root.render(<Probe runActive />));
    await advance(100);
    expect(latest!.pending?.request.approvalId).toBe(live.request.approvalId);
    await act(async () => root.render(<Probe runActive={false} />));
    expect(latest!.pending?.request.approvalId).toBe(live.request.approvalId);
    mocks.fetchPendingApproval.mockClear();
    await advance(4_000);
    expect(mocks.fetchPendingApproval.mock.calls.length).toBe(10);
  });

  it("hidden: no reads at all; visible again: one read at once, then the cadence", async () => {
    await act(async () => root.render(<><Actions agentActive /><Approval runActive /><Pages pollFast /></>));
    await advance(1_000);
    setVisibility("hidden");
    await advance(1_000);
    for (const m of Object.values(mocks)) m.mockClear();
    await advance(60_000, 500);
    const hidden = [mocks.fetchActions, mocks.fetchPendingApproval, mocks.fetchPages].map((m) => m.mock.calls.length);
    expect(hidden).toEqual([0, 0, 0]);
    setVisibility("visible");
    await advance(100);
    const woke = [mocks.fetchActions, mocks.fetchPendingApproval, mocks.fetchPages].map((m) => m.mock.calls.length);
    expect(woke).toEqual([1, 1, 1]);
  });

  it("a run starting or ending in a hidden tab reads nothing until the tab is visible again", async () => {
    await act(async () => root.render(<><Actions agentActive={false} /><Approval runActive={false} /></>));
    await advance(1_000);
    setVisibility("hidden");
    await advance(1_000);
    mocks.fetchActions.mockClear();
    mocks.fetchPendingApproval.mockClear();
    const reads = () => [mocks.fetchActions, mocks.fetchPendingApproval].map((m) => m.mock.calls.length);
    await act(async () => root.render(<><Actions agentActive /><Approval runActive /></>));
    await advance(5_000);
    await act(async () => root.render(<><Actions agentActive={false} /><Approval runActive={false} /></>));
    await advance(5_000);
    expect(reads()).toEqual([0, 0]);
    // The return reads both at once, which also covers the run's trailing read.
    setVisibility("visible");
    await advance(100);
    expect(reads()).toEqual([1, 1]);
  });

  it("pages while the browser surface is not on screen and nothing runs: every 15 s", async () => {
    await act(async () => root.render(<Pages pollFast={false} surfaceVisible={false} />));
    await advance(60_000, 500);
    expect(mocks.fetchPages.mock.calls.length).toBe(5);
  });
  it("does not read more on quick visibility flips", async () => {
    await act(async () => root.render(<><Actions agentActive={false} /><Approval runActive={false} /><Pages pollFast={false} /></>));
    for (let flip = 0; flip < 14; flip += 1) {
      setVisibility("hidden");
      await advance(2_300);
      setVisibility("visible");
      await advance(2_300);
    }
    // Reads happen only when due on a visible moment: never more than the
    // steady cadence over the same 64.4 s (7, 5 and 26).
    expect(mocks.fetchActions.mock.calls.length).toBeLessThanOrEqual(7);
    expect(mocks.fetchPendingApproval.mock.calls.length).toBeLessThanOrEqual(5);
    expect(mocks.fetchPages.mock.calls.length).toBeLessThanOrEqual(26);
  });
});
