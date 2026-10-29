// @vitest-environment jsdom
import { Capacitor } from "@capacitor/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeStatusBarBackground } from "../NativeStatusBarBackground";

vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: vi.fn() } }));

describe("NativeStatusBarBackground", () => {
  let container: HTMLDivElement;
  let root: Root;
  const findBackdrop = () => document.querySelector<HTMLElement>('[data-testid="native-status-bar-background"]');

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it.each(["web", "ios"])("leaves %s status-area ownership unchanged", async platform => {
    vi.mocked(Capacitor.getPlatform).mockReturnValue(platform);
    await act(async () => root.render(<NativeStatusBarBackground />));
    expect(findBackdrop()).toBeNull();
  });

  it("paints outside route clipping without adding an accessible control", async () => {
    vi.mocked(Capacitor.getPlatform).mockReturnValue("android");
    await act(async () => root.render(<div style={{ overflow: "hidden", isolation: "isolate" }}><NativeStatusBarBackground /></div>));
    const backdrop = findBackdrop()!;
    expect(backdrop.parentElement).toBe(document.body);
    expect(container.contains(backdrop)).toBe(false);
    expect(backdrop.getAttribute("aria-hidden")).toBe("true");
    expect(backdrop.tabIndex).toBe(-1);
    await act(async () => root.render(null));
    expect(findBackdrop()).toBeNull();
  });
});
