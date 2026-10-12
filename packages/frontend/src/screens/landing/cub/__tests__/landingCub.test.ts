// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CREW_DARK_LIFT, CREW_SLOTS } from "../../landingCrew";
import { TOP_BAR } from "../../landingStudioChrome";
import type { CubOptions } from "../cubTypes";
import { LANDING_CUB_LAYOUT, LANDING_CUB_THEME, LANDING_CUB_WAIT, measureLandingAnchors, mountLandingCub } from "../landingCub";
import { LANDING_CUB_FALLBACK } from "../landingCubFallback";
import { LANDING_CUB_TIMELINE } from "../landingCubTimeline";

const created = vi.hoisted(() => ({ options: [] as CubOptions[], handles: [] as Record<string, ReturnType<typeof vi.fn>>[] }));
vi.mock("../cubEngine", () => ({
  createCub: (_host: HTMLElement, options: CubOptions) => {
    created.options.push(options);
    const handle = {
      destroy: vi.fn(),
      setTheme: vi.fn(),
      setReducedMotion: vi.fn(),
      setTurn: vi.fn(),
      relayout: vi.fn(),
      notice: vi.fn(),
    };
    created.handles.push(handle);
    return handle;
  },
}));

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "../../../../styles/tailwind.css"), "utf8");
const token = (selector: string, name: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const block of css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "g"))) {
    const hit = new RegExp(`${name}:\\s*([^;]+);`).exec(block[1]);
    if (hit) return hit[1].trim().toLowerCase();
  }
  return null;
};

// A hero with every anchor Cub reads; data-rect is the element's client rect.
function heroFixture(): { hero: HTMLElement; layer: HTMLElement } {
  document.body.innerHTML = `
    <section data-cub-anchor="hero" data-rect="0,0,1440,1400">
      <div data-testid="landing-cub-layer" data-rect="0,0,1440,1400"></div>
      <h1 data-cub-anchor="headline" data-rect="168,108,600,180">Good work</h1>
      <p data-cub-anchor="sub" data-rect="168,300,500,90">Sub</p>
      <a data-cub-anchor="cta" data-rect="168,420,140,48">Get started</a>
      <a data-cub-anchor="cta-secondary" data-rect="320,420,130,48">Install</a>
      <div data-cub-anchor="chips"><button data-rect="168,490,140,38"></button><button data-rect="316,490,130,38"></button></div>
      <div data-cub-anchor="window" data-rect="168,570,1104,784">
        <div data-cub-anchor="panel" data-rect="393,571,878,782">
          <div data-cub-anchor="topbar" data-rect="393,571,878,48">
            <span data-cub-anchor="title" data-rect="393,571,192,48"></span>
            <span data-cub-anchor="action" data-rect="585,571,48,48"><svg data-rect="600,586,18,18"></svg></span>
            <span data-cub-anchor="action" data-rect="1175,575,40,40"><svg data-rect="1185,585,20,20"></svg></span>
          </div>
          <div data-cub-anchor="topbar" data-cub-layout="phone" data-hidden="1">
            <span data-cub-anchor="title" data-hidden="1"></span>
            <span data-cub-anchor="action" data-hidden="1"><svg></svg></span>
          </div>
          <span data-roster-coin="ada" data-cub-anchor="coin" data-rect="1173,628,24,24"></span>
          <span data-roster-coin="kim" data-cub-anchor="coin" data-rect="1191,628,24,24"></span>
          <span data-roster-coin="octo" data-cub-anchor="coin" data-rect="1209,628,24,24"></span>
          <span data-roster-coin="agent" data-cub-anchor="coin" data-rect="1231,628,24,24"></span>
          <section data-cub-anchor="transcript" data-rect="393,654,878,600">
            <div data-scenario-copy="inactive">
              <div data-cub-anchor="floor" data-rect="409,700,846,50"></div>
              <div data-cub-anchor="own" data-rect="1,1,1,1"></div>
            </div>
            <div data-scenario-copy="active">
              <div data-cub-anchor="floor" data-rect="409,662,846,50"></div>
              <div data-cub-anchor="own" data-rect="612,722,643,40"></div>
              <div data-cub-anchor="octo-message" data-rect="453,780,600,120"></div>
              <span data-cub-anchor="file" data-rect="460,860,120,28"></span>
            </div>
          </section>
          <div data-cub-anchor="composer" data-rect="409,1270,846,60"></div>
        </div>
      </div>
      <a data-cub-anchor="keep-out" data-rect="640,1370,200,28">Start your own session</a>
      <span data-roster-coin="octo-elsewhere"></span>
    </section>`;
  return {
    hero: document.querySelector('[data-cub-anchor="hero"]') as HTMLElement,
    layer: document.querySelector('[data-testid="landing-cub-layer"]') as HTMLElement,
  };
}

function rectOf(el: Element): DOMRect {
  const r = el.getAttribute("data-rect");
  const [x, y, w, h] = r ? r.split(",").map(Number) : [0, 0, 0, 0];
  return { x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h, toJSON: () => ({}) } as DOMRect;
}

describe("Cub on the landing", () => {
  beforeEach(() => {
    created.options.length = 0;
    created.handles.length = 0;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return rectOf(this);
    });
    vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
      const hidden = this.closest("[data-hidden]") || !this.hasAttribute("data-rect");
      return (hidden ? [] : [rectOf(this)]) as unknown as DOMRectList;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("paints Cub in the page's own colours, with crew ink in logo order", () => {
    expect(LANDING_CUB_THEME.light.paper.toLowerCase()).toBe(token(":root", "--marketing-canvas"));
    expect(LANDING_CUB_THEME.dark.paper.toLowerCase()).toBe(token(".dark", "--marketing-canvas"));
    expect(LANDING_CUB_THEME.light.surface).toBe("#FFFFFF");
    expect(LANDING_CUB_THEME.dark.surface.toLowerCase()).toBe(token("@theme", "--color-studio-dark-panel"));
    expect(LANDING_CUB_THEME.light.crew).toEqual(CREW_SLOTS.map((slot) => slot.fill));
    expect(LANDING_CUB_THEME.dark.crew).toEqual([...CREW_DARK_LIFT]);
    for (const theme of Object.values(LANDING_CUB_THEME)) {
      for (const hex of [theme.paper, theme.surface, theme.pen, ...theme.crew]) expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("measures the window, its chrome and the active scenario relative to the layer", () => {
    const { hero, layer } = heroFixture();
    const a = measureLandingAnchors(hero, layer)!;
    expect(a.window).toEqual({ x: 168, y: 570, w: 1104, h: 784 });
    expect(a.panel).toEqual({ x: 393, y: 571, w: 878, h: 782 });
    expect(a.titleRow).toEqual({ x: 393, y: 571, w: 192, h: 48 });
    expect(a.floor.y).toBe(662);
    expect(a.coins).toHaveLength(4);
    expect(a.octoCoin).toBe(2);
    // The glyphs, not their buttons; hidden chrome (the phone bar on desktop) is skipped.
    expect(a.chrome).toEqual([
      { x: 600, y: 586, w: 18, h: 18 },
      { x: 1185, y: 585, w: 20, h: 20 },
    ]);
    expect(a.keepOut).toEqual([
      { x: 320, y: 420, w: 130, h: 48 },
      { x: 640, y: 1370, w: 200, h: 28 },
    ]);
    expect(a.cta).toEqual({ x: 168, y: 420, w: 140, h: 48 });
    expect(a.chips).toHaveLength(2);
    expect(a.poi?.own).toEqual({ x: 612, y: 722, w: 643, h: 40 });
    expect(a.poi?.file).toEqual({ x: 460, y: 860, w: 120, h: 28 });
    // The tab strip is showing: the desktop layout, whatever the layer's width.
    expect(a.mobile).toBe(false);
  });

  it("takes the phone perch when the page shows its phone bar, not by the layer's width", () => {
    const { hero, layer } = heroFixture();
    const [strip, phone] = hero.querySelectorAll('[data-cub-anchor="topbar"]');
    strip.setAttribute("data-hidden", "1");
    phone.removeAttribute("data-hidden");
    phone.setAttribute("data-rect", "168,570,1104,56");
    phone.querySelector('[data-cub-anchor="title"]')!.removeAttribute("data-hidden");
    phone.querySelector('[data-cub-anchor="title"]')!.setAttribute("data-rect", "220,578,160,40");
    expect(measureLandingAnchors(hero, layer)!.mobile).toBe(true);
  });

  it("takes the corner when the top bar's media query left room for it, not by the layer's width", () => {
    const { hero, layer } = heroFixture();
    const strip = hero.querySelector('[data-cub-anchor="topbar"]') as HTMLElement;
    // No word from the page: the engine falls back to its width rule.
    expect(measureLandingAnchors(hero, layer)!.corner).toBeUndefined();
    strip.style.setProperty("--cub-perch", "corner");
    expect(measureLandingAnchors(hero, layer)!.corner).toBe(true);
    strip.style.setProperty("--cub-perch", " header ");
    expect(measureLandingAnchors(hero, layer)!.corner).toBe(false);
    // The bar declares it for both of its layouts (TOP_BAR), header first.
    expect(TOP_BAR).toMatch(/\[--cub-perch:header\]/);
    expect(TOP_BAR).toMatch(new RegExp(`min-\\[${LANDING_CUB_LAYOUT.cornerMinWidth}px\\]:\\[--cub-perch:corner\\]`));
    expect(TOP_BAR).toMatch(new RegExp(`min-\\[${LANDING_CUB_LAYOUT.cornerMinWidth}px\\]:\\[--roster-end:`));
  });

  it("fills the whole workspace, top bar included: the bar takes the panel's surface in both themes", () => {
    const { hero, layer } = heroFixture();
    expect(measureLandingAnchors(hero, layer)!.panel).toEqual({ x: 393, y: 571, w: 878, h: 782 });
  });

  it("waits until the window is laid out", () => {
    const { hero, layer } = heroFixture();
    hero.querySelector('[data-cub-anchor="window"]')!.setAttribute("data-hidden", "1");
    expect(measureLandingAnchors(hero, layer)).toBeNull();
  });

  it("creates the engine with the landing's timeline, perch rules and lazily loaded stills", async () => {
    const { hero, layer } = heroFixture();
    const controller = mountLandingCub({
      layer,
      hero,
      settings: { theme: "dark", reducedMotion: false, turnStartedAt: 42, coinPop: false },
    });
    const o = created.options[0];
    expect(o.timeline).toBe(LANDING_CUB_TIMELINE);
    expect(o.layout).toBe(LANDING_CUB_LAYOUT);
    expect(o.theme).toBe(LANDING_CUB_THEME.dark);
    expect(o.turn).toEqual({ live: true, startedAt: 42 });
    expect(o.reducedMotion).toBe(false);
    expect(o.eyes).toBe(true);
    expect(o.clickInk).toBe(true);
    expect(o.splash).toBe("apart");
    expect(typeof o.anchors).toBe("function");
    expect(typeof o.fallback).toBe("function");
    const sprites = await (o.fallback as () => Promise<unknown>)();
    expect(sprites).toBe(LANDING_CUB_FALLBACK);
    for (const mode of ["corner", "header", "mobile"] as const) {
      const s = LANDING_CUB_FALLBACK[mode]!;
      for (const url of [s.ink, s.inkDark, s.cov]) expect(url).toMatch(/^data:image\/webp;base64,/);
      expect(s.u).toBeGreaterThan(0);
    }

    controller.setTurnStartedAt(null);
    expect(created.handles[0].setTurn).toHaveBeenLastCalledWith({ live: false });
    controller.setTheme("light");
    expect(created.handles[0].setTheme).toHaveBeenLastCalledWith(LANDING_CUB_THEME.light);
    // The anchors do not depend on the theme: no relayout (and no ink reset).
    expect(created.handles[0].relayout).not.toHaveBeenCalled();
  });

  it("tells the host once when the first turn may start: after the hello, or at once without WebGL", () => {
    const { hero, layer } = heroFixture();
    const onReady = vi.fn();
    mountLandingCub({ layer, hero, settings: { theme: "light", reducedMotion: false, turnStartedAt: null, coinPop: false }, onReady });
    const o = created.options[0];
    o.onStatus?.("on");
    expect(onReady).not.toHaveBeenCalled();
    o.onReadyForTurn?.();
    expect(onReady).toHaveBeenCalledTimes(1);
    o.onStatus?.("off", "context-lost");
    expect(onReady).toHaveBeenCalledTimes(1);

    const late = vi.fn();
    mountLandingCub({ layer, hero, settings: { theme: "light", reducedMotion: false, turnStartedAt: null, coinPop: false }, onReady: late });
    created.options[1].onStatus?.("off", "no-webgl2");
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("never holds the first turn long on a Cub who is slow to draw or to say hello", () => {
    vi.useFakeTimers();
    try {
      const { hero, layer } = heroFixture();
      const settings = { theme: "light" as const, reducedMotion: false, turnStartedAt: null, coinPop: false };
      const slow = vi.fn();
      mountLandingCub({ layer, hero, settings, onReady: slow });
      vi.advanceTimersByTime(LANDING_CUB_WAIT.firstFrame - 1);
      expect(slow).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(slow).toHaveBeenCalledTimes(1);

      // Drawing restarts the wait, now for the hello.
      const drawn = vi.fn();
      mountLandingCub({ layer, hero, settings, onReady: drawn });
      vi.advanceTimersByTime(LANDING_CUB_WAIT.firstFrame - 10);
      created.options[1].onStatus?.("on");
      vi.advanceTimersByTime(LANDING_CUB_WAIT.hello - 1);
      expect(drawn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(drawn).toHaveBeenCalledTimes(1);

      // Destroyed before either: never.
      const gone = vi.fn();
      mountLandingCub({ layer, hero, settings, onReady: gone }).destroy();
      vi.advanceTimersByTime(LANDING_CUB_WAIT.firstFrame + LANDING_CUB_WAIT.hello);
      expect(gone).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("mirrors the coin press, the pop and the hover on nodes React does not own, and cleans up", () => {
    const { hero, layer } = heroFixture();
    const coin = hero.querySelector('[data-roster-coin="octo"]') as HTMLElement;
    const controller = mountLandingCub({
      layer,
      hero,
      settings: { theme: "light", reducedMotion: false, turnStartedAt: null, coinPop: true },
    });
    const o = created.options[0];
    // No pop until Cub draws.
    expect(coin.hasAttribute("data-cub-pop")).toBe(false);
    o.onStatus?.("on");
    expect(coin.hasAttribute("data-cub-pop")).toBe(true);
    o.onCoinPress?.(true);
    expect(coin.hasAttribute("data-cub-press")).toBe(true);
    o.onHotChange?.(true);
    expect(hero.hasAttribute("data-cub-hot")).toBe(true);
    // The fallback still does not pop the coin, and neither does reduced motion.
    o.onStatus?.("off", "context-lost");
    expect(coin.hasAttribute("data-cub-pop")).toBe(false);
    o.onStatus?.("on");
    controller.setReducedMotion(true);
    expect(coin.hasAttribute("data-cub-pop")).toBe(false);

    controller.destroy();
    expect(created.handles[0].destroy).toHaveBeenCalledTimes(1);
    expect(coin.hasAttribute("data-cub-press")).toBe(false);
    expect(coin.hasAttribute("data-cub-pop")).toBe(false);
    expect(hero.hasAttribute("data-cub-hot")).toBe(false);
  });

  it("glances at the primary CTA on a fine-pointer hover only", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("pointer: fine"), media: query }));
    const { hero, layer } = heroFixture();
    mountLandingCub({ layer, hero, settings: { theme: "light", reducedMotion: false, turnStartedAt: null, coinPop: false } });
    const cta = hero.querySelector('[data-cub-anchor="cta"]') as HTMLElement;
    const over = (pointerType: string) => {
      const event = new MouseEvent("pointerover", { bubbles: true });
      Object.defineProperty(event, "pointerType", { value: pointerType });
      cta.dispatchEvent(event);
    };
    over("touch");
    expect(created.handles[0].notice).not.toHaveBeenCalled();
    over("mouse");
    expect(created.handles[0].notice).toHaveBeenCalledWith("cta");
  });
});
