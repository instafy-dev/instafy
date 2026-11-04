/** @vitest-environment jsdom */

import { act, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Status } from "../Status";
import {
  StatusProvider,
  type StatusContextValue,
} from "../StatusProvider";
import { useStatus } from "../useStatus";
import { MAX_PENDING_STATUS_TOASTS, PENDING_INFORMATION_MAX_AGE_MS, readableStatusDuration, statusBehavior } from "../statusBehavior";

let statusContext: StatusContextValue | null = null;
let callerRenders = 0;

function StatusHarness() {
  callerRenders += 1;
  statusContext = useStatus();
  return <><button type="button" data-testid="editor-action">Editor action</button><Status /></>;
}

describe("Status toast presentations", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    statusContext = null;
    callerRenders = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(
        <StatusProvider>
          <StatusHarness />
        </StatusProvider>,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("shows a polite, passive confirmation without adding a keyboard stop", async () => {
    const editorAction = document.querySelector<HTMLButtonElement>('[data-testid="editor-action"]')!;
    editorAction.focus();
    await act(async () => {
      statusContext?.showStatus("Link copied.", "success", 2200, {
        presentation: "confirmation",
      });
    });

    const toast = document.querySelector<HTMLElement>('[data-testid="status-toast"]')!;

    expect(toast.getAttribute("data-presentation")).toBe("confirmation");
    expect(toast.closest('[role="status"]')?.getAttribute("aria-live")).toBe("polite");
    expect(toast.querySelector('button, [tabindex], [role="alert"]')).toBeNull();
    expect(toast.hasAttribute("tabindex")).toBe(false);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(statusContext?.queue?.visibleToasts).toHaveLength(0);
    expect(document.querySelector('[aria-label="Dismiss notification"]')).toBeNull();
    toast.focus();
    expect(document.activeElement).toBe(editorAction);

    // Interactive toast focus/hover pauses the queue. A passive acknowledgement
    // still expires on schedule and never steals focus from the person's work.
    await act(async () => {
      toast.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      statusContext?.queue?.pauseAll();
      await vi.advanceTimersByTimeAsync(2200);
    });
    expect(document.querySelector('[data-testid="status-toast"]')).toBeNull();
    expect(document.activeElement).toBe(editorAction);
  });

  it("renders passive feedback without rerendering callers that only use status actions", async () => {
    const initialRenders = callerRenders;
    await act(async () => statusContext?.showStatus("Link copied.", "success", 2200, { presentation: "confirmation" }));
    expect(document.querySelector('[data-testid="status-toast"]')?.textContent).toBe("Link copied.");
    expect(callerRenders).toBe(initialRenders);
    await act(async () => { await vi.advanceTimersByTimeAsync(2200); });
    expect(document.querySelector('[data-testid="status-toast"]')).toBeNull();
    expect(callerRenders).toBe(initialRenders);
  });

  it("keeps warnings dismissable and full-sized", async () => {
    await act(async () => {
      statusContext?.showStatus("Connection needs attention.", "warning", 3500);
    });

    const toast = document.querySelector('[data-testid="status-toast"]');

    expect(toast?.getAttribute("data-presentation")).toBe("default");
    expect(toast?.getAttribute("role")).toBe("alertdialog");
    expect(toast?.className).toContain("pointer-events-auto");
    expect(document.querySelector('[aria-label="Dismiss notification"]')).not.toBeNull();
  });

  it.each([
    { name: "an error", intent: "error" as const, duration: 5000, options: {} },
    { name: "an Undo action", intent: "warning" as const, duration: 6000, options: { actionLabel: "Undo", onAction: vi.fn() } },
    { name: "a standing approval", intent: "info" as const, duration: 0, options: { actionLabel: "View", onAction: vi.fn(), nonPreemptive: true } },
  ])("suppresses copy feedback while $name is visible without delaying it", async ({ intent, duration, options }) => {
    const shown = vi.fn();
    const closed = vi.fn();
    await act(async () => statusContext?.showStatus("Needs attention.", intent, duration, options));
    const activeKey = statusContext?.queue?.visibleToasts[0]?.key;
    await act(async () => statusContext?.showStatus("Copied message.", "success", 2000, {
      id: "copy", presentation: "confirmation", onShow: shown, onClose: closed,
    }));
    expect(statusContext?.queue?.visibleToasts[0]?.key).toBe(activeKey);
    expect(document.querySelector('[data-testid="status-toast"]')?.textContent).toContain("Needs attention.");
    expect(shown).not.toHaveBeenCalled();
    await act(async () => {
      if (activeKey) statusContext?.queue?.close(activeKey);
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(document.querySelector('[data-testid="status-toast"]')).toBeNull();
    expect(shown).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
  });

  it("hides a passive confirmation by its id and cancels its timer", async () => {
    const closed = vi.fn();
    await act(async () => statusContext?.showStatus("Link copied.", "success", 2200, {
      id: "copy", presentation: "confirmation", onClose: closed,
    }));
    await act(async () => statusContext?.hideStatus("another-id"));
    expect(document.querySelector('[data-testid="status-toast"]')).not.toBeNull();
    await act(async () => statusContext?.hideStatus("copy"));
    expect(document.querySelector('[data-testid="status-toast"]')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(closed).toHaveBeenCalledOnce();
  });

  it("clears passive feedback when its owner clears all status", async () => {
    const closed = vi.fn();
    await act(async () => statusContext?.showStatus("Link copied.", "success", 2200, {
      id: "copy", presentation: "confirmation", onClose: closed,
    }));
    await act(async () => statusContext?.hideStatus());
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(document.querySelector('[data-testid="status-toast"]')).toBeNull();
    expect(closed).toHaveBeenCalledOnce();
  });

  it("replaces a confirmation without letting its old timer close the new one", async () => {
    const firstClosed = vi.fn();
    const secondClosed = vi.fn();
    await act(async () => statusContext?.showStatus("First copied.", "success", 2200, {
      presentation: "confirmation", onClose: firstClosed,
    }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await act(async () => statusContext?.showStatus("Second copied.", "success", 2200, {
      presentation: "confirmation", onClose: secondClosed,
    }));
    expect(firstClosed).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(document.querySelector('[data-testid="status-toast"]')?.textContent).toBe("Second copied.");
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(document.querySelector('[data-testid="status-toast"]')).toBeNull();
    expect(secondClosed).toHaveBeenCalledOnce();
  });

  it("lets an actionable toast replace passive feedback and keeps its action operable", async () => {
    const onAction = vi.fn();
    const closed = vi.fn();
    await act(async () => statusContext?.showStatus("Link copied.", "success", 2200, {
      presentation: "confirmation", onClose: closed,
    }));
    await act(async () => statusContext?.showStatus("Moved to Trash.", "warning", 6000, { actionLabel: "Undo", onAction }));
    expect(closed).toHaveBeenCalledOnce();
    expect(document.querySelectorAll('[data-testid="status-toast"]')).toHaveLength(1);
    const action = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="status-toast"] button')].find(button => button.textContent === "Undo")!;
    await act(async () => action.click());
    expect(onAction).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-testid="status-toast"]')).toBeNull();
  });

  it("falls back to the default presentation when a confirmation has an action", async () => {
    await act(async () => {
      statusContext?.showStatus("Import complete.", "success", 3500, {
        actionLabel: "Open",
        onAction: vi.fn(),
        presentation: "confirmation",
      });
    });

    const toast = document.querySelector('[data-testid="status-toast"]');

    expect(toast?.getAttribute("data-presentation")).toBe("default");
    expect(document.querySelector('[aria-label="Dismiss notification"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Open");
  });

  it("queues a non-preemptive background alert behind a visible warning", async () => {
    await act(async () => {
      statusContext?.showStatus("Publishing failed.", "error", 0);
      statusContext?.showStatus("Your support report was resolved.", "success", 12_000, {
        id: "support-resolution:report-1",
        actionLabel: "View report",
        nonPreemptive: true,
        onAction: vi.fn(),
      });
    });

    expect(document.body.textContent).toContain("Publishing failed.");
    expect(document.body.textContent).not.toContain("Your support report was resolved.");
    expect(statusContext?.queue?.visibleToasts).toHaveLength(1);

    await act(async () => {
      const current = statusContext?.queue?.visibleToasts[0];
      if (current) statusContext?.queue?.close(current.key);
    });

    expect(document.body.textContent).not.toContain("Publishing failed.");
    expect(document.body.textContent).toContain("Your support report was resolved.");
    expect(document.body.textContent).toContain("View report");
  });
  it("calls onShow only after a queued notification becomes visible", async () => {
    const shown = vi.fn();
    await act(async () => {
      statusContext?.showStatus("An active error.", "error", 0, { id: "error" });
      statusContext?.showStatus("A new notification.", "info", 10000, {
        id: "notification", forceVisible: true, nonPreemptive: true, onShow: shown,
      });
    });
    expect(shown).not.toHaveBeenCalled();
    await act(async () => statusContext?.hideStatus("error"));
    expect(shown).toHaveBeenCalledOnce();
  });

  it("keeps the next background notification reachable after suppressed confirmations", async () => {
    const shown = vi.fn();
    await act(async () => {
      statusContext?.showStatus("An active error.", "error", 0, { id: "error" });
      statusContext?.showStatus("A new notification.", "info", 0, {
        id: "notification", actionLabel: "View", onAction: vi.fn(), nonPreemptive: true, onShow: shown,
      });
      statusContext?.showStatus("Copied message.", "success", 2000, { presentation: "confirmation" });
      statusContext?.hideStatus("error");
    });
    expect(shown).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-testid="status-toast"]')?.textContent).toBe("A new notification.View");
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(document.querySelector('[data-testid="status-toast"]')?.textContent).toBe("A new notification.View");
  });

  it("keeps a waiting background action in place until its owner clears it", async () => {
    const closed = vi.fn();
    const shown = vi.fn();
    const text = () => [...document.querySelectorAll('[data-testid="status-toast"]')].map((toast) => toast.textContent);
    await act(async () => {
      statusContext?.showStatus("Octo is waiting for your OK in “Porto”.", "info", 0, {
        id: "waiting", actionLabel: "View", onAction: vi.fn(), nonPreemptive: true, onClose: closed, onShow: shown,
      });
    });
    expect(text()).toEqual(["Octo is waiting for your OK in “Porto”.View"]);
    await act(async () => {
      statusContext?.showStatus("Connection interrupted.", "warning", 2000);
    });
    expect(text()).toEqual(["Octo is waiting for your OK in “Porto”.View"]);
    expect(closed).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(text()).toEqual(["Octo is waiting for your OK in “Porto”.View"]);
    expect(shown).toHaveBeenCalledTimes(1);

    // Pending errors have priority over ordinary queued information.
    await act(async () => {
      statusContext?.showStatus("Publishing failed.", "error", 0);
      statusContext?.hideStatus("waiting");
    });
    expect(closed).toHaveBeenCalledOnce();
    expect(text()).toEqual(["Publishing failed."]);
    await act(async () => {
      const current = statusContext?.queue?.visibleToasts[0];
      if (current) statusContext?.queue?.close(current.key);
    });
    expect(text()).toEqual(["Connection interrupted."]);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(text()).toEqual([]);
  });

  it("keeps a waiting background toast closed once the person closes it", async () => {
    await act(async () => {
      statusContext?.showStatus("Octo is waiting for your OK in “Porto”.", "info", 0, {
        id: "waiting", actionLabel: "View", onAction: vi.fn(), nonPreemptive: true,
      });
    });
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification"]')!.click());
    await act(async () => {
      statusContext?.showStatus("Connection interrupted.", "warning", 2000);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(document.querySelector('[data-testid="status-toast"]')).toBeNull();
  });

  it("does not let an ordinary warning remove a timed background action", async () => {
    await act(async () => {
      statusContext?.showStatus("There is a new reply in “Porto”.", "info", 10_000, {
        id: "reply", actionLabel: "View", onAction: vi.fn(), nonPreemptive: true,
      });
      statusContext?.showStatus("Connection interrupted.", "warning", 2000);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(document.querySelector('[data-testid="status-toast"]')?.textContent).toBe("There is a new reply in “Porto”.View");
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(document.querySelector('[data-testid="status-toast"]')?.textContent).toBe("Connection interrupted.");
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(document.querySelector('[data-testid="status-toast"]')).toBeNull();
  });

  it("does not acknowledge a queued toast removed during signout", async () => {
    const shown = vi.fn();
    await act(async () => {
      statusContext?.showStatus("An active error.", "error", 0, { id: "error" });
      statusContext?.showStatus("Old account notification.", "info", 10000, {
        id: "notification", forceVisible: true, nonPreemptive: true, onShow: shown,
      });
      statusContext?.hideStatus("notification");
      statusContext?.hideStatus("error");
    });
    expect(shown).not.toHaveBeenCalled();
  });

  it("pauses a replacement that inherits focus, then resumes its full reading budget", async () => {
    await act(async () => statusContext?.showStatus("First warning", "warning", 5000, { id: "updating" }));
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      document.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification"]')!.focus();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    const focusedButton = document.activeElement;
    await act(async () => statusContext?.showStatus("Replacement warning", "warning", 5000, { id: "updating" }));
    const replacement = document.querySelector('[data-testid="status-toast"]')!;
    expect(replacement.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(focusedButton);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(document.body.textContent).toContain("Replacement warning");
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="editor-action"]')!.focus());
    await act(async () => { await vi.advanceTimersByTimeAsync(4999); });
    expect(document.body.textContent).toContain("Replacement warning");
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(document.querySelector('[data-testid="status-toast"]')).toBeNull();
  });

  it("counts only foreground reading time without extending explicit durations", async () => {
    await act(async () => statusContext?.showStatus("Readable information", "info", 2000, { behavior: statusBehavior.informational }));
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    await act(async () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(document.body.textContent).toContain("Readable information");
    await act(async () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(1299); });
    expect(document.body.textContent).toContain("Readable information");
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(document.querySelector('[data-testid="status-toast"]')).toBeNull();
  });

  it("waits for a clipped notice to become fully visible before counting reading time", async () => {
    let updateIntersection: IntersectionObserverCallback;
    const disconnect = vi.fn();
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) { updateIntersection = callback; }
      observe() {}
      disconnect = disconnect;
    });
    const intersect = (ratio: number) => updateIntersection([{ isIntersecting: ratio > 0, intersectionRatio: ratio } as IntersectionObserverEntry], {} as IntersectionObserver);
    await act(async () => statusContext?.showStatus("Clipped information", "info", 2000, { behavior: statusBehavior.informational }));
    await act(async () => intersect(0.5));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(document.body.textContent).toContain("Clipped information");
    await act(async () => intersect(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    await act(async () => intersect(0));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    await act(async () => intersect(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
    expect(document.querySelector('[data-testid="status-toast"]')).toBeNull();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("pauses for mouse hover at the primitive DOM boundary", async () => {
    await act(async () => statusContext?.showStatus("Hover information", "info", 2000, { behavior: statusBehavior.informational }));
    const notice = document.querySelector<HTMLElement>('[data-testid="status-toast"]')!;
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    await act(async () => notice.dispatchEvent(new MouseEvent("pointerenter")));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(document.body.textContent).toContain("Hover information");
    await act(async () => notice.dispatchEvent(new MouseEvent("pointerleave")));
    await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
    expect(document.querySelector('[data-testid="status-toast"]')).toBeNull();
  });

  it("pauses when the software keyboard clips the visual viewport independently of layout", async () => {
    const viewport = new EventTarget();
    Object.assign(viewport, { offsetTop: 0, offsetLeft: 0, width: 320, height: 600 });
    vi.stubGlobal("visualViewport", viewport);
    await act(async () => statusContext?.showStatus("Keyboard information", "info", 2000, { behavior: statusBehavior.informational }));
    const notice = document.querySelector<HTMLElement>('[data-testid="status-toast"]')!;
    notice.getBoundingClientRect = () => ({ top: 80, bottom: 160, left: 16, right: 304, width: 288, height: 80, x: 16, y: 80, toJSON: () => ({}) });
    await act(async () => viewport.dispatchEvent(new Event("resize")));
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    await act(async () => {
      Object.assign(viewport, { height: 70 });
      viewport.dispatchEvent(new Event("resize"));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(document.body.textContent).toContain("Keyboard information");
    await act(async () => {
      Object.assign(viewport, { height: 600 });
      viewport.dispatchEvent(new Event("resize"));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
    expect(document.querySelector('[data-testid="status-toast"]')).toBeNull();
  });

  it("uses readable defaults only when opted in and leaves action-required notices persistent", async () => {
    const longMessage = Array(50).fill("information").join(" ");
    await act(async () => statusContext?.showStatus(longMessage, "info", undefined, { behavior: statusBehavior.informational }));
    expect(statusContext?.queue?.visibleToasts[0]?.content.readingDuration).toBe(readableStatusDuration(longMessage));
    await act(async () => statusContext?.hideStatus());
    await act(async () => statusContext?.showStatus(longMessage, "warning"));
    expect(statusContext?.queue?.visibleToasts[0]?.content.readingDuration).toBe(5000);
    await act(async () => statusContext?.hideStatus());
    await act(async () => statusContext?.showStatus("Owner-scoped approval", "info", 1000, { id: "approval", behavior: statusBehavior.actionRequired }));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(document.body.textContent).toContain("Owner-scoped approval");
    await act(async () => statusContext?.hideStatus("approval"));
    expect(document.querySelector('[data-testid="status-toast"]')).toBeNull();
  });

  it("expires a deadline action while focused and hidden without extending its offer", async () => {
    const action = vi.fn();
    const closed = vi.fn();
    await act(async () => statusContext?.showStatus("Moved to Trash", "warning", 6000, {
      actionLabel: "Undo", onAction: action, onClose: closed, behavior: statusBehavior.deadline(Date.now() + 6000),
    }));
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification"]')!.focus());
    await act(async () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(document.querySelector('[data-testid="status-toast"]')).toBeNull();
    expect(action).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledOnce();
  });

  it("rejects a deadline action after a suspended browser clock passes expiry", async () => {
    const action = vi.fn();
    await act(async () => statusContext?.showStatus("Moved to Trash", "warning", 6000, {
      actionLabel: "Undo", onAction: action, behavior: statusBehavior.deadline(Date.now() + 6000),
    }));
    // Advancing wall time without running callbacks models throttled background timers.
    vi.setSystemTime(Date.now() + 6001);
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Undo")!.click());
    expect(action).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="status-toast"]')).toBeNull();
  });

  it("never presents a queued deadline after it expires", async () => {
    const shown = vi.fn();
    const closed = vi.fn();
    await act(async () => {
      statusContext?.showStatus("Active error", "error", 0, { id: "error" });
      statusContext?.showStatus("Undo offer", "warning", 6000, {
        actionLabel: "Undo", onAction: vi.fn(), onShow: shown, onClose: closed, behavior: statusBehavior.deadline(Date.now() + 6000),
      });
      await vi.advanceTimersByTimeAsync(6000);
      statusContext?.hideStatus("error");
    });
    expect(document.querySelector('[data-testid="status-toast"]')).toBeNull();
    expect(shown).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledOnce();
  });

  it("protects errors and Undo from ordinary replacement, then drains by priority", async () => {
    await act(async () => {
      statusContext?.showStatus("Undo offer", "warning", 6000, { id: "undo", actionLabel: "Undo", onAction: vi.fn(), behavior: statusBehavior.deadline(Date.now() + 6000) });
      statusContext?.showStatus("Ordinary warning", "warning", 2000);
      statusContext?.showStatus("An error", "error", 0, { id: "error" });
    });
    expect(document.querySelector('[data-testid="status-toast"]')?.textContent).toContain("Undo offer");
    await act(async () => statusContext?.hideStatus("undo"));
    expect(document.querySelector('[data-testid="status-toast"]')?.textContent).toBe("An error");
    await act(async () => statusContext?.showStatus("Routine information", "info", 2000, { behavior: statusBehavior.informational }));
    expect(document.querySelector('[data-testid="status-toast"]')?.textContent).toBe("An error");
    await act(async () => statusContext?.hideStatus("error"));
    expect(document.querySelector('[data-testid="status-toast"]')?.textContent).toBe("Ordinary warning");
  });

  it("bounds pending information, deduplicates it, and closes evictions exactly once", async () => {
    const closed = Array.from({ length: 7 }, () => vi.fn());
    const shown = Array.from({ length: 7 }, () => vi.fn());
    const duplicateShown = vi.fn();
    await act(async () => {
      statusContext?.showStatus("Active error", "error", 0, { id: "error" });
      for (let index = 0; index < 7; index++) statusContext?.showStatus(`Information ${index}`, "info", 2000, {
        id: `info-${index}`, behavior: statusBehavior.informational, onClose: closed[index], onShow: shown[index],
      });
      statusContext?.showStatus("Information 6", "info", 2000, { id: "info-6", behavior: statusBehavior.informational, onShow: duplicateShown });
    });
    expect(closed.filter(callback => callback.mock.calls.length)).toHaveLength(7 - MAX_PENDING_STATUS_TOASTS);
    expect(shown.every(callback => callback.mock.calls.length === 0)).toBe(true);
    await act(async () => statusContext?.hideStatus("error"));
    expect(document.querySelector('[data-testid="status-toast"]')?.textContent).toBe("Information 2");
    await act(async () => statusContext?.hideStatus());
    expect(closed.every(callback => callback.mock.calls.length === 1)).toBe(true);
    expect(duplicateShown).not.toHaveBeenCalled();
  });

  it("drops stale queued information without announcing or marking it shown", async () => {
    const shown = vi.fn();
    const closed = vi.fn();
    await act(async () => {
      statusContext?.showStatus("Owner-scoped error", "error", 0, { id: "error" });
      statusContext?.showStatus("Old information", "info", 2000, { behavior: statusBehavior.informational, onShow: shown, onClose: closed });
      await vi.advanceTimersByTimeAsync(PENDING_INFORMATION_MAX_AGE_MS);
      statusContext?.hideStatus("error");
    });
    expect(document.querySelector('[data-testid="status-toast"]')).toBeNull();
    expect(shown).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledOnce();
  });

  it("does not interrupt a focused control with an unrelated ordinary notice", async () => {
    await act(async () => statusContext?.showStatus("First warning", "warning", 2000));
    const dismiss = document.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification"]')!;
    await act(async () => dismiss.focus());
    await act(async () => statusContext?.showStatus("Later warning", "warning", 2000));
    expect(document.body.textContent).toContain("First warning");
    expect(document.activeElement).toBe(dismiss);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(document.body.textContent).toContain("First warning");
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="editor-action"]')!.focus());
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(document.body.textContent).toContain("Later warning");
  });

  it("keeps focus reachable when an owner update removes the focused action", async () => {
    const editor = document.querySelector<HTMLButtonElement>('[data-testid="editor-action"]')!;
    editor.focus();
    await act(async () => statusContext?.showStatus("Retry available", "warning", 0, { id: "recovery", actionLabel: "Retry", onAction: vi.fn() }));
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Retry")!.focus());
    await act(async () => statusContext?.showStatus("Recovery updated", "warning", 5000, { id: "recovery" }));
    const dismiss = document.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification"]')!;
    expect(document.activeElement).toBe(dismiss);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(document.body.textContent).toContain("Recovery updated");
    await act(async () => dismiss.click());
    expect(document.activeElement).toBe(editor);
  });

  it("keeps same-owner progress published by the action instead of closing its new revision", async () => {
    const closed = vi.fn();
    const progressClosed = vi.fn();
    await act(async () => statusContext?.showStatus("Retry available", "warning", 0, {
      id: "recovery", actionLabel: "Retry", onClose: closed,
      onAction: () => statusContext?.showStatus("Retry started", "info", 5000, {
        id: "recovery", behavior: statusBehavior.informational, onClose: progressClosed,
      }),
    }));
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Retry")!.click());
    expect(document.querySelector('[data-testid="status-toast"]')?.textContent).toBe("Retry started");
    expect(closed).toHaveBeenCalledOnce();
    expect(progressClosed).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(document.querySelector('[data-testid="status-toast"]')).toBeNull();
    expect(progressClosed).toHaveBeenCalledOnce();
  });

  it("keeps same-ID callbacks fresh without extending an identical deadline", async () => {
    const oldAction = vi.fn();
    const nextAction = vi.fn();
    const firstClosed = vi.fn();
    const duplicateClosed = vi.fn();
    const shown = vi.fn();
    await act(async () => statusContext?.showStatus("Undo offer", "warning", 6000, {
      id: "undo", actionLabel: "Undo", onAction: oldAction, onClose: firstClosed, onShow: shown,
      behavior: statusBehavior.deadline(Date.now() + 6000),
    }));
    const key = statusContext?.queue?.visibleToasts[0]?.key;
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    await act(async () => statusContext?.showStatus("Undo offer", "warning", 6000, {
      id: "undo", actionLabel: "Undo", onAction: nextAction, onClose: duplicateClosed, onShow: shown,
      behavior: statusBehavior.deadline(Date.now() + 6000),
    }));
    expect(statusContext?.queue?.visibleToasts[0]?.key).toBe(key);
    expect(shown).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(document.querySelector('[data-testid="status-toast"]')).toBeNull();
    expect(firstClosed).toHaveBeenCalledOnce();
    expect(duplicateClosed).not.toHaveBeenCalled();
  });

  it("updates queued same-ID content without showing the superseded entry", async () => {
    const firstShown = vi.fn();
    const firstClosed = vi.fn();
    const nextShown = vi.fn();
    await act(async () => {
      statusContext?.showStatus("Active error", "error", 0, { id: "error" });
      statusContext?.showStatus("Old report state", "info", 5000, { id: "report", behavior: statusBehavior.informational, onShow: firstShown, onClose: firstClosed });
      statusContext?.showStatus("New report state", "info", 5000, { id: "report", behavior: statusBehavior.informational, onShow: nextShown });
      statusContext?.hideStatus("error");
    });
    expect(document.body.textContent).toContain("New report state");
    expect(firstShown).not.toHaveBeenCalled();
    expect(firstClosed).toHaveBeenCalledOnce();
    expect(nextShown).toHaveBeenCalledOnce();
  });

  it("treats a same-ID lifetime change as an update without rerendering status callers", async () => {
    await act(async () => statusContext?.showStatus("Needs attention", "info", 5000, { id: "owner", behavior: statusBehavior.informational }));
    const before = callerRenders;
    const key = statusContext?.queue?.visibleToasts[0]?.key;
    await act(async () => statusContext?.showStatus("Needs attention", "info", 5000, { id: "owner", behavior: statusBehavior.actionRequired }));
    expect(statusContext?.queue?.visibleToasts[0]?.key).toBe(key);
    expect(callerRenders).toBe(before);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(document.body.textContent).toContain("Needs attention");
  });

  it("keeps distinct idless Undo offers with the same text and different actions", async () => {
    const firstAction = vi.fn();
    const nextAction = vi.fn();
    await act(async () => {
      statusContext?.showStatus("Moved conversation to Trash.", "warning", 6000, { actionLabel: "Undo", onAction: firstAction, behavior: statusBehavior.deadline(Date.now() + 6000) });
      statusContext?.showStatus("Moved conversation to Trash.", "warning", 6000, { actionLabel: "Undo", onAction: nextAction, behavior: statusBehavior.deadline(Date.now() + 6000) });
    });
    const clickUndo = () => [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Undo")!.click();
    await act(async () => clickUndo());
    expect(firstAction).toHaveBeenCalledOnce();
    expect(nextAction).not.toHaveBeenCalled();
    await act(async () => clickUndo());
    expect(nextAction).toHaveBeenCalledOnce();
  });

  it("never evicts an unshown persistent approval to enforce the information cap", async () => {
    const shown = Array.from({ length: 7 }, () => vi.fn());
    const closed = Array.from({ length: 7 }, () => vi.fn());
    await act(async () => {
      statusContext?.showStatus("Active error", "error", 0, { id: "error" });
      for (let index = 0; index < 7; index++) statusContext?.showStatus(`Approval ${index}`, "info", 0, {
        id: `approval-${index}`, behavior: statusBehavior.actionRequired, onShow: shown[index], onClose: closed[index],
      });
      for (let index = 0; index < 7; index++) statusContext?.showStatus(`Information ${index}`, "info", 2000, { behavior: statusBehavior.informational });
      await vi.advanceTimersByTimeAsync(PENDING_INFORMATION_MAX_AGE_MS);
      statusContext?.hideStatus("error");
    });
    expect(closed.every(callback => callback.mock.calls.length === 0)).toBe(true);
    for (let index = 0; index < 7; index++) {
      expect(document.querySelector('[data-testid="status-toast"]')?.textContent).toBe(`Approval ${index}`);
      await act(async () => statusContext?.hideStatus(`approval-${index}`));
    }
    expect(shown.every(callback => callback.mock.calls.length === 1)).toBe(true);
    expect(closed.every(callback => callback.mock.calls.length === 1)).toBe(true);
    expect(document.querySelector('[data-testid="status-toast"]')).toBeNull();
  });

  it("does not let replacement information bypass a higher-priority pending error", async () => {
    await act(async () => {
      statusContext?.showStatus("First warning", "warning", 5000);
      statusContext?.showStatus("Pending error", "error", 0, { nonPreemptive: true });
      statusContext?.showStatus("Later warning", "warning", 5000);
    });
    expect(document.querySelector('[data-testid="status-toast"]')?.textContent).toBe("Pending error");
  });

  it("rehydrates absolute timers across StrictMode effect replay", async () => {
    const closed = vi.fn();
    const shown = vi.fn();
    const expiresAt = Date.now() + 500;
    function InitialDeadline() {
      const { showStatus } = useStatus();
      useEffect(() => {
        showStatus("Initial Undo", "warning", 500, {
          id: "strict-undo", actionLabel: "Undo", onAction: () => {}, onClose: closed, onShow: shown,
          behavior: statusBehavior.deadline(expiresAt),
        });
      }, [showStatus]);
      return <Status />;
    }
    await act(async () => root.render(<StrictMode><StatusProvider><InitialDeadline /></StatusProvider></StrictMode>));
    expect(document.body.textContent).toContain("Initial Undo");
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(document.querySelector('[data-testid="status-toast"]')).toBeNull();
    expect(closed).toHaveBeenCalledOnce();
    expect(shown).toHaveBeenCalledOnce();
  });

});
