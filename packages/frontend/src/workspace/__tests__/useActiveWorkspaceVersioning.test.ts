import { describe, expect, it } from "vitest";
import { isHistoryMode, resolveChromeMode, sourceControlTitle } from "../useActiveWorkspaceVersioning";

describe("resolveChromeMode", () => {
  it("is legacy without an origin, whatever the guess", () => {
    expect(resolveChromeMode({ originId: null, resolved: false, mode: "legacy", firstPaintMode: "stateless" })).toBe(
      "legacy",
    );
  });

  it("keeps the first-paint guess while the space's origin is still loading", () => {
    // A reload: this device last saw the space as History, and the controller
    // has not answered for its origin yet.
    expect(
      resolveChromeMode({ originId: null, resolved: false, mode: "legacy", firstPaintMode: "stateless", originPending: true }),
    ).toBe("stateless");
    expect(
      sourceControlTitle(
        resolveChromeMode({ originId: null, resolved: false, mode: "legacy", firstPaintMode: "desktop", originPending: true }),
      ),
    ).toBe("History");
    // Nothing remembered: the guess is legacy, as before.
    expect(
      resolveChromeMode({ originId: null, resolved: false, mode: "legacy", firstPaintMode: "legacy", originPending: true }),
    ).toBe("legacy");
    // Answered with no origin: legacy, whatever the guess.
    expect(
      resolveChromeMode({ originId: null, resolved: false, mode: "legacy", firstPaintMode: "stateless", originPending: false }),
    ).toBe("legacy");
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

  it("labels the nav History in the new modes and Changes in legacy", () => {
    expect(sourceControlTitle("legacy")).toBe("Changes");
    expect(sourceControlTitle("stateless")).toBe("History");
    expect(sourceControlTitle("desktop")).toBe("History");
    // Unknown resolves to legacy, so it reads Changes.
    expect(sourceControlTitle(resolveChromeMode({ originId: null, resolved: false, mode: "legacy", firstPaintMode: "legacy" }))).toBe(
      "Changes",
    );
  });

  it("counts stateless and desktop as History modes", () => {
    expect(isHistoryMode("legacy")).toBe(false);
    expect(isHistoryMode("stateless")).toBe(true);
    expect(isHistoryMode("desktop")).toBe(true);
  });
});
