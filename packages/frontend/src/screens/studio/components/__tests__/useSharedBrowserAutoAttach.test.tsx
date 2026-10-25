// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SharedBrowserHostSnapshot } from "../../../../services/runtimeController/browserSession";

vi.mock("../../../../sdk/instafy", () => ({ controllerClient: { browserSessions: { fetchHost: vi.fn() } } }));

import type { HostedBrowserViewKind } from "../hostedBrowserViewState";
import { SHARED_BROWSER_HOST_COPY, SPACE_MACHINE_LATE_READY_WINDOW_MS } from "../sharedBrowserHostAttach";
import { sharedBrowserLateAttachInputs, useSharedBrowserAutoAttach } from "../useSharedBrowserAutoAttach";
import type { BrowserTransport } from "../usePersonalBrowserBridge";
import { SHARED_BROWSER_HOST_SNAPSHOT_POLL_MS, useSharedBrowserHostSnapshot } from "../useSharedBrowserHostSnapshot";

function snapshot(overrides: Partial<SharedBrowserHostSnapshot> = {}): SharedBrowserHostSnapshot {
  return { version: 1, mode: "lazy", state: "idle", generation: null, failure: null, startedByYou: false,
    othersPresent: false, controlledByOther: false, agentRunActive: false, agentRunStartedByYou: false, ...overrides };
}

/**
 * ChatPanel's wiring: the ten-second host reading (on for a writer, and
 * whenever the open view is off) feeding Studio's own attach requests.
 */
describe("useSharedBrowserAutoAttach", () => {
  let root: Root;
  let container: HTMLDivElement;
  const fetchHost = vi.fn<(params: unknown) => Promise<SharedBrowserHostSnapshot | null>>();
  let latest: {
    host: ReturnType<typeof useSharedBrowserHostSnapshot>;
    attach: ReturnType<typeof useSharedBrowserAutoAttach>;
  } | null = null;

  type View = { kind: HostedBrowserViewKind | null; error: { message: string; atMs: number } | null };
  /** As ChatPanel wires it when `transport` is set, else with `view` and `hostRuntimeId` as given. */
  function Harness({ open, off, writer, view, hostRuntimeId, transport }: {
    open: boolean; off: boolean; writer: boolean; view?: View; hostRuntimeId?: string | null; transport?: BrowserTransport;
  }) {
    const host = useSharedBrowserHostSnapshot({
      projectId: "project-1",
      runtimeId: "host-1",
      browserSessionId: "surface-1",
      enabled: writer || off,
      poll: off,
      fetchHost,
    });
    const attach = useSharedBrowserAutoAttach({
      open,
      off,
      host,
      ...(transport
        ? sharedBrowserLateAttachInputs({
          transport,
          kind: view?.kind ?? null,
          error: view?.error ?? null,
          hostRuntimeId: hostRuntimeId ?? null,
        })
        : { view, hostRuntimeId }),
    });
    latest = { host, attach };
    return null;
  }
  async function render(props: {
    open?: boolean; off: boolean; writer?: boolean; view?: View; hostRuntimeId?: string | null; transport?: BrowserTransport;
  }) {
    await act(async () => {
      root.render(<Harness open={props.open ?? true} off={props.off} writer={props.writer ?? true}
        view={props.view} hostRuntimeId={props.hostRuntimeId} transport={props.transport} />);
    });
    await advance(0);
  }
  async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
  const token = () => latest!.attach.autoAttachToken;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-24T09:00:00Z"));
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    latest = null;
    fetchHost.mockReset().mockResolvedValue(snapshot());
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    vi.restoreAllMocks(); vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("does not attach on a reading from before the view went off, and reads again at once", async () => {
    // Earlier, while an agent was browsing, Studio read the host to decide a card.
    fetchHost.mockResolvedValue(snapshot({ state: "ready", generation: "generation-1", agentRunActive: true }));
    await render({ off: false });
    await act(async () => { await latest!.host.refresh({ force: true }); });
    expect(latest!.host.snapshot?.agentRunActive).toBe(true);
    // Then the machine restarted, or the agent run ended: the browser is idle
    // and the view goes off.
    vi.setSystemTime(Date.now() + 60_000);
    fetchHost.mockClear().mockResolvedValue(snapshot());
    await render({ off: true });
    expect(fetchHost).toHaveBeenCalledTimes(1);
    expect(token()).toBe(0);
    await advance(5 * SHARED_BROWSER_HOST_SNAPSHOT_POLL_MS);
    expect(token()).toBe(0);
  });

  it("does not attach on a reading asked for before the view went off that answers after", async () => {
    let answerOld!: (value: SharedBrowserHostSnapshot) => void;
    fetchHost.mockImplementationOnce(() => new Promise((resolve) => { answerOld = resolve; }));
    await render({ off: false });
    let oldReading: Promise<unknown> = Promise.resolve();
    act(() => { oldReading = latest!.host.refresh({ force: true }); });
    vi.setSystemTime(Date.now() + 1_000);
    let answerNew!: (value: SharedBrowserHostSnapshot) => void;
    fetchHost.mockImplementationOnce(() => new Promise((resolve) => { answerNew = resolve; }));
    await render({ off: true });
    await act(async () => {
      answerOld(snapshot({ state: "ready", generation: "generation-1", agentRunActive: true }));
      await oldReading;
    });
    expect(latest!.host.snapshot?.agentRunActive).toBe(true);
    expect(token()).toBe(0);
    await act(async () => { answerNew(snapshot()); });
    expect(token()).toBe(0);
  });

  it("attaches once an agent or another viewer starts the browser while off, once per run", async () => {
    await render({ off: true });
    expect(token()).toBe(0);
    fetchHost.mockResolvedValue(snapshot({ state: "starting", generation: "generation-2", agentRunActive: true }));
    await advance(SHARED_BROWSER_HOST_SNAPSHOT_POLL_MS);
    expect(token()).toBe(1);
    // The same run does not ask again, also when the view goes off again.
    await advance(3 * SHARED_BROWSER_HOST_SNAPSHOT_POLL_MS);
    await render({ off: false });
    await render({ off: true });
    await advance(SHARED_BROWSER_HOST_SNAPSHOT_POLL_MS);
    expect(token()).toBe(1);
    // A new run does, at once from the reading taken when the view went off.
    await render({ off: false });
    fetchHost.mockResolvedValue(snapshot({ state: "ready", generation: "generation-3", othersPresent: true }));
    await render({ off: true });
    expect(token()).toBe(2);
  });

  it("notices it for a viewer too, whose reading starts when the view goes off", async () => {
    fetchHost.mockResolvedValue(snapshot({ state: "ready", generation: "generation-1", controlledByOther: true }));
    await render({ off: false, writer: false });
    expect(fetchHost).not.toHaveBeenCalled();
    await render({ off: true, writer: false });
    expect(fetchHost).toHaveBeenCalledTimes(1);
    expect(token()).toBe(1);
  });

  it("forgets the run it attached to once the view closes, and asks at once for a card", async () => {
    fetchHost.mockResolvedValue(snapshot({ state: "ready", generation: "generation-1", agentRunActive: true }));
    await render({ off: true });
    expect(token()).toBe(1);
    await render({ open: false, off: false });
    await render({ off: true });
    expect(token()).toBe(2);
    await render({ off: false });
    act(() => { latest!.attach.requestAutoAttach(); });
    expect(token()).toBe(3);
  });

  describe("after a press gave up on the space's machine", () => {
    const machineFailed = (atMs: number): View => ({
      kind: "failed", error: { message: SHARED_BROWSER_HOST_COPY.machineDidNotStart, atMs },
    });

    it("attaches exactly once when that machine becomes a live host within five minutes", async () => {
      const failedAt = Date.now();
      await render({ off: false, view: machineFailed(failedAt), hostRuntimeId: null });
      expect(token()).toBe(0);
      // A runtime status refresh shows the machine up four minutes later.
      vi.setSystemTime(failedAt + 4 * 60_000);
      await render({ off: false, view: machineFailed(failedAt), hostRuntimeId: "host-1" });
      expect(token()).toBe(1);
      await render({ off: false, view: machineFailed(failedAt), hostRuntimeId: "host-1" });
      await render({ off: false, view: machineFailed(failedAt), hostRuntimeId: null });
      await render({ off: false, view: machineFailed(failedAt), hostRuntimeId: "host-1" });
      expect(token()).toBe(1);
      // Studio's attempt never ends with the machine's sentence again.
      await render({ off: false, view: { kind: "opening", error: null }, hostRuntimeId: "host-1" });
      await render({ off: false, view: { kind: "failed", error: { message: SHARED_BROWSER_HOST_COPY.didNotOpen, atMs: Date.now() } }, hostRuntimeId: "host-1" });
      expect(token()).toBe(1);
      // No reading of its own: it rides runtime status refreshes.
      expect(fetchHost).not.toHaveBeenCalled();
    });

    it("attaches at once when the machine is already a live host as the view fails", async () => {
      await render({ off: false, view: machineFailed(Date.now()), hostRuntimeId: "host-1" });
      expect(token()).toBe(1);
    });

    it("never attaches once the window has passed", async () => {
      const failedAt = Date.now();
      await render({ off: false, view: machineFailed(failedAt), hostRuntimeId: null });
      vi.setSystemTime(failedAt + SPACE_MACHINE_LATE_READY_WINDOW_MS + 1_000);
      await render({ off: false, view: machineFailed(failedAt), hostRuntimeId: "host-1" });
      expect(token()).toBe(0);
    });

    it("attaches once through ChatPanel's inputs, and only while Instafy's browser is shown", async () => {
      const failedAt = Date.now();
      await render({ off: false, transport: "personal", view: machineFailed(failedAt), hostRuntimeId: "host-1" });
      expect(token()).toBe(0);
      await render({ off: false, transport: "shared", view: machineFailed(failedAt), hostRuntimeId: null });
      expect(token()).toBe(0);
      vi.setSystemTime(failedAt + 2 * 60_000);
      await render({ off: false, transport: "shared", view: machineFailed(failedAt), hostRuntimeId: "host-1" });
      expect(token()).toBe(1);
      await render({ off: false, transport: "shared", view: machineFailed(failedAt), hostRuntimeId: "host-1" });
      expect(token()).toBe(1);
    });

    it("never attaches while the view is off, blocked or closed", async () => {
      const error = { message: SHARED_BROWSER_HOST_COPY.machineDidNotStart, atMs: Date.now() };
      await render({ off: false, view: { kind: "blocked", error }, hostRuntimeId: "host-1" });
      await render({ off: false, view: { kind: "off", error }, hostRuntimeId: "host-1" });
      await render({ open: false, off: false, view: machineFailed(error.atMs), hostRuntimeId: "host-1" });
      await render({ off: false, view: undefined, hostRuntimeId: "host-1" });
      expect(token()).toBe(0);
    });
  });

  it("reads nothing and asks nothing while the view is not off", async () => {
    fetchHost.mockResolvedValue(snapshot({ state: "ready", generation: "generation-1", agentRunActive: true }));
    await render({ off: false });
    await advance(5 * SHARED_BROWSER_HOST_SNAPSHOT_POLL_MS);
    expect(fetchHost).not.toHaveBeenCalled();
    await act(async () => { await latest!.host.refresh({ force: true }); });
    expect(token()).toBe(0);
  });
});

describe("sharedBrowserLateAttachInputs", () => {
  const error = { message: SHARED_BROWSER_HOST_COPY.machineDidNotStart, atMs: 1 };

  it("hands on what Instafy's browser view shows and the conversation's live host", () => {
    expect(sharedBrowserLateAttachInputs({ transport: "shared", kind: "failed", error, hostRuntimeId: "host-1" }))
      .toEqual({ view: { kind: "failed", error }, hostRuntimeId: "host-1" });
    expect(sharedBrowserLateAttachInputs({ transport: "shared", kind: null, error: null, hostRuntimeId: null }))
      .toEqual({ view: { kind: null, error: null }, hostRuntimeId: null });
  });

  it("hands on nothing while the browser on this device is the one shown", () => {
    expect(sharedBrowserLateAttachInputs({ transport: "personal", kind: "failed", error, hostRuntimeId: "host-1" }))
      .toEqual({ view: undefined, hostRuntimeId: null });
  });
});
