// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SharedBrowserHostSnapshot } from "../../../../services/runtimeController/browserSession";

const { fetchHostMock } = vi.hoisted(() => ({ fetchHostMock: vi.fn() }));
vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: { browserSessions: { fetchHost: fetchHostMock } },
}));

import {
  SHARED_BROWSER_HOST_READ_TIMEOUT_MS,
  SHARED_BROWSER_HOST_REFRESH_MIN_GAP_MS,
  SHARED_BROWSER_HOST_SNAPSHOT_POLL_MS,
  useSharedBrowserHostSnapshot,
} from "../useSharedBrowserHostSnapshot";

type Options = Parameters<typeof useSharedBrowserHostSnapshot>[0];
type Result = ReturnType<typeof useSharedBrowserHostSnapshot>;

function snapshot(overrides: Partial<SharedBrowserHostSnapshot> = {}): SharedBrowserHostSnapshot {
  return { version: 1, mode: "lazy", state: "idle", generation: null, failure: null, startedByYou: false,
    othersPresent: false, controlledByOther: false, agentRunActive: false, agentRunStartedByYou: false, ...overrides };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("useSharedBrowserHostSnapshot", () => {
  let root: Root;
  let container: HTMLDivElement;
  let latest: Result | null;
  let options: Options;
  let visibility: DocumentVisibilityState;

  function Harness({ value }: { value: Options }) {
    latest = useSharedBrowserHostSnapshot(value);
    return null;
  }
  async function render() { await act(async () => root.render(<Harness value={{ ...options }} />)); }
  async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
  async function refresh(force = false) {
    let result: Awaited<ReturnType<Result["refresh"]>> | undefined;
    await act(async () => { result = await latest!.refresh(force ? { force: true } : undefined); });
    return result;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-20T12:00:00Z"));
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    latest = null;
    fetchHostMock.mockReset();
    fetchHostMock.mockResolvedValue(snapshot());
    options = { projectId: "project-1", runtimeId: "host-1", browserSessionId: "surface-1", enabled: true, poll: false };
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    vi.restoreAllMocks(); vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("reads the conversation machine's browser with the surface's session id", async () => {
    await render();
    expect(latest).toMatchObject({ snapshot: null, fetchedAtMs: null, receivedAtMs: null, failedAtMs: null });
    const reading = await refresh();
    expect(fetchHostMock).toHaveBeenCalledExactlyOnceWith({
      projectId: "project-1", runtimeId: "host-1", browserSessionId: "surface-1", signal: expect.any(AbortSignal),
    });
    expect(reading).toEqual({ snapshot: snapshot(), fetchedAtMs: Date.now(), receivedAtMs: Date.now() });
    expect(latest).toMatchObject({ snapshot: snapshot(), fetchedAtMs: Date.now(), receivedAtMs: Date.now() });
  });

  it("reads once at a time and at most every two seconds, unless forced", async () => {
    await render();
    const first = deferred<SharedBrowserHostSnapshot | null>();
    fetchHostMock.mockReturnValueOnce(first.promise);
    let a: Promise<unknown> | undefined;
    let b: Promise<unknown> | undefined;
    await act(async () => { a = latest!.refresh(); b = latest!.refresh(); });
    expect(fetchHostMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    await act(async () => { first.resolve(snapshot({ state: "starting" })); await a; });
    await refresh();
    expect(fetchHostMock).toHaveBeenCalledTimes(1);
    await advance(SHARED_BROWSER_HOST_REFRESH_MIN_GAP_MS);
    await refresh();
    expect(fetchHostMock).toHaveBeenCalledTimes(2);
    // Forced: now, even right after another reading.
    await refresh(true);
    expect(fetchHostMock).toHaveBeenCalledTimes(3);
  });

  it("reads now when forced while another reading is in flight, and the newest reading wins", async () => {
    await render();
    const slow = deferred<SharedBrowserHostSnapshot | null>();
    fetchHostMock.mockReturnValueOnce(slow.promise);
    let older: Promise<unknown> | undefined;
    await act(async () => { older = latest!.refresh(); });
    await advance(100);
    fetchHostMock.mockResolvedValueOnce(snapshot({ state: "ready" }));
    const forced = await refresh(true);
    expect(fetchHostMock).toHaveBeenCalledTimes(2);
    expect(forced).toMatchObject({ snapshot: { state: "ready" } });
    await act(async () => { slow.resolve(snapshot({ state: "idle" })); await older; });
    // The older reading lands last, but the newer one stays.
    expect(latest?.snapshot?.state).toBe("ready");
  });

  it("keeps the last reading when one fails, marks the failure, and reads a 404 as no browser", async () => {
    await render();
    await refresh();
    const fetchedAt = latest!.fetchedAtMs;
    fetchHostMock.mockRejectedValueOnce(new Error("502"));
    await advance(SHARED_BROWSER_HOST_REFRESH_MIN_GAP_MS);
    expect(await refresh()).toBeNull();
    // The failure changes what a waiting card reads, so it is decided again.
    expect(latest).toMatchObject({ snapshot: snapshot(), fetchedAtMs: fetchedAt, failedAtMs: Date.now() });
    fetchHostMock.mockResolvedValueOnce(null);
    await advance(SHARED_BROWSER_HOST_REFRESH_MIN_GAP_MS);
    expect(await refresh()).toEqual({ snapshot: null, fetchedAtMs: Date.now(), receivedAtMs: Date.now() });
    expect(latest).toMatchObject({ snapshot: null, fetchedAtMs: Date.now() });
  });

  it("marks every failure, and does not read again at once after one", async () => {
    fetchHostMock.mockRejectedValue(new Error("offline"));
    await render();
    expect(await refresh()).toBeNull();
    const firstFailure = latest!.failedAtMs;
    expect(firstFailure).toBe(Date.now());
    // Deciding the card again right after the failure does not read again.
    expect(await refresh()).toBeNull();
    expect(fetchHostMock).toHaveBeenCalledTimes(1);
    await advance(SHARED_BROWSER_HOST_REFRESH_MIN_GAP_MS);
    expect(await refresh()).toBeNull();
    expect(fetchHostMock).toHaveBeenCalledTimes(2);
    expect(latest!.failedAtMs).toBeGreaterThan(firstFailure!);
  });

  it("fails a reading that does not answer in ten seconds, so nothing waits on it", async () => {
    await render();
    fetchHostMock.mockReturnValueOnce(new Promise(() => {}));
    let result: Promise<unknown> | undefined;
    await act(async () => { result = latest!.refresh({ force: true }); });
    const signal = (fetchHostMock.mock.calls[0]![0] as { signal: AbortSignal }).signal;
    await advance(SHARED_BROWSER_HOST_READ_TIMEOUT_MS - 1);
    expect(signal.aborted).toBe(false);
    await advance(1);
    expect(signal.aborted).toBe(true);
    expect(await result).toBeNull();
    expect(latest!.failedAtMs).toBe(Date.now());
    // The next reading is not handed the hung one.
    await advance(SHARED_BROWSER_HOST_REFRESH_MIN_GAP_MS);
    expect(await refresh()).toMatchObject({ snapshot: snapshot() });
    expect(fetchHostMock).toHaveBeenCalledTimes(2);
  });

  it("measures a slow reading's age from when it arrived", async () => {
    await render();
    const slow = deferred<SharedBrowserHostSnapshot | null>();
    fetchHostMock.mockReturnValueOnce(slow.promise);
    const startedAt = Date.now();
    let result: Promise<unknown> | undefined;
    await act(async () => { result = latest!.refresh(); });
    await advance(6_000);
    await act(async () => { slow.resolve(snapshot({ state: "ready" })); await result; });
    expect(latest).toMatchObject({ fetchedAtMs: startedAt, receivedAtMs: startedAt + 6_000 });
  });

  it("polls every ten seconds only while a card waits and the page is visible", async () => {
    await render();
    await advance(SHARED_BROWSER_HOST_SNAPSHOT_POLL_MS * 2);
    expect(fetchHostMock).not.toHaveBeenCalled();
    options.poll = true; await render();
    await advance(SHARED_BROWSER_HOST_SNAPSHOT_POLL_MS);
    expect(fetchHostMock).toHaveBeenCalledTimes(1);
    visibility = "hidden";
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await advance(SHARED_BROWSER_HOST_SNAPSHOT_POLL_MS * 3);
    expect(fetchHostMock).toHaveBeenCalledTimes(1);
    visibility = "visible";
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await advance(SHARED_BROWSER_HOST_SNAPSHOT_POLL_MS);
    expect(fetchHostMock).toHaveBeenCalledTimes(2);
    options.poll = false; await render();
    await advance(SHARED_BROWSER_HOST_SNAPSHOT_POLL_MS * 3);
    expect(fetchHostMock).toHaveBeenCalledTimes(2);
  });

  it("never reads while disabled, and forgets a reading when the machine changes", async () => {
    options.enabled = false; await render();
    expect(await refresh(true)).toBeNull();
    expect(fetchHostMock).not.toHaveBeenCalled();
    options.enabled = true; await render();
    await refresh();
    expect(latest?.snapshot).not.toBeNull();
    options.runtimeId = "host-2"; await render();
    expect(latest).toMatchObject({ snapshot: null, fetchedAtMs: null });
    // A reading of the previous machine that lands late is dropped.
    const late = deferred<SharedBrowserHostSnapshot | null>();
    options.runtimeId = "host-1"; await render();
    fetchHostMock.mockReturnValueOnce(late.promise);
    let pending: Promise<unknown> | undefined;
    await act(async () => { pending = latest!.refresh({ force: true }); });
    options.runtimeId = "host-2"; await render();
    await act(async () => { late.resolve(snapshot({ state: "ready" })); await pending; });
    expect(await pending).toBeNull();
    expect(latest).toMatchObject({ snapshot: null, fetchedAtMs: null });
  });
});
