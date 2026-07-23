// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Capacitor } from "@capacitor/core";
import { Browser } from "@capacitor/browser";
import { openExternalUrl } from "../openExternalUrl";

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: vi.fn(),
  },
}));

vi.mock("@capacitor/browser", () => ({
  Browser: {
    open: vi.fn(),
  },
}));

describe("openExternalUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
  });

  it("uses the Capacitor browser for native login URLs", async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(Browser.open).mockResolvedValue(undefined);
    const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);

    await expect(openExternalUrl("https://example.com/device")).resolves.toBe(true);

    expect(Browser.open).toHaveBeenCalledWith({ url: "https://example.com/device" });
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it("keeps the normal new-tab behavior on the web", async () => {
    const opened = {} as Window;
    const windowOpen = vi.spyOn(window, "open").mockReturnValue(opened);

    await expect(openExternalUrl("https://example.com/device")).resolves.toBe(true);

    expect(windowOpen).toHaveBeenCalledWith(
      "https://example.com/device",
      "_blank",
      "noopener,noreferrer",
    );
    expect(Browser.open).not.toHaveBeenCalled();
  });

  it("rejects empty and non-web URLs", async () => {
    const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);

    await expect(openExternalUrl("javascript:alert(1)")).resolves.toBe(false);
    await expect(openExternalUrl("   ")).resolves.toBe(false);

    expect(windowOpen).not.toHaveBeenCalled();
    expect(Browser.open).not.toHaveBeenCalled();
  });
});
