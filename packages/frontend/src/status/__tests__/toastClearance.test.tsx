/** @vitest-environment jsdom */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Status } from "../Status";
import { StatusProvider, type StatusContextValue } from "../StatusProvider";
import { subscribeToastClearance, toastArea, toastClearanceBottom, useToastAreaRef, useToastClearanceRef } from "../toastClearance";
import { useStatus } from "../useStatus";

let status: StatusContextValue | null = null;

function Bar({ active }: { active: boolean }) {
  const ref = useToastClearanceRef<HTMLDivElement>(active);
  return <div ref={ref} data-testid="view-bar" />;
}

function Workspace({ children }: { children: ReactNode }) {
  const ref = useToastAreaRef<HTMLDivElement>(true);
  return <div ref={ref} data-testid="workspace">{children}</div>;
}

function Harness({ bar, banner = false, workspace = false }: { bar: "header" | "composer" | null; banner?: boolean; workspace?: boolean }) {
  status = useStatus();
  const views = <>{banner ? <div data-testid="inserted-banner">Reconnecting</div> : null}{bar ? <Bar active={bar === "header"} /> : null}<div data-testid="transcript"><p>Message</p></div></>;
  return <>{workspace ? <Workspace>{views}</Workspace> : views}<Status /></>;
}

describe("toasts and the view bar", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    // A view bar at 1024×768: 48 px down, 45 px tall. Studio's workspace
    // starts right of a 304 px sidebar.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const shift = document.querySelector('[data-testid="inserted-banner"]') ? 40 : 0;
      if (this.dataset.testid === "workspace") {
        return { top: 0, bottom: 768, left: 304, right: 1024, width: 720, height: 768, x: 304, y: 0, toJSON: () => ({}) } as DOMRect;
      }
      return this.dataset.testid === "view-bar"
        ? { top: 48 + shift, bottom: 93 + shift, left: 0, right: 1024, width: 1024, height: 45, x: 0, y: 48 + shift, toJSON: () => ({}) } as DOMRect
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

  const render = (bar: "header" | "composer" | null, banner = false, workspace = false) =>
    act(async () => root.render(<StatusProvider><Harness bar={bar} banner={banner} workspace={workspace} /></StatusProvider>));
  const region = () => document.querySelector<HTMLElement>('[data-testid="status-toast"]')?.closest<HTMLElement>("section, [role=region]");
  const regionTop = () => region()?.style.top;

  // A local test, Nov 5: the waiting toast's first frame sat 12 px clear of
  // the view bar, but its left 28 px lay over the sidebar, centred as it was
  // on the whole window.
  it("puts a toast over Studio's workspace, right of the sidebar", async () => {
    await render("header", false, true);
    expect(toastArea()).toEqual({ left: 304, width: 720 });
    await act(async () => status!.showStatus("Octo is waiting for your OK in “Open httpbin.org in your browser”.", "info", 0, { actionLabel: "View", onAction: () => {} }));
    expect(region()?.style.left).toBe("304px");
    expect(region()?.style.width).toBe("720px");
    expect(region()?.style.right).toBe("auto");
    expect(regionTop()).toContain("101px");
    // Without a workspace on screen it spans the window, as before.
    await render("header");
    expect(toastArea()).toBeNull();
    expect(region()?.style.left).toBe("");
    expect(region()?.style.width).toBe("");
  });

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
    expect(regionTop()).not.toContain("101px");
  });

  it("follows a bar moved by a new banner without a bar resize or window resize", async () => {
    await render("header");
    await act(async () => status!.showStatus("Connection needs attention.", "warning", 0));
    expect(regionTop()).toContain("101px");
    await render("header", true);
    await act(async () => { await new Promise(resolve => window.requestAnimationFrame(resolve)); });
    expect(regionTop()).toContain("141px");
    await render("header", false);
    await act(async () => { await new Promise(resolve => window.requestAnimationFrame(resolve)); });
    expect(regionTop()).toContain("101px");
  });

  it("bounds a notification to the visual viewport while the keyboard is open", async () => {
    const viewport = Object.assign(new EventTarget(), { height: 400, offsetTop: 0 });
    const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    try {
      await render("header");
      await act(async () => status!.showStatus("Connection needs attention.", "warning", 0));
      const region = document.querySelector<HTMLElement>('[data-testid="status-toast"]')!.closest<HTMLElement>("section, [role=region]")!;
      expect(region.style.maxHeight).toContain("400px");
      await act(async () => { viewport.height = 280; viewport.dispatchEvent(new Event("resize")); });
      expect(region.style.maxHeight).toContain("280px");
    } finally {
      if (original) Object.defineProperty(window, "visualViewport", original);
      else Reflect.deleteProperty(window, "visualViewport");
    }
  });

  it("does not remeasure for unrelated transcript streaming or cursor styles", async () => {
    await render("header");
    const changed = vi.fn();
    const unsubscribe = subscribeToastClearance(changed);
    try {
      await act(async () => { await new Promise(resolve => window.requestAnimationFrame(resolve)); });
      changed.mockClear();
      const message = document.querySelector('[data-testid="transcript"] p') as HTMLElement;
      message.append(" streaming text");
      message.style.color = "red";
      await act(async () => { await new Promise(resolve => window.requestAnimationFrame(resolve)); });
      expect(changed).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
  });
});
