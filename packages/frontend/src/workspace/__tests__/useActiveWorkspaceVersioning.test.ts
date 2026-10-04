import { describe, expect, it } from "vitest";
import { isHistoryMode, resolveChromeMode } from "../useActiveWorkspaceVersioning";

describe("resolveChromeMode", () => {
  it("is legacy without an origin, whatever the guess", () => {
    expect(resolveChromeMode({ originId: null, resolved: false, mode: "legacy", firstPaintMode: "stateless" })).toBe(
      "legacy",
    );
  });

  it("uses the probed mode once resolved", () => {
    expect(resolveChromeMode({ originId: "o", resolved: true, mode: "legacy", firstPaintMode: "stateless" })).toBe(
      "legacy",
    );
    expect(resolveChromeMode({ originId: "o", resolved: true, mode: "desktop", firstPaintMode: "legacy" })).toBe(
      "desktop",
    );
  });

  it("uses the first-paint guess while the probe runs", () => {
    expect(resolveChromeMode({ originId: "o", resolved: false, mode: "legacy", firstPaintMode: "desktop" })).toBe(
      "desktop",
    );
    expect(resolveChromeMode({ originId: "o", resolved: false, mode: "legacy", firstPaintMode: "legacy" })).toBe(
      "legacy",
    );
  });

  it("counts stateless and desktop as History modes", () => {
    expect(isHistoryMode("legacy")).toBe(false);
    expect(isHistoryMode("stateless")).toBe(true);
    expect(isHistoryMode("desktop")).toBe(true);
  });
});
