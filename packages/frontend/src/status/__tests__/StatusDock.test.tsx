/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNSTABLE_ToastQueue } from "react-aria-components";
import { Status } from "../Status";
import { StatusDock } from "../StatusDock";
import { StatusContext, StatusProvider, type StatusContextValue, type StatusToast } from "../StatusProvider";
import { useStatus } from "../useStatus";

describe("native browser status dock", () => {
  let root: Root;
  let container: HTMLDivElement;
  let status: StatusContextValue;
  let callerRenders: number;
  function Caller() { status = useStatus(); callerRenders += 1; return null; }
  function Harness({ first = true, second = false, mounted = true }: { first?: boolean; second?: boolean; mounted?: boolean }) {
    return <><button data-testid="editor">Editor</button>
      {mounted ? <div data-testid="first"><StatusDock active={first} ownerKey="first" /></div> : null}
      <div data-testid="second"><StatusDock active={second} ownerKey="second" /></div>
      <Status />
    </>;
  }
  const caller = <Caller />;
  const render = async (first = true, second = false, mounted = true) => {
    await act(async () => root.render(<StatusProvider>{caller}<Harness first={first} second={second} mounted={mounted} /></StatusProvider>));
  };
  const toast = () => document.querySelector<HTMLElement>('[data-testid="status-toast"]');

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    callerRenders = 0;
    container = document.createElement("div"); document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    // Check before replaceChildren: cleanup must not hide a leaked body portal.
    expect([...document.body.children]).toEqual([container]);
    container.remove(); document.body.replaceChildren();
    vi.useRealTimers(); delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("puts the existing interactive region in the dock and collapses it after dismissal", async () => {
    await render();
    const action = vi.fn();
    await act(async () => status.showStatus("Needs attention", "warning", 0, { actionLabel: "Retry", onAction: action }));
    expect(toast()?.closest('[data-testid="first"]')).not.toBeNull();
    expect(toast()?.getAttribute("role")).toBe("alertdialog");
    expect(toast()?.getAttribute("aria-modal")).toBe("false");
    expect(document.querySelectorAll('[data-testid="status-toast"]')).toHaveLength(1);
    await act(async () => [...document.querySelectorAll("button")].find(button => button.textContent === "Retry")!.click());
    expect(action).toHaveBeenCalledTimes(1);
    expect(toast()).toBeNull();
    expect(document.querySelector('[data-testid="status-dock"] [role="region"]')).toBeNull();
    expect(document.querySelector('[data-testid="status-dock"]')?.textContent).toBe("");
  });

  it("moves a focused notice between dock and body without replacing it or losing restoration", async () => {
    await render(false);
    const editor = document.querySelector<HTMLButtonElement>('[data-testid="editor"]')!;
    editor.focus();
    await act(async () => status.showStatus("Persistent error", "error", 0));
    const notice = toast();
    const dismiss = document.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification"]')!;
    await act(async () => dismiss.focus());
    await render(true);
    expect(toast()).toBe(notice);
    expect(document.activeElement).toBe(dismiss);
    await render(false);
    expect(toast()).toBe(notice);
    expect(document.activeElement).toBe(dismiss);
    await act(async () => dismiss.click());
    expect(document.activeElement).toBe(editor);
  });

  it("keeps a timed toast's elapsed time when placement changes", async () => {
    await render(false);
    await act(async () => status.showStatus("Timed warning", "warning", 5000));
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    await render(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(toast()).toBeNull();
  });

  it("preserves a focused control when its owning pane unmounts", async () => {
    await render();
    const editor = document.querySelector<HTMLButtonElement>('[data-testid="editor"]')!;
    editor.focus();
    await act(async () => status.showStatus("Persistent error", "error", 0));
    const dismiss = document.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification"]')!;
    await act(async () => dismiss.focus());
    await render(false, false, false);
    expect(document.activeElement).toBe(dismiss);
    expect(dismiss.closest('[data-testid="status-dock"]')).toBeNull();
    await act(async () => dismiss.click());
    expect(document.activeElement).toBe(editor);
  });

  it("uses the newest owner and does not let older cleanup remove its dock", async () => {
    await render();
    const initialRenders = callerRenders;
    await act(async () => status.showStatus("Copied", "success", 2200, { presentation: "confirmation" }));
    expect(toast()?.closest('[data-testid="first"]')).not.toBeNull();
    await render(true, true);
    expect(toast()?.closest('[data-testid="second"]')).not.toBeNull();
    await render(false, true);
    expect(toast()?.closest('[data-testid="second"]')).not.toBeNull();
    await render(false, false);
    expect(toast()?.closest('[data-testid="status-dock"]')).toBeNull();
    expect(callerRenders).toBe(initialRenders);
    await act(async () => { await vi.advanceTimersByTimeAsync(2200); });
    expect(toast()).toBeNull();
  });

  it("does not move another provider's notices into a native dock", async () => {
    let otherStatus: StatusContextValue;
    const Other = () => { otherStatus = useStatus(); return <Status />; };
    await act(async () => root.render(<>
      <StatusProvider>{caller}<Harness /></StatusProvider>
      <StatusProvider><Other /></StatusProvider>
    </>));
    await act(async () => {
      status.showStatus("Native workspace warning", "warning", 0);
      otherStatus.showStatus("Other workspace warning", "warning", 0);
    });
    const notices = [...document.querySelectorAll('[data-testid="status-toast"]')];
    expect(notices).toHaveLength(2);
    expect(notices.find(notice => notice.textContent?.includes("Native workspace"))?.closest('[data-testid="status-dock"]')).not.toBeNull();
    expect(notices.find(notice => notice.textContent?.includes("Other workspace"))?.closest('[data-testid="status-dock"]')).toBeNull();
  });

  it("keeps standalone StatusContext consumers attached to the body", async () => {
    const queue = new UNSTABLE_ToastQueue<StatusToast>({ maxVisibleToasts: 1 });
    await act(async () => root.render(<StatusContext.Provider value={{ queue, showStatus: () => {}, hideStatus: () => {} }}><Status /></StatusContext.Provider>));
    await act(async () => { queue.add({ message: "Standalone notification", intent: "warning", presentation: "default" }); });
    expect(toast()?.textContent).toBe("Standalone notification");
    expect(toast()?.isConnected).toBe(true);
    expect(toast()?.closest('[data-testid="status-dock"]')).toBeNull();
  });
});
