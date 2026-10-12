import { describe, expect, it } from "vitest";
import { inkKeep, inkNear, inkPlan, inkPlanS, inkSide, inkSizes, inkVary } from "../cubInkPlan";
import type { Cub } from "../cubState";
import type { CubAnchors, CubRect } from "../cubTypes";
import { build } from "../cubBuild";
import { landingCubAt } from "./landingFixture";
import { MODES, PROTO, cubFor } from "./protoFixture";

const firstBoop = (c: Cub) => Object.assign(inkVary(0, 0), inkSizes(c, 1, true));
const gapTo = (r: CubRect, x: number, y: number) =>
  Math.hypot(Math.max(r.x - x, 0, x - (r.x + r.w)), Math.max(r.y - y, 0, y - (r.y + r.h)));

describe("crew ink planner", () => {
  for (const mode of MODES) {
    it(`plans the same four splats as the prototype (${mode})`, () => {
      const c = cubFor(mode);
      const e = PROTO[mode].expect;
      expect(inkSide(c)).toBe(e.inkSide);
      const plan = inkPlanS(c, inkSide(c), firstBoop(c));
      if (!e.plan) expect(plan).toBeNull();
      else {
        expect(plan).not.toBeNull();
        expect(plan!.sd).toBe(e.plan.sd);
        expect(plan!.near).toBe(e.plan.near);
        expect(plan!.lv).toBe(e.plan.lv);
        expect(plan!.hk).toBe(e.plan.hk);
        expect(plan!.r).toBeCloseTo(e.plan.r, 9);
        plan!.pts.forEach((p, i) => {
          expect(p[0]).toBeCloseTo(e.plan!.pts[i][0], 6);
          expect(p[1]).toBeCloseTo(e.plan!.pts[i][1], 6);
        });
      }
      const dots = inkPlan(c, inkSide(c), inkVary(0, 0));
      if (!e.planDots) expect(dots).toBeNull();
      else dots!.pts.forEach((p, i) => expect(p[0]).toBeCloseTo(e.planDots!.pts[i][0], 6));
    });
  }

  it("keeps every splat clear of copy, CTAs, chips and chat by its full footprint, over the window", () => {
    for (const mode of ["corner", "mobile"] as const) {
      const c = cubFor(mode);
      const plan = inkPlanS(c, inkSide(c), firstBoop(c))!;
      expect(plan).not.toBeNull();
      const L = c.L!;
      const strict = [...L.text, ...(L.cta ? [L.cta] : []), ...L.chipRects, L.kim, L.ctitleRow];
      plan.pts.forEach(([x, y], i) => {
        const F = plan.rs![i] * 1.5;
        for (const r of strict) expect(gapTo(r, x, y)).toBeGreaterThanOrEqual(F + 8);
        // Octo's coin only needs the stain's own body clear of it
        expect(gapTo(L.octoCoin, x, y)).toBeGreaterThanOrEqual(plan.rs![i] + 10);
        expect(x - 1.3 * plan.rs![i]).toBeGreaterThan(c.G!.wx0);
        expect(x + 1.3 * plan.rs![i]).toBeLessThan(c.G!.wx1);
      });
      // and every landing spot sits at the ledge (the lowest drop straddles the window's top edge)
      expect(Math.max(...plan.pts.map((p) => p[1]))).toBeLessThanOrEqual(c.G!.edgeY + 1e-9);
      expect(inkKeep(c).filter((r) => r.coin)).toHaveLength(1);
    }
  });

  it("lands the phone set on the ledge above the landing's phone bar", () => {
    const c = landingCubAt("390x844");
    build(c, 30);
    expect(c.OC.mode).toBe("mobile");
    const plan = inkPlanS(c, inkSide(c), firstBoop(c))!;
    expect(plan).not.toBeNull();
    // On the ledge, not raised up the wall, and close to the prototype's own phone set (0.76 of full size): the
    // landing's 24px gutter (the prototype's was 16px) leaves the next step, 0.7.
    expect(plan.lv).toBe(0);
    expect(plan.r).toBeGreaterThanOrEqual(0.7 * 0.46 * c.OC.u - 1e-9);
    // The lowest stain straddles the window's top edge.
    const lowest = plan.pts.reduce((k, p, i) => (p[1] > plan.pts[k][1] ? i : k), 0);
    expect(plan.pts[lowest][1] + plan.rs![lowest]).toBeGreaterThan(c.G!.edgeY);
    // Every stain's body stays clear of the phone bar's glyphs and title.
    const L = c.L!;
    plan.pts.forEach(([x, y], i) => {
      for (const r of [...L.chrome, L.ctitleRow]) expect(gapTo(r, x, y)).toBeGreaterThanOrEqual(plan.rs![i] + 3 - 1e-9);
    });
  });

  it("moves the set when a new keep-out covers where it would land", () => {
    const fx = PROTO.corner;
    const c0 = cubFor("corner");
    const p0 = inkPlanS(c0, inkSide(c0), firstBoop(c0))!;
    const xs = p0.pts.map((p) => p[0]);
    const ys = p0.pts.map((p) => p[1]);
    const block: CubRect = { x: Math.min(...xs) - 10, y: Math.min(...ys) - 10, w: Math.max(...xs) - Math.min(...xs) + 20, h: Math.max(...ys) - Math.min(...ys) + 20 };
    const anchors: CubAnchors = { ...fx.anchors, keepOut: [...(fx.anchors.keepOut ?? []), block] };
    const c1 = cubFor("corner", anchors);
    expect(c1.OC.mode).toBe("corner");
    const p1 = inkPlanS(c1, inkSide(c1), firstBoop(c1));
    expect(p1).not.toBeNull();
    p1!.pts.forEach(([x, y], i) => expect(inkNear(block, x, y, p1!.rs![i] * 1.5 + 8)).toBe(false));
  });
});
