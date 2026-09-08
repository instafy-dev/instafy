// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildStudioPanelScrollIdentity, StudioPanelScrollContainer } from "../StudioPanelScrollContainer";

describe("per-visit panel scroll", () => {
  let root: Root;
  let container: HTMLDivElement;
  let counter = 0;
  let scope: string;
  let frames: Map<number, FrameRequestCallback>;
  const id = (visit: string) => buildStudioPanelScrollIdentity({ userId: scope, projectId: "project", panel: "settings", visitKey: visit })!;
  const port = () => container.querySelector<HTMLDivElement>('[data-testid="port"]')!;
  const render = async (identity: string | null, height = 1500, ready = true) => act(async () => root.render(
    <StudioPanelScrollContainer identity={identity} ready={ready} data-testid="port">
      <div data-height={height}>Content</div>
    </StudioPanelScrollContainer>,
  ));
  const flush = async () => act(async () => {
    const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(0));
  });
  const geometry = () => {
    let top = 0;
    Object.defineProperty(port(), "scrollTop", {
      configurable: true,
      get: () => Math.min(top, Math.max(0, Number(port().querySelector("[data-height]")?.getAttribute("data-height")) - 300)),
      set: (next: number) => { top = Math.min(next, Math.max(0, Number(port().querySelector("[data-height]")?.getAttribute("data-height")) - 300)); },
    });
  };
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    scope = `account-${++counter}`;
    frames = new Map(); let nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { const key = ++nextFrame; frames.set(key, callback); return key; }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn((key: number) => frames.delete(key)));
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("captures before a shorter destination replaces the old DOM, and separates visits to the same panel", async () => {
    await render(id("first")); geometry(); port().scrollTop = 650;
    await render(id("second"), 100); expect(port().scrollTop).toBe(0);
    await render(id("first")); expect(port().scrollTop).toBe(650);
    await render(id("third")); expect(port().scrollTop).toBe(0);
    port().scrollTop = 200;
    await render(id("first")); expect(port().scrollTop).toBe(650);
    await render(id("third")); expect(port().scrollTop).toBe(200);
  });

  it("waits for later content growth instead of losing a saved position to the loading placeholder", async () => {
    await render(id("first")); geometry(); port().scrollTop = 700;
    await render(id("second"));
    await render(id("first"), 100); expect(port().scrollTop).toBe(0);
    await render(id("first"), 1400); await flush(); expect(port().scrollTop).toBe(700);
  });

  it("does not overwrite an unreachable restore target on a rapid departure", async () => {
    await render(id("first")); geometry(); port().scrollTop = 700;
    await render(id("second")); await render(id("first"), 100);
    await render(id("second")); await render(id("first"));
    expect(port().scrollTop).toBe(700);
  });

  it("does not fight user scroll intent when delayed content arrives", async () => {
    await render(id("first")); geometry(); port().scrollTop = 700;
    await render(id("second")); await render(id("first"), 100);
    await act(async () => port().dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 20 })));
    await render(id("first"), 1400); await flush(); expect(port().scrollTop).toBe(0);
    await render(id("second")); await render(id("first")); expect(port().scrollTop).toBe(0);
  });

  it("withholds restoration until route hydration and never shares another account or project's position", async () => {
    await render(id("first")); geometry(); port().scrollTop = 700;
    await render(null, 100, false);
    await render(id("first"), 100, false);
    await render(id("first"), 1400, true); expect(port().scrollTop).toBe(700);
    const base = { userId: scope, projectId: "project", panel: "settings", visitKey: "first" };
    await render(buildStudioPanelScrollIdentity({ ...base, userId: "another-account" })); expect(port().scrollTop).toBe(0);
    await render(buildStudioPanelScrollIdentity({ ...base, projectId: "another-project" })); expect(port().scrollTop).toBe(0);
    expect(buildStudioPanelScrollIdentity({ ...base, userId: null })).toBeNull();
  });

  it("cancels pending observation and animation callbacks when unmounted", async () => {
    await render(id("first")); geometry(); port().scrollTop = 700;
    await render(id("second")); await render(id("first"), 100);
    await act(async () => port().firstElementChild!.append(document.createTextNode("loading")));
    expect(frames.size).toBe(1);
    await act(async () => root.render(null)); expect(frames.size).toBe(0);
  });
});
