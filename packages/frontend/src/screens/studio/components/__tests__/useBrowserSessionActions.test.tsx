// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MutableRefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchActions } = vi.hoisted(() => ({ fetchActions: vi.fn() }));

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    browserSessions: {
      fetchActions: (...args: unknown[]) => fetchActions(...args),
      isUnavailableError: (error: unknown) =>
        error instanceof Error && error.name === "BrowserSessionUnavailableError",
    },
  },
}));

import { useBrowserSessionActions } from "../useBrowserSessionActions";

type HookResult = ReturnType<typeof useBrowserSessionActions>;
type HookOptions = Parameters<typeof useBrowserSessionActions>[0];

function action(overrides: Record<string, unknown>) {
  return {
    seq: 1,
    ts: 1,
    type: "navigate",
    label: "",
    url: null,
    x: null,
    y: null,
    viewportW: null,
    viewportH: null,
    ...overrides,
  };
}

function Harness({
  options,
  resultRef,
}: {
  options: HookOptions;
  resultRef: MutableRefObject<HookResult | null>;
}) {
  resultRef.current = useBrowserSessionActions(options);
  return null;
}

describe("useBrowserSessionActions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    fetchActions.mockReset();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const options: HookOptions = {
    enabled: true,
    browserSessionId: "browser-surface-1",
    projectId: "p1",
    preferRuntimeId: "rt-1",
  };

  async function render(renderOptions = options): Promise<MutableRefObject<HookResult | null>> {
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => {
      root.render(<Harness options={renderOptions} resultRef={resultRef} />);
    });
    return resultRef;
  }

  it("accumulates events, advances the byte cursor, and derives the latest click", async () => {
    fetchActions.mockResolvedValueOnce({
      actions: [action({ seq: 1, type: "navigate", label: "Go to x" })],
      cursor: 100,
    });
    const resultRef = await render();
    expect(resultRef.current?.actions.map((a) => a.seq)).toEqual([1]);
    expect(resultRef.current?.latestClick).toBeNull();

    // Next poll resumes from the previous cursor and appends the new click.
    fetchActions.mockResolvedValueOnce({
      actions: [action({ seq: 2, type: "click", label: "Click Apply", x: 40, y: 12, viewportH: 640 })],
      cursor: 250,
    });
    await act(async () => {
      await resultRef.current?.refresh();
    });
    expect(fetchActions).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projectId: "p1",
        browserSessionId: "browser-surface-1",
        preferRuntimeId: "rt-1",
        sinceCursor: 100,
      }),
    );
    expect(resultRef.current?.actions.map((a) => a.seq)).toEqual([1, 2]);
    expect(resultRef.current?.latestClick?.seq).toBe(2);
    expect(resultRef.current?.latestClick?.x).toBe(40);
  });

  it("resets the buffer when the cursor moves backward (new session truncated the log)", async () => {
    fetchActions.mockResolvedValueOnce({
      actions: [action({ seq: 1, type: "click", label: "old", x: 5, y: 5 })],
      cursor: 500,
    });
    const resultRef = await render();
    expect(resultRef.current?.actions).toHaveLength(1);

    // A smaller cursor means the log was truncated for a fresh session.
    fetchActions.mockResolvedValueOnce({
      actions: [action({ seq: 1, type: "navigate", label: "fresh session" })],
      cursor: 40,
    });
    await act(async () => {
      await resultRef.current?.refresh();
    });
    expect(resultRef.current?.actions.map((a) => a.label)).toEqual(["fresh session"]);
    expect(resultRef.current?.latestClick).toBeNull();
  });

  it("re-syncs from the start when the runtime changes (offsets are per-runtime)", async () => {
    fetchActions.mockResolvedValue({
      actions: [action({ seq: 1, type: "navigate", label: "old runtime" })],
      cursor: 900,
    });
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => {
      root.render(<Harness options={options} resultRef={resultRef} />);
    });
    expect(fetchActions).toHaveBeenLastCalledWith(expect.objectContaining({ sinceCursor: 0 }));

    // Switch runtime — the next fetch must start from 0, not the stale 900.
    fetchActions.mockClear();
    fetchActions.mockResolvedValue({ actions: [], cursor: 0 });
    await act(async () => {
      root.render(<Harness options={{ ...options, preferRuntimeId: "rt-2" }} resultRef={resultRef} />);
    });
    expect(fetchActions).toHaveBeenCalledWith(
      expect.objectContaining({ preferRuntimeId: "rt-2", sinceCursor: 0 }),
    );
  });

  it("suspends further polling once the session reports unavailable", async () => {
    const unavailable = new Error("gone");
    unavailable.name = "BrowserSessionUnavailableError";
    fetchActions.mockRejectedValueOnce(unavailable);
    const onUnavailable = vi.fn();

    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => {
      root.render(
        <Harness options={{ ...options, onUnavailable, suspendOnUnavailable: true }} resultRef={resultRef} />,
      );
    });
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(resultRef.current?.actions).toEqual([]);

    // Suspended: a subsequent refresh must not hit the network again.
    fetchActions.mockClear();
    await act(async () => {
      await resultRef.current?.refresh();
    });
    expect(fetchActions).not.toHaveBeenCalled();
  });

  it("scopes cursor and ticker to the exact selected page, including identical URLs", async () => {
    fetchActions.mockResolvedValue({
      actions: [
        action({ seq: 1, pageId: "page-1", type: "click", url: "https://same.test", x: 10, y: 20 }),
        action({ seq: 2, pageId: "page-2", type: "click", url: "https://same.test", x: 40, y: 50 }),
        action({ seq: 3, type: "click", url: "https://same.test", x: 70, y: 80 }),
      ],
      cursor: 300,
    });
    const resultRef = await render({ ...options, pageId: "page-1" });
    expect(resultRef.current?.actions.map((item) => item.seq)).toEqual([1]);
    expect(resultRef.current?.latestClick?.seq).toBe(1);

    // Switching pages filters the same buffer immediately; it does not poll
    // again, reset the runtime cursor, or flash another page's latest click.
    fetchActions.mockClear();
    await act(async () => {
      root.render(<Harness options={{ ...options, pageId: "page-2" }} resultRef={resultRef} />);
    });
    expect(resultRef.current?.actions.map((item) => item.seq)).toEqual([2]);
    expect(resultRef.current?.latestClick?.seq).toBe(2);
    expect(fetchActions).not.toHaveBeenCalled();
    fetchActions.mockResolvedValueOnce({ actions: [], cursor: 300 });
    await act(async () => { await resultRef.current?.refresh(); });
    expect(fetchActions).toHaveBeenLastCalledWith(expect.objectContaining({ sinceCursor: 300 }));

    await act(async () => {
      root.render(<Harness options={{ ...options, pageId: null }} resultRef={resultRef} />);
    });
    expect(resultRef.current?.actions).toEqual([]);
    expect(resultRef.current?.latestClick).toBeNull();
  });

  it("never polls a hidden transport and resumes when the mounted surface becomes visible", async () => {
    vi.useFakeTimers();
    fetchActions.mockResolvedValue({ actions: [action({ seq: 1 })], cursor: 100 });
    const resultRef = await render({ ...options, transportActive: false });
    await act(async () => {
      await resultRef.current?.refresh();
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(fetchActions).not.toHaveBeenCalled();
    expect(resultRef.current?.actions).toEqual([]);

    await act(async () => {
      root.render(<Harness options={{ ...options, transportActive: true }} resultRef={resultRef} />);
    });
    expect(fetchActions).toHaveBeenCalledTimes(1);
    expect(resultRef.current?.actions).toHaveLength(1);
    await act(async () => {
      root.render(<Harness options={{ ...options, transportActive: false }} resultRef={resultRef} />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(fetchActions).toHaveBeenCalledTimes(1);
    expect(resultRef.current?.actions).toEqual([]);
  });

  it("ignores an in-flight response after hiding the surface", async () => {
    let resolveFetch!: (value: unknown) => void;
    fetchActions.mockReturnValueOnce(new Promise((resolve) => { resolveFetch = resolve; }));
    const resultRef = await render();
    await act(async () => {
      root.render(<Harness options={{ ...options, transportActive: false }} resultRef={resultRef} />);
    });
    await act(async () => {
      resolveFetch({ actions: [action({ seq: 9, type: "click", x: 1, y: 2 })], cursor: 999 });
    });
    expect(resultRef.current?.actions).toEqual([]);
    expect(resultRef.current?.latestClick).toBeNull();
  });

  it("does not let a late previous-runtime response overwrite the new runtime cursor", async () => {
    let resolveFetch!: (value: unknown) => void;
    fetchActions.mockReturnValueOnce(new Promise((resolve) => { resolveFetch = resolve; }));
    const resultRef = await render();
    fetchActions.mockResolvedValue({ actions: [action({ seq: 2 })], cursor: 200 });
    await act(async () => {
      root.render(<Harness options={{ ...options, preferRuntimeId: "rt-2" }} resultRef={resultRef} />);
    });
    await act(async () => {
      resolveFetch({ actions: [action({ seq: 9 })], cursor: 999 });
    });
    expect(resultRef.current?.actions.map((item) => item.seq)).toEqual([2]);
    await act(async () => { await resultRef.current?.refresh(); });
    expect(fetchActions).toHaveBeenLastCalledWith(
      expect.objectContaining({ preferRuntimeId: "rt-2", sinceCursor: 200 }),
    );
  });

  it("keeps at most one poll in flight per runtime generation", async () => {
    vi.useFakeTimers();
    let resolveFetch!: (value: unknown) => void;
    fetchActions.mockReturnValueOnce(new Promise((resolve) => { resolveFetch = resolve; }));
    const resultRef = await render();
    await act(async () => {
      await resultRef.current?.refresh();
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(fetchActions).toHaveBeenCalledTimes(1);
    await act(async () => { resolveFetch({ actions: [action({ seq: 1 })], cursor: 100 }); });
    expect(resultRef.current?.actions.map((item) => item.seq)).toEqual([1]);
  });
});
