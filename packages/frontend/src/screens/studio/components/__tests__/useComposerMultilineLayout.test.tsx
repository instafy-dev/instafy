// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerMultilineLayout } from "../useComposerMultilineLayout";

class ControlledResizeObserver {
  static instances: ControlledResizeObserver[] = [];
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(private callback: ResizeObserverCallback) {
    ControlledResizeObserver.instances.push(this);
  }
  deliver() { this.callback([], this as unknown as ResizeObserver); }
}

class ControlledMutationObserver {
  static instances: ControlledMutationObserver[] = [];
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(private callback: MutationCallback) {
    ControlledMutationObserver.instances.push(this);
  }
  deliver() { this.callback([], this as unknown as MutationObserver); }
}

// Geometry only distinguishes an already-wrapped editor from a short draft.
// Real browser tests own line wrapping and the compact-width threshold.
const geometry = { rowWidth: 320, editorHeight: 60 };
const rowMeasurements = vi.fn();
const box = (width: number): DOMRect => ({
  x: 0, y: 0, top: 0, left: 0, right: width, bottom: 40, width, height: 40,
  toJSON: () => ({}),
});

function Harness({ enabled = true, revision = "initial" }: { enabled?: boolean; revision?: string }) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const multiline = useComposerMultilineLayout(rowRef, enabled);
  return (
    <div
      data-testid="row"
      data-multiline={String(multiline)}
      style={{ columnGap: 8 }}
      ref={(node) => {
        rowRef.current = node;
        if (node) node.getBoundingClientRect = () => {
          rowMeasurements();
          return box(geometry.rowWidth);
        };
      }}
    >
      <div data-testid="chat-composer-leading-controls" ref={(node) => {
        if (node) node.getBoundingClientRect = () => box(44);
      }} />
      <div
        key={revision}
        data-testid="chat-input"
        data-revision={revision}
        style={{ lineHeight: "20px", padding: "8px 0" }}
        ref={(node) => {
          if (node) Object.defineProperty(node, "scrollHeight", {
            configurable: true, get: () => geometry.editorHeight,
          });
        }}
      ><p>{revision}</p></div>
      <div data-testid="chat-composer-trailing-controls" ref={(node) => {
        if (node) node.getBoundingClientRect = () => box(44);
      }} />
    </div>
  );
}

describe("useComposerMultilineLayout lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let nextFrame: number;
  let frames: Map<number, FrameRequestCallback>;

  const currentResize = () => ControlledResizeObserver.instances.at(-1)!;
  const currentMutations = () => ControlledMutationObserver.instances.at(-1)!;
  const isMultiline = () => container.querySelector("[data-testid=row]")?.getAttribute("data-multiline");
  const render = async (enabled = true, revision = "initial") => {
    await act(async () => root!.render(<Harness enabled={enabled} revision={revision} />));
  };
  const flushFrame = async () => {
    const pending = [...frames.values()];
    frames.clear();
    await act(async () => { for (const callback of pending) callback(16); });
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    geometry.rowWidth = 320;
    geometry.editorHeight = 60;
    rowMeasurements.mockClear();
    ControlledResizeObserver.instances = [];
    ControlledMutationObserver.instances = [];
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
    vi.stubGlobal("MutationObserver", ControlledMutationObserver);
    frames = new Map();
    nextFrame = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
    vi.spyOn(document, "createRange").mockReturnValue({
      selectNodeContents: vi.fn(), getBoundingClientRect: () => box(20),
    } as unknown as Range);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("coalesces a burst of editor mutations and resizes into one measurement", async () => {
    await render();
    expect(isMultiline()).toBe("true");
    rowMeasurements.mockClear();
    geometry.editorHeight = 36;
    currentMutations().deliver();
    currentResize().deliver();
    currentMutations().deliver();
    expect(frames.size).toBe(1);
    expect(rowMeasurements).not.toHaveBeenCalled();
    await flushFrame();
    expect(rowMeasurements).toHaveBeenCalledOnce();
    expect(isMultiline()).toBe("false");
    expect(frames.size).toBe(0);
  });

  it("commits expansion and collapse before the queued frame callback returns", async () => {
    geometry.editorHeight = 36;
    await render();
    expect(isMultiline()).toBe("false");

    for (const [height, expected] of [[60, "true"], [36, "false"]] as const) {
      geometry.editorHeight = height;
      currentMutations().deliver();
      const [id, callback] = [...frames.entries()][0];
      frames.delete(id);
      act(() => {
        callback(16);
        // This assertion runs inside the same task, before act flushes its
        // queued React work. A deferred state update exposes the old row to
        // the browser's next paint even though the measurement is complete.
        expect(isMultiline()).toBe(expected);
      });
    }
  });

  it("releases scheduled work when disabled, reads the current editor on re-enable, and cleans up on unmount", async () => {
    await render();
    const oldEditor = container.querySelector('[data-testid="chat-input"]');
    const firstResize = currentResize();
    const firstMutations = currentMutations();
    firstMutations.deliver();
    const pendingOnDisable = [...frames.keys()][0];
    await render(false, "replacement");
    expect(firstResize.disconnect).toHaveBeenCalledOnce();
    expect(firstMutations.disconnect).toHaveBeenCalledOnce();
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(pendingOnDisable);
    expect(frames.size).toBe(0);
    expect(isMultiline()).toBe("false");

    geometry.editorHeight = 36;
    rowMeasurements.mockClear();
    await render(true, "replacement");
    const currentEditor = container.querySelector('[data-testid="chat-input"]');
    expect(currentEditor).not.toBe(oldEditor);
    expect(currentMutations().observe).toHaveBeenCalledWith(currentEditor, expect.any(Object));
    expect(rowMeasurements).toHaveBeenCalledOnce();
    expect(isMultiline()).toBe("false");
    const lastResize = currentResize();
    const lastMutations = currentMutations();
    lastResize.deliver();
    const pendingOnUnmount = [...frames.keys()][0];
    await act(async () => root!.unmount());
    root = null;
    expect(lastResize.disconnect).toHaveBeenCalledOnce();
    expect(lastMutations.disconnect).toHaveBeenCalledOnce();
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(pendingOnUnmount);
    expect(frames.size).toBe(0);
  });

  it("preserves layout while the row is hidden and measures again when visible", async () => {
    await render();
    expect(isMultiline()).toBe("true");
    geometry.rowWidth = 0;
    geometry.editorHeight = 36;
    currentResize().deliver();
    currentMutations().deliver();
    await flushFrame();
    expect(isMultiline()).toBe("true");
    geometry.rowWidth = 320;
    currentResize().deliver();
    await flushFrame();
    expect(isMultiline()).toBe("false");
  });
});
