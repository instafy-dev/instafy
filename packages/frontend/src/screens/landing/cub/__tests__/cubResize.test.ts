// A visitor drag-resizes the window: the page lays out again every frame and
// the perch moves faster than Cub's ease-over spring can follow. He must
// never be left drawn off the page, and the frame loop's visibility check
// must never stop him because of where an old layout put him.
import { describe, expect, it } from "vitest";
import { build } from "../cubBuild";
import { applyLayout, cubOnScreen } from "../cubLayout";
import { createCubState, resolveOptions, type Cub } from "../cubState";
import type { CubAnchors, CubRect } from "../cubTypes";
import { LANDING_CUB_LAYOUT } from "../landingCub";
import { LANDING_CUB_TIMELINE } from "../landingCubTimeline";
import { LANDING_LAYOUTS } from "./landingFixture";

const moved = (r: CubRect, dx: number): CubRect => ({ ...r, x: r.x + dx });

/** The 1440 px landing narrowed by `by` px: the centred content slides left by half of it. */
function narrowed(by: number): CubAnchors & { width: number; height: number } {
  const a = LANDING_LAYOUTS["1440x900"].anchors;
  const dx = -by / 2;
  const opt = (r: CubRect | null | undefined) => (r ? moved(r, dx) : r);
  return {
    ...a,
    width: a.width - by,
    window: moved(a.window, dx),
    panel: moved(a.panel, dx),
    transcript: moved(a.transcript, dx),
    floor: moved(a.floor, dx),
    titleRow: moved(a.titleRow, dx),
    composer: moved(a.composer, dx),
    coins: a.coins.map((r) => moved(r, dx)),
    textLines: a.textLines.map((r) => moved(r, dx)),
    cta: opt(a.cta),
    keepOut: (a.keepOut ?? []).map((r) => moved(r, dx)),
    chrome: (a.chrome ?? []).map((r) => moved(r, dx)),
    chips: (a.chips ?? []).map((r) => moved(r, dx)),
    poi: Object.fromEntries(Object.entries(a.poi ?? {}).map(([k, r]) => [k, opt(r)])),
  };
}

/** A running, animating Cub laid out on the 1440 px landing. */
function liveCub(): Cub {
  const c = createCubState(resolveOptions({ timeline: LANDING_CUB_TIMELINE, layout: LANDING_CUB_LAYOUT }));
  c.glOK = true;
  const a = narrowed(0);
  applyLayout(c, a, a.width, a.height, 2, true);
  c.started = true;
  c.built = true;
  build(c, 3);
  return c;
}

/** The body's x as drawn this frame. */
const bodyX = (c: Cub) => c.OC.bx + c.SHIFT.x;

/** A stand-in for the box the renderer records (cubRender.ts): the body and the arms around it. */
function drawnBox(c: Cub): [number, number, number, number] {
  const u = c.OC.u;
  const y = c.G!.edgeY;
  return [bodyX(c) - 2 * u, y - 2.3 * u, bodyX(c) + 2 * u, y + 0.8 * u];
}

describe("Cub through a drag-resize", () => {
  it("never trails the perch by more than 0.6 u, however many frames lay out in a row", () => {
    const c = liveCub();
    // 37 px a frame from 1440 px down to 1181 px (the window keeps its width; it only slides).
    for (let k = 1; k <= 7; k++) {
      const a = narrowed(37 * k);
      expect(applyLayout(c, a, a.width, a.height, 2, false)).toBe(true);
      expect(c.OC.mode).toBe("corner");
      expect(Math.abs(c.SHIFT.x)).toBeLessThanOrEqual(0.6 * c.OC.u + 1e-9);
      // the body as drawn stays on the page, right of it never
      expect(bodyX(c) + 1.2 * c.OC.u).toBeLessThan(a.width);
    }
  });

  it("seats Cub on the new perch when the perch mode changes", () => {
    const c = liveCub();
    c.SHIFT.x = 0.5 * c.OC.u;
    const phone = LANDING_LAYOUTS["390x844"].anchors;
    applyLayout(c, phone, phone.width, phone.height, 2, false);
    expect(c.OC.mode).toBe("mobile");
    expect(c.SHIFT.x).toBe(0);
  });

  it("keeps playing while a new layout is undrawn, and while the body trails an on-screen perch", () => {
    const c = liveCub();
    const vh = 900;
    c.BB = drawnBox(c);
    expect(cubOnScreen(c, 0, 0, 1440, vh)).toBe(true);
    // The page narrows to 1024 px.
    const a = LANDING_LAYOUTS["1024x768"].anchors;
    applyLayout(c, a, a.width, a.height, 2, false);
    // no box for the new layout until it is drawn: on screen
    expect(c.BB).toBeNull();
    expect(cubOnScreen(c, 0, 0, 1024, vh)).toBe(true);
    // A box drawn wholly past the viewport's right edge (the body trailing an
    // old perch) cannot hide a perch that is on screen: the loop keeps running
    // and the spring brings him home.
    const y = c.G!.edgeY;
    c.BB = [1030, y - 150, 1300, y + 50];
    expect(cubOnScreen(c, 0, 0, 1024, vh)).toBe(true);
    // drawn on the new layout: on screen
    c.BB = drawnBox(c);
    expect(cubOnScreen(c, 0, 0, 1024, vh)).toBe(true);
  });

  it("still stops when the visitor has scrolled him away", () => {
    const c = liveCub();
    c.BB = drawnBox(c);
    expect(cubOnScreen(c, 0, 0, 1440, 900)).toBe(true);
    // the hero scrolled 2000 px up, out of the viewport
    expect(cubOnScreen(c, 0, -2000, 1440, 900)).toBe(false);
  });
});
