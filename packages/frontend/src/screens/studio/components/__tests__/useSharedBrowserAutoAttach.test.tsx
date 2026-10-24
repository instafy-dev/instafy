// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SharedBrowserHostSnapshot } from "../../../../services/runtimeController/browserSession";

vi.mock("../../../../sdk/instafy", () => ({ controllerClient: { browserSessions: { fetchHost: vi.fn() } } }));

import { useSharedBrowserAutoAttach } from "../useSharedBrowserAutoAttach";
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

  function Harness({ open, off, writer }: { open: boolean; off: boolean; writer: boolean }) {
    const host = useSharedBrowserHostSnapshot({
      projectId: "project-1",
      runtimeId: "host-1",
      browserSessionId: "surface-1",
      enabled: writer || off,
      poll: off,
      fetchHost,
    });
    const attach = useSharedBrowserAutoAttach({ open, off, host });
    latest = { host, attach };
    return null;
  }
  async function render(props: { open?: boolean; off: boolean; writer?: boolean }) {
    await act(async () => {
      root.render(<Harness open={props.open ?? true} off={props.off} writer={props.writer ?? true} />);
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

  it("reads nothing and asks nothing while the view is not off", async () => {
    fetchHost.mockResolvedValue(snapshot({ state: "ready", generation: "generation-1", agentRunActive: true }));
    await render({ off: false });
    await advance(5 * SHARED_BROWSER_HOST_SNAPSHOT_POLL_MS);
    expect(fetchHost).not.toHaveBeenCalled();
    await act(async () => { await latest!.host.refresh({ force: true }); });
    expect(token()).toBe(0);
  });
});
