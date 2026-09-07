// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStudioNavigationPosture } from "../useStudioNavigationPosture";

function NavigationPosture() {
  const posture = useStudioNavigationPosture();
  return <output>{JSON.stringify(posture)}</output>;
}

describe("useStudioNavigationPosture", () => {
  let container: HTMLDivElement;
  let root: Root;
  let width: number;
  let touch: boolean;
  let mediaListeners: Map<(event: MediaQueryListEvent) => void, string>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    width = 390;
    touch = true;
    mediaListeners = new Map();
    window.localStorage.clear();
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() {
        const minWidth = query.match(/min-width:\s*(\d+)px/);
        return minWidth ? width >= Number(minWidth[1]) : touch;
      },
      media: query,
      addEventListener: (_event: string, listener: (event: MediaQueryListEvent) => void) => mediaListeners.set(listener, query),
      removeEventListener: (_event: string, listener: (event: MediaQueryListEvent) => void) => mediaListeners.delete(listener),
    }));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it.each([
    { label: "phone", viewportWidth: 390, touchInput: true, composerNavigation: true },
    { label: "narrow mouse browser", viewportWidth: 390, touchInput: false, composerNavigation: true },
    { label: "narrow tablet", viewportWidth: 820, touchInput: true, composerNavigation: true },
    { label: "narrow desktop window", viewportWidth: 899, touchInput: false, composerNavigation: true },
    { label: "desktop breakpoint", viewportWidth: 900, touchInput: false, composerNavigation: false },
    { label: "wide touch screen", viewportWidth: 1280, touchInput: true, composerNavigation: false },
  ])("routes $label navigation to the matching surface", async ({ viewportWidth, touchInput, composerNavigation }) => {
    width = viewportWidth;
    touch = touchInput;
    await act(async () => root.render(<NavigationPosture />));
    const posture = JSON.parse(container.textContent ?? "{}");
    expect(posture.showComposerNavigationButton).toBe(composerNavigation);
    expect(posture.isLargeScreen).toBe(!composerNavigation);
    expect(posture.touchLikeInput).toBe(touchInput);
  });

  it("moves navigation when resizing across the sidebar breakpoint", async () => {
    touch = false;
    await act(async () => root.render(<NavigationPosture />));
    expect(JSON.parse(container.textContent ?? "{}").showComposerNavigationButton).toBe(true);
    width = 1200;
    await act(async () => {
      mediaListeners.forEach((query, listener) => listener({ matches: window.matchMedia(query).matches } as MediaQueryListEvent));
    });
    expect(JSON.parse(container.textContent ?? "{}").showComposerNavigationButton).toBe(false);
  });
});
