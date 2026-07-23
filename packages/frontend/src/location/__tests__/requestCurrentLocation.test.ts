import { describe, expect, it } from "vitest";
import {
  buildSharedLocationDispatchInput,
  buildSharedLocationVisibleMessage,
  type SharedLocationContext,
} from "../requestCurrentLocation";

describe("requestCurrentLocation formatting", () => {
  it("formats a compact approximate location follow-up", () => {
    const location: SharedLocationContext = {
      precision: "approximate",
      latitude: 48.209,
      longitude: 16.372,
      accuracyMeters: 340,
      timestampIso: "2026-03-14T09:10:11.000Z",
      source: "browser",
    };

    expect(buildSharedLocationVisibleMessage("approximate")).toBe("Shared my approximate location.");
    expect(buildSharedLocationDispatchInput(location)).toContain("- Precision: approximate");
    expect(buildSharedLocationDispatchInput(location)).toContain("- Latitude: 48.209");
    expect(buildSharedLocationDispatchInput(location)).toContain("- Accuracy: about 340 m");
    expect(buildSharedLocationDispatchInput(location)).toContain("- Source: browser");
  });

  it("keeps precise coordinates verbatim and labels native sources", () => {
    const location: SharedLocationContext = {
      precision: "precise",
      latitude: 48.208174,
      longitude: 16.373819,
      accuracyMeters: 12.2,
      timestampIso: "2026-03-14T09:10:11.000Z",
      source: "native",
    };

    expect(buildSharedLocationVisibleMessage("precise")).toBe("Shared my precise location.");
    expect(buildSharedLocationDispatchInput(location)).toContain("- Latitude: 48.208174");
    expect(buildSharedLocationDispatchInput(location)).toContain("- Accuracy: about 12 m");
    expect(buildSharedLocationDispatchInput(location)).toContain("- Source: native app");
  });
});
