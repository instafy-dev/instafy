import { describe, expect, it } from "vitest";
import {
  boundedCdpScreencastText,
  cdpScreencastModifiers,
  mapCdpScreencastPoint,
  normalizeCdpScreencastViewport,
  parseCdpScreencastServerMessage,
} from "../cdpScreencastProtocol";

describe("CDP screencast protocol", () => {
  it("keeps Retina detail while bounding total device pixels", () => {
    expect(normalizeCdpScreencastViewport({ width: 1920, height: 1080, dpr: 2 })).toEqual({
      width: 1920,
      height: 1080,
      dpr: 2,
      deviceWidth: 3840,
      deviceHeight: 2160,
    });

    const capped = normalizeCdpScreencastViewport({ width: 2560, height: 1440, dpr: 2 });
    expect(capped.dpr).toBeLessThan(2);
    expect(capped.deviceWidth * capped.deviceHeight).toBeLessThanOrEqual(8_294_400 + 8192);
  });

  it("strictly parses ready, frame, and error messages", () => {
    expect(
      parseCdpScreencastServerMessage(
        JSON.stringify({
          type: "ready",
          pageId: "PAGE",
          width: 1280,
          height: 720,
          dpr: 2,
          deviceWidth: 2560,
          deviceHeight: 1440,
        }),
      ),
    ).toMatchObject({ type: "ready", pageId: "PAGE", dpr: 2 });
    expect(
      parseCdpScreencastServerMessage({
        type: "frame",
        frameId: 4,
        data: "abcd",
        metadata: { deviceWidth: 2560 },
      }),
    ).toEqual({
      type: "frame",
      frameId: 4,
      data: "abcd",
      metadata: { deviceWidth: 2560 },
    });
    expect(
      parseCdpScreencastServerMessage({ type: "error", message: "nope", fatal: true }),
    ).toEqual({ type: "error", message: "nope", fatal: true });
    expect(parseCdpScreencastServerMessage({ type: "frame", frameId: 0, data: "x" })).toBeNull();
    expect(parseCdpScreencastServerMessage({ type: "frame", sessionId: 4, data: "x" })).toBeNull();
    expect(parseCdpScreencastServerMessage({ type: "unknown" })).toBeNull();
  });

  it("maps local CSS coordinates into the remote logical viewport", () => {
    expect(
      mapCdpScreencastPoint({
        clientX: 250,
        clientY: 150,
        rect: { left: 50, top: 50, width: 400, height: 200 },
        viewport: { width: 1280, height: 720 },
      }),
    ).toEqual({ x: 640, y: 360 });
  });

  it("uses the CDP modifier mask and bounds inserted UTF-8 text", () => {
    expect(
      cdpScreencastModifiers({ altKey: true, ctrlKey: true, metaKey: false, shiftKey: true }),
    ).toBe(11);
    expect(boundedCdpScreencastText("hello")).toBe("hello");
    expect(boundedCdpScreencastText("x".repeat(9000))).toBeNull();
  });
});
