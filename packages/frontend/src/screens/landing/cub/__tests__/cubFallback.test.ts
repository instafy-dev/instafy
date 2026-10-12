import { describe, expect, it } from "vitest";
import { CUB_FALLBACK_LAYOUT, fallbackPlacement } from "../cubFallback";
import { MODES, PROTO } from "./protoFixture";

// CSS serialises lengths to 3 decimals, so compare to 0.005 px.
const px = (s: string) => parseFloat(s);

describe("fallback still placement", () => {
  for (const mode of MODES) {
    it(`places the ${mode} sprite where the prototype's CSS did`, () => {
      const f = PROTO[mode].expect.fallback;
      const p = fallbackPlacement(CUB_FALLBACK_LAYOUT[mode], mode, f.u, f.bx, f.winY);
      expect(p.x).toBeCloseTo(px(f.left), 2);
      expect(p.y).toBeCloseTo(px(f.top), 2);
      expect(p.w).toBeCloseTo(px(f.width), 2);
      expect(p.h).toBeCloseTo(px(f.height), 2);
      expect(p.fby).toBeCloseTo(px(f.fby), 2);
      if (mode === "corner") expect(p.clipBottom).toBeNull();
      else expect(p.clipBottom).toBeCloseTo(parseFloat(/inset\(0px 0px ([\d.]+)px/.exec(f.clip)![1]), 2);
    });
  }

  it("scales with the live perch and keeps the ledge line on the window top", () => {
    const S = CUB_FALLBACK_LAYOUT.corner;
    const p = fallbackPlacement(S, "corner", S.u * 0.5, 600, 400);
    expect(p.w).toBeCloseTo(S.w * 0.5, 9);
    expect(p.y + p.fby).toBeCloseTo(400, 9);
    expect(p.x + S.bx * 0.5).toBeCloseTo(600, 9);
    const h = fallbackPlacement(CUB_FALLBACK_LAYOUT.header, "header", 48, 300, 200);
    expect(h.clipBottom).toBeCloseTo(Math.max(0, h.h - h.fby - 7), 9);
  });
});
