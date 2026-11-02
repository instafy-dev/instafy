/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Status } from "../Status";
import { StatusProvider, type StatusContextValue } from "../StatusProvider";
import { subscribeToastClearance, toastClearanceBottom, useToastClearanceRef } from "../toastClearance";
import { useStatus } from "../useStatus";

let status: StatusContextValue | null = null;

function Bar({ active }: { active: boolean }) {
  const ref = useToastClearanceRef<HTMLDivElement>(active);
  return <div ref={ref} data-testid="view-bar" />;
}

function Harness({ bar }: { bar: "header" | "composer" | null }) {
  status = useStatus();
  return <>{bar ? <Bar active={bar === "header"} /> : null}<Status /></>;
}

describe("toasts and the view bar", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    // A view bar at 1024×768: 48 px down, 45 px tall.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === "view-bar"
        ? { top: 48, bottom: 93, left: 0, right: 1024, width: 1024, height: 45, x: 0, y: 48, toJSON: () => ({}) } as DOMRect
        : { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const render = (bar: "header" | "composer" | null) =>
    act(async () => root.render(<StatusProvider><Harness bar={bar} /></StatusProvider>));
  const regionTop = () => document.querySelector<HTMLElement>('[data-testid="status-toast"]')?.closest<HTMLElement>("section, [role=region]")?.style.top;

  it("knows where the view bar at the top ends, and forgets it when it goes", async () => {
    const changes = vi.fn();
    const unsubscribe = subscribeToastClearance(changes);
    await render("header");
    expect(toastClearanceBottom()).toBe(93);
    expect(changes).toHaveBeenCalled();
    // Beside the composer the bar is at the bottom of the screen.
    await render("composer");
    expect(toastClearanceBottom()).toBe(0);
    await render("header");
    await render(null);
    expect(toastClearanceBottom()).toBe(0);
    unsubscribe();
  });

  it("starts a toast below the view bar, and back under the top bar without one", async () => {
    await render("header");
    await act(async () => status!.showStatus("There is a new reply in “Plan 3 days in Seville”.", "info", 0, { actionLabel: "View", onAction: () => {} }));
    expect(regionTop()).toContain("101px");
    await render(null);
    expect(regionTop()).not.toContain("px");
  });
});
