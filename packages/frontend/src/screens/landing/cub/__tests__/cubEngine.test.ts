// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_THEME_LIGHT } from "../cubConfig";
import { createCub } from "../cubEngine";
import { PROTOTYPE_TIMELINE } from "../cubTimeline";
import type { CubFallbackSprites, CubGlStatus } from "../cubTypes";
import { PROTO } from "./protoFixture";

// jsdom has no WebGL: the engine must report it, show the still without
// throwing or logging, and leave nothing behind when it is destroyed.

const sprite = { w: 100, h: 80, u: 79.2, bx: 50, ey: 60, ink: "data:image/webp;base64,AA", inkDark: "data:image/webp;base64,AB", cov: "data:image/webp;base64,AC" };
const SPRITES: CubFallbackSprites = { corner: sprite, header: sprite, mobile: sprite };

describe("the engine without WebGL", () => {
  let host: HTMLElement;

  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
    vi.restoreAllMocks();
  });

  it("reports no-webgl2, loads the still once and shows it at the perch, quietly", async () => {
    const errors = vi.spyOn(console, "error");
    const warnings = vi.spyOn(console, "warn");
    const statuses: [CubGlStatus, string | undefined][] = [];
    const load = vi.fn(async () => SPRITES);
    const cub = createCub(host, {
      anchors: PROTO.corner.anchors,
      theme: DEFAULT_THEME_LIGHT,
      timeline: PROTOTYPE_TIMELINE,
      fallback: load,
      onStatus: (status, reason) => statuses.push([status, reason]),
    });
    expect(statuses).toEqual([["off", "no-webgl2"]]);
    expect(host.dataset.cubGl).toBe("off");
    await Promise.resolve();
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    const still = host.querySelector('[data-cub-layer="fallback"]') as HTMLElement;
    expect(still.style.display).toBe("block");
    expect(parseFloat(still.style.width)).toBeGreaterThan(0);
    // The canvases stay hidden; nothing reacts to clicks without the renderer.
    expect((host.querySelector('canvas[data-cub-layer="gl"]') as HTMLElement).style.visibility).toBe("hidden");
    expect(() => cub.boop()).not.toThrow();
    expect(cub.getState().ink).toBe(0);
    // A relayout reuses the loaded still.
    cub.relayout();
    expect(load).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();

    cub.destroy();
    expect(host.querySelectorAll("[data-cub-layer]")).toHaveLength(0);
    expect(host.dataset.cubGl).toBeUndefined();
    expect(host.dataset.cubMode).toBeUndefined();
  });

  it("lays out again once a window resize settles, from whatever size the page has then", () => {
    vi.useFakeTimers();
    try {
      let anchors = PROTO.corner.anchors;
      const cub = createCub(host, { anchors: () => anchors, theme: DEFAULT_THEME_LIGHT, timeline: PROTOTYPE_TIMELINE, fallback: SPRITES });
      expect(host.dataset.cubMode).toBe("corner");
      // A storm: the page passes through a phone size and comes back.
      anchors = PROTO.mobile.anchors;
      window.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(30);
      anchors = PROTO.corner.anchors;
      window.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(59);
      expect(host.dataset.cubMode).toBe("corner");
      // It settles on a phone size: laid out 60 ms after the last resize.
      anchors = PROTO.mobile.anchors;
      window.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(59);
      expect(host.dataset.cubMode).toBe("corner");
      vi.advanceTimersByTime(1);
      expect(host.dataset.cubMode).toBe("mobile");
      cub.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows nothing when the still cannot load", async () => {
    const cub = createCub(host, {
      anchors: PROTO.corner.anchors,
      theme: DEFAULT_THEME_LIGHT,
      timeline: PROTOTYPE_TIMELINE,
      fallback: () => Promise.reject(new Error("offline")),
    });
    await Promise.resolve();
    await Promise.resolve();
    const still = host.querySelector('[data-cub-layer="fallback"]') as HTMLElement;
    expect(still.style.display).toBe("none");
    cub.destroy();
  });
});
