// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  fitRemoteBrowserContentRect,
  normalizedRemoteBrowserPoint,
  remoteBrowserContentRect,
  setRemoteBrowserSurfaceContentSize,
} from "../remoteBrowserSurfaceGeometry";

describe("remote browser surface geometry", () => {
  it("fills a matching viewer without gutters", () => {
    expect(
      fitRemoteBrowserContentRect(
        { left: 20, top: 30, width: 640, height: 360 },
        { width: 1280, height: 720 },
      ),
    ).toEqual({
      left: 20,
      top: 30,
      width: 640,
      height: 360,
      right: 660,
      bottom: 390,
    });
  });

  it("centers a landscape page with horizontal gutters in a portrait viewer", () => {
    const rect = fitRemoteBrowserContentRect(
      { left: 10, top: 20, width: 390, height: 700 },
      { width: 1280, height: 720 },
    );

    expect(rect?.left).toBeCloseTo(10);
    expect(rect?.width).toBeCloseTo(390);
    expect(rect?.height).toBeCloseTo(219.375);
    expect(rect?.top).toBeCloseTo(260.3125);
    expect(rect?.bottom).toBeCloseTo(479.6875);
  });

  it("centers a portrait page with vertical gutters in a landscape viewer", () => {
    const rect = fitRemoteBrowserContentRect(
      { left: 5, top: 7, width: 1200, height: 600 },
      { width: 390, height: 844 },
    );

    expect(rect?.top).toBeCloseTo(7);
    expect(rect?.height).toBeCloseTo(600);
    expect(rect?.width).toBeCloseTo(277.251, 3);
    expect(rect?.left).toBeCloseTo(466.374, 3);
  });

  it("rejects invalid bounds and dimensions", () => {
    expect(
      fitRemoteBrowserContentRect(
        { left: 0, top: 0, width: 0, height: 360 },
        { width: 1280, height: 720 },
      ),
    ).toBeNull();
    expect(
      fitRemoteBrowserContentRect(
        { left: 0, top: 0, width: 640, height: 360 },
        { width: Number.NaN, height: 720 },
      ),
    ).toBeNull();
  });

  it("uses authoritative remote dimensions and fails closed in object-fit gutters", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 300;
    canvas.height = 150;
    canvas.getBoundingClientRect = () =>
      ({ left: 100, top: 50, width: 400, height: 400 }) as DOMRect;
    setRemoteBrowserSurfaceContentSize(canvas, 1280, 720);

    const content = remoteBrowserContentRect(canvas);
    expect(content).toMatchObject({
      left: 100,
      top: 137.5,
      width: 400,
      height: 225,
    });
    expect(normalizedRemoteBrowserPoint(canvas, 300, 250)).toEqual({
      x: 0.5,
      y: 0.5,
    });
    expect(normalizedRemoteBrowserPoint(canvas, 300, 100)).toBeNull();
    expect(normalizedRemoteBrowserPoint(canvas, 99, 250)).toBeNull();
    expect(normalizedRemoteBrowserPoint(canvas, 500, 362.5)).toEqual({
      x: 1,
      y: 1,
    });
  });

  it("falls back to intrinsic media dimensions and clears invalid metadata", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 600;
    canvas.style.objectFit = "contain";
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 400, height: 400 }) as DOMRect;

    expect(remoteBrowserContentRect(canvas)).toMatchObject({
      left: 0,
      top: 50,
      width: 400,
      height: 300,
    });
    setRemoteBrowserSurfaceContentSize(canvas, 0, 600);
    expect(canvas.hasAttribute("data-remote-content-width")).toBe(false);
    expect(canvas.hasAttribute("data-remote-content-height")).toBe(false);
    expect(remoteBrowserContentRect(canvas)).toMatchObject({ top: 50, height: 300 });
  });
});
