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
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const options: HookOptions = {
    enabled: true,
    browserSessionId: "browser-surface-1",
    projectId: "p1",
    preferRuntimeId: "rt-1",
  };

  async function render(): Promise<MutableRefObject<HookResult | null>> {
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => {
      root.render(<Harness options={options} resultRef={resultRef} />);
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
});
