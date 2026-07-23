import { describe, expect, it } from "vitest";
import { resolvePersonalBrowserSubmitRouting } from "../useChatSubmitFlow";

describe("Personal Browser submit routing", () => {
  it("blocks an AI browser task instead of falling back while the desktop runtime is unavailable", () => {
    expect(
      resolvePersonalBrowserSubmitRouting({
        active: true,
        messageRequiresAi: true,
        runtimeOverride: null,
        terminalRequest: null,
      }),
    ).toEqual({ kind: "blocked", runtimeOverride: null });
  });

  it("pins an active Personal Browser task to its exact desktop runtime", () => {
    const runtimeOverride = {
      runtimeId: "desktop-personal-project-1",
      runtimeDisplayName: "Personal Browser on this device",
      preferRuntime: false,
    };
    expect(
      resolvePersonalBrowserSubmitRouting({
        active: true,
        messageRequiresAi: true,
        runtimeOverride,
        terminalRequest: null,
      }),
    ).toEqual({ kind: "personal", runtimeOverride });
  });

  it("leaves non-browser and terminal dispatch unchanged", () => {
    expect(
      resolvePersonalBrowserSubmitRouting({
        active: false,
        messageRequiresAi: true,
        runtimeOverride: null,
        terminalRequest: null,
      }).kind,
    ).toBe("standard");
    expect(
      resolvePersonalBrowserSubmitRouting({
        active: true,
        messageRequiresAi: true,
        runtimeOverride: null,
        terminalRequest: { command: "pwd" },
      }).kind,
    ).toBe("standard");
  });
});
