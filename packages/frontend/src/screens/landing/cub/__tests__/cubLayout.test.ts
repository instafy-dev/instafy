import { describe, expect, it } from "vitest";
import { scriptGaze, wanderGaze } from "../cubAttention";
import { applyLayout, measureAnchors, perchU } from "../cubLayout";
import { DEFAULT_TUNING, createCubState, resolveOptions } from "../cubState";
import type { CubAnchors } from "../cubTypes";
import { LANDING_CUB_LAYOUT } from "../landingCub";
import { LANDING_CUB_TIMELINE } from "../landingCubTimeline";
import { LANDING_LAYOUTS } from "./landingFixture";
import { MODES, PROTO, cubFor } from "./protoFixture";

describe("perch placement from anchors", () => {
  for (const mode of MODES) {
    it(`matches the prototype's ${mode} perch exactly`, () => {
      const fx = PROTO[mode];
      const e = fx.expect;
      const c = cubFor(mode);
      expect(c.OC.mode).toBe(e.mode);
      expect(c.OC.u).toBeCloseTo(e.u, 9);
      expect(c.OC.bx).toBeCloseTo(e.bx, 9);
      expect(c.OC.psi0).toBe(e.psi0);
      expect(c.OC.psiCam).toBeCloseTo(e.psiCam, 9);
      expect(c.OC.azF).toBeCloseTo(e.azF, 9);
      expect(c.OC.restOn).toEqual(e.restOn);
      expect(c.OC.reachSh).toBeCloseTo(e.reachSh, 9);
      expect(c.OC.shMin).toBeCloseTo(e.shMin, 9);
      expect(c.OC.shMax).toBeCloseTo(e.shMax, 9);
      expect(c.OC.roles).toEqual(e.roles);
      expect(c.CVR).toEqual(e.cvr);
      expect(c.ink.R).toEqual(e.inkR);
      expect(c.G!.edgeY).toBeCloseTo(e.edgeY, 9);
      expect(c.G!.floorY).toBeCloseTo(e.floorY, 9);
      expect(c.G!.deep).toBeCloseTo(e.deep, 9);
      // the built frame: body, head and every hit circle where the prototype had them
      expect(c.NHIT).toBe(e.nhit);
      expect(c.BODYC[0]).toBeCloseTo(e.body[0], 6);
      expect(c.BODYC[1]).toBeCloseTo(e.body[1], 6);
      expect(c.HEADC[0]).toBeCloseTo(e.head[0], 6);
      expect(c.HEADC[1]).toBeCloseTo(e.head[1], 6);
    });
  }

  it("uses the corner only while it is clear, then walks along the header", () => {
    const fx = PROTO.corner;
    // A keep-out over the window's top-right corner (say a tab-strip action) blocks the corner perch.
    const w = fx.anchors.window;
    const blocked: CubAnchors = { ...fx.anchors, keepOut: [...(fx.anchors.keepOut ?? []), { x: w.x + w.w - 140, y: w.y - 160, w: 120, h: 150 }] };
    const c = cubFor("corner", blocked);
    expect(c.OC.mode).toBe("header");
    expect(c.OC.bx).toBeLessThan(w.x + w.w - 3 * c.OC.u + 1e-9);
    expect(c.OC.bx).toBeGreaterThanOrEqual(w.x + 3 * c.OC.u - 1e-9);
  });

  it("sizes the perch from the host width on desktop and from the room above the window on a phone", () => {
    const d = PROTO.corner;
    const L = measureAnchors(d.anchors, 1440, 900, 2, DEFAULT_TUNING);
    expect(perchU(L, DEFAULT_TUNING)).toBeCloseTo(79.2, 9);
    expect(perchU(measureAnchors(d.anchors, 1000, 900, 2, DEFAULT_TUNING), DEFAULT_TUNING)).toBeCloseTo(55, 9);
    expect(perchU(measureAnchors(d.anchors, 2000, 900, 2, DEFAULT_TUNING), DEFAULT_TUNING)).toBe(84);
    const m = PROTO.mobile;
    const Lm = measureAnchors(m.anchors, 390, 844, 2, DEFAULT_TUNING);
    expect(Lm.mobile).toBe(true);
    expect(perchU(Lm, DEFAULT_TUNING)).toBeCloseTo(m.expect.u, 9);
    // no chips: the stand-in gives the full phone perch
    const Ln = measureAnchors({ ...m.anchors, chips: [] }, 390, 844, 2, DEFAULT_TUNING);
    expect(perchU(Ln, DEFAULT_TUNING)).toBe(33);
  });

  it("takes the host's word for its layout over the width (a classic scrollbar narrows the host)", () => {
    const d = PROTO.corner;
    const tuning = { ...DEFAULT_TUNING, mobileBreakpoint: 768 };
    expect(measureAnchors(d.anchors, 755, 900, 2, tuning).mobile).toBe(true);
    expect(measureAnchors({ ...d.anchors, mobile: false }, 755, 900, 2, tuning).mobile).toBe(false);
    expect(measureAnchors({ ...d.anchors, mobile: true }, 900, 900, 2, tuning).mobile).toBe(true);
    // the layout signature changes with it, so a flip lays Cub out again
    expect(measureAnchors({ ...d.anchors, mobile: false }, 755, 900, 2, tuning).sig).not.toBe(
      measureAnchors({ ...d.anchors, mobile: true }, 755, 900, 2, tuning).sig,
    );
  });

  it("takes the host's word for the corner over the width (a classic scrollbar narrows the host)", () => {
    const fx = LANDING_LAYOUTS["1024x768"];
    const tuning = { ...DEFAULT_TUNING, ...LANDING_CUB_LAYOUT };
    // A 1005 px viewport whose scrollbar leaves the host 990 px: the page laid out its corner room.
    // Without the page's word, the width rule alone would put him on the header.
    const narrow = { ...fx.anchors, width: 990, corner: undefined };
    expect(measureAnchors(narrow, 990, 900, 2, tuning).cornerOK).toBe(false);
    expect(measureAnchors({ ...narrow, corner: true }, 990, 900, 2, tuning).cornerOK).toBe(true);
    expect(measureAnchors({ ...fx.anchors, corner: false }, 1024, 900, 2, tuning).cornerOK).toBe(false);
    const at = (a: CubAnchors, W: number) => {
      const c = createCubState(resolveOptions({ timeline: LANDING_CUB_TIMELINE, layout: LANDING_CUB_LAYOUT }));
      applyLayout(c, a, W, a.height ?? 900, 2, true);
      return c.OC.mode;
    };
    expect(at({ ...narrow, corner: true }, 990)).toBe("corner");
    expect(at({ ...fx.anchors, corner: false }, 1024)).toBe("header");
    // the layout signature changes with it, so a flip lays Cub out again
    expect(measureAnchors({ ...narrow, corner: true }, 990, 900, 2, tuning).sig).not.toBe(measureAnchors(narrow, 990, 900, 2, tuning).sig);
  });

  it("reproduces the prototype's scripted gaze and wander targets", () => {
    const c = cubFor("corner");
    for (const [td, want] of PROTO.corner.expect.gaze ?? []) {
      const got = scriptGaze(c, td);
      if (want == null) expect(got).toBeNull();
      else {
        expect(got).not.toBeNull();
        for (let k = 0; k < 3; k++) expect(got![k]).toBeCloseTo(want[k], 6);
      }
    }
    for (const [t, want] of PROTO.corner.expect.wander ?? []) {
      const got = wanderGaze(c, t);
      if (want == null) expect(got).toBeNull();
      else for (let k = 0; k < 3; k++) expect(got![k]).toBeCloseTo(want[k], 6);
    }
  });
});
