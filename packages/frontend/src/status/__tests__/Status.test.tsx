/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Status } from "../Status";
import {
  StatusProvider,
  type StatusContextValue,
} from "../StatusProvider";
import { useStatus } from "../useStatus";

let statusContext: StatusContextValue | null = null;

function StatusHarness() {
  statusContext = useStatus();
  return <Status />;
}

describe("Status toast presentations", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    statusContext = null;
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
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("shows a transient success confirmation without forceVisible", async () => {
    await act(async () => {
      statusContext?.showStatus("Link copied.", "success", 2200, {
        presentation: "confirmation",
      });
    });

    const toast = document.querySelector('[data-testid="status-toast"]');

    expect(toast?.getAttribute("data-presentation")).toBe("confirmation");
    expect(toast?.className).toContain("min-h-8");
    expect(toast?.className).toContain("pointer-events-none");
    expect(toast?.className).not.toContain("py-3");
    expect(document.querySelector('[aria-label="Dismiss notification"]')).toBeNull();
  });

  it("keeps warnings dismissable and full-sized", async () => {
    await act(async () => {
      statusContext?.showStatus("Connection needs attention.", "warning", 3500);
    });

    const toast = document.querySelector('[data-testid="status-toast"]');

    expect(toast?.getAttribute("data-presentation")).toBe("default");
    expect(toast?.className).toContain("py-3");
    expect(toast?.className).toContain("pointer-events-auto");
    expect(document.querySelector('[aria-label="Dismiss notification"]')).not.toBeNull();
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

});
