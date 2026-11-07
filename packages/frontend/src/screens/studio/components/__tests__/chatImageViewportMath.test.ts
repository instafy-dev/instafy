import { describe, expect, it } from "vitest";
import { boundImageTransform, fitImageTransform, imageContainsPoint, imageScaleBounds, panImageBy, pinchImageTransform, resizeImageTransform, validImageSize, zoomImageAt } from "../chatImageViewportMath";

const portrait = { width: 360, height: 10000 };
const phone = { width: 360, height: 600 };
const landscape = { width: 720, height: 300 };

describe("image viewport geometry", () => {
  it("fits extreme tall images to width and starts at their top, with source pixels reachable", () => {
    const overview = fitImageTransform("overview", portrait, phone);
    expect(overview.scale).toBe(0.06);
    expect(overview.y).toBe(0);
    const width = fitImageTransform("width", portrait, phone);
    expect(width).toMatchObject({ mode: "width", scale: 1, x: 0, y: 0 });
    expect(imageScaleBounds(portrait, phone).max).toBeGreaterThanOrEqual(4);
    expect(zoomImageAt(overview, 1, { x: 180, y: 300 }, portrait, phone).scale).toBe(1);
  });

  it("bounds panning at every image edge and centers dimensions smaller than the viewport", () => {
    const width = fitImageTransform("width", portrait, phone);
    expect(panImageBy(width, { x: 10000, y: -20000 }, portrait, phone)).toMatchObject({ x: 0, y: -9400 });
    expect(panImageBy(width, { x: -10000, y: 20000 }, portrait, phone)).toMatchObject({ x: 0, y: 0, hasPanned: false });
    expect(fitImageTransform("overview", { width: 100, height: 100 }, phone)).toMatchObject({ x: 130, y: 250, scale: 1 });
  });

  it("keeps the image point under a zoom anchor when the resulting position is inside its bounds", () => {
    const image = { width: 1000, height: 1000 };
    const viewport = { width: 400, height: 400 };
    const before = fitImageTransform("overview", image, viewport);
    const point = { x: 160, y: 100 };
    const after = zoomImageAt(before, 0.8, point, image, viewport);
    expect((point.x - after.x) / after.scale).toBe((point.x - before.x) / before.scale);
    expect((point.y - after.y) / after.scale).toBe((point.y - before.y) / before.scale);
  });

  it("combines pinch scale and midpoint translation before clamping near an edge", () => {
    const image = { width: 1000, height: 1000 };
    const viewport = { width: 400, height: 400 };
    const before = { mode: "manual" as const, scale: 1, x: 0, y: -100, hasPanned: true };
    const after = pinchImageTransform(before, 0.5, { x: 100, y: 200 }, { x: 0, y: 200 }, image, viewport);
    expect(after.x).toBe(-50);
  });

  it("preserves the inspected source point through rotation in manual and panned width modes", () => {
    const width = panImageBy(fitImageTransform("width", portrait, phone), { x: 0, y: -3000 }, portrait, phone);
    const rotated = resizeImageTransform(width, portrait, phone, landscape);
    expect(rotated.scale).toBe(2);
    expect((landscape.height / 2 - rotated.y) / rotated.scale).toBe((phone.height / 2 - width.y) / width.scale);
    const manual = { ...width, mode: "manual" as const, scale: 2, x: -100 };
    const resized = resizeImageTransform(manual, portrait, phone, { width: 400, height: 500 });
    expect(resized.scale).toBe(2);
    expect((200 - resized.x) / resized.scale).toBe((180 - manual.x) / manual.scale);
    expect((250 - resized.y) / resized.scale).toBe((300 - manual.y) / manual.scale);
    expect(resizeImageTransform(fitImageTransform("width", portrait, phone), portrait, phone, landscape).y).toBe(0);
    expect(resizeImageTransform(fitImageTransform("overview", portrait, phone), portrait, phone, landscape).scale).toBe(0.03);
  });

  it("returns to overview at minimum zoom without changing explicit fit-width mode", () => {
    const overview = fitImageTransform("overview", portrait, phone);
    expect(zoomImageAt({ ...overview, mode: "manual", scale: 1 }, 0.001, { x: 180, y: 300 }, portrait, phone).mode).toBe("overview");
    expect(pinchImageTransform({ ...overview, mode: "manual", scale: 1 }, 0.001, { x: 180, y: 300 }, { x: 200, y: 300 }, portrait, phone).mode).toBe("overview");
    expect(fitImageTransform("width", { width: 1000, height: 500 }, phone).mode).toBe("width");
  });

  it("rejects invalid dimensions and keeps malformed transforms finite", () => {
    expect(validImageSize({ width: 0, height: 100 })).toBe(false);
    expect(validImageSize({ width: Infinity, height: 100 })).toBe(false);
    const invalid = boundImageTransform({ mode: "manual", scale: NaN, x: Infinity, y: NaN, hasPanned: true }, portrait, phone);
    expect(Object.values(invalid).filter(value => typeof value === "number").every(Number.isFinite)).toBe(true);
    expect(fitImageTransform("overview", { width: 0, height: 0 }, phone)).toMatchObject({ scale: 1, x: 0, y: 0 });
    const tiny = imageScaleBounds({ width: 1, height: 1 }, { width: 5000, height: 5000 });
    expect(tiny.max).toBe(32);
  });

  it("distinguishes actual image pixels from blank canvas independently of DOM targets", () => {
    const image = { width: 100, height: 200 };
    const transform = fitImageTransform("overview", image, phone);
    expect(imageContainsPoint({ x: 180, y: 300 }, transform, image)).toBe(true);
    expect(imageContainsPoint({ x: 10, y: 300 }, transform, image)).toBe(false);
  });
});
