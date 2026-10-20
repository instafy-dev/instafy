// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Capacitor } from "@capacitor/core";
import { Browser } from "@capacitor/browser";
import { openExternalUrl, reserveExternalWindow } from "../openExternalUrl";

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

describe("reserveExternalWindow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
  });

  function fakeWindow() {
    return { opener: {} as unknown, closed: false, close: vi.fn(), location: { replace: vi.fn() } };
  }

  it("opens the tab during the press and shows the address once it is known", async () => {
    const reserved = fakeWindow();
    const windowOpen = vi.spyOn(window, "open").mockReturnValue(reserved as unknown as Window);

    const pending = reserveExternalWindow();
    // Synchronously, before anything is awaited, with no opener.
    expect(windowOpen).toHaveBeenCalledExactlyOnceWith("about:blank", "_blank");
    expect(reserved.opener).toBeNull();
    expect(pending.blocked).toBe(false);

    await expect(pending.open("https://example.com/later")).resolves.toBe(true);
    expect(reserved.location.replace).toHaveBeenCalledWith("https://example.com/later");
    expect(reserved.close).not.toHaveBeenCalled();
  });

  it("reports a blocked tab, and closes a reserved one it cannot use", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const blocked = reserveExternalWindow();
    expect(blocked.blocked).toBe(true);
    await expect(blocked.open("https://example.com/later")).resolves.toBe(false);

    const reserved = fakeWindow();
    vi.spyOn(window, "open").mockReturnValue(reserved as unknown as Window);
    const pending = reserveExternalWindow();
    await expect(pending.open("javascript:alert(1)")).resolves.toBe(false);
    expect(reserved.location.replace).not.toHaveBeenCalled();
    expect(reserved.close).toHaveBeenCalled();

    const closedByPerson = fakeWindow();
    vi.spyOn(window, "open").mockReturnValue(closedByPerson as unknown as Window);
    const later = reserveExternalWindow();
    closedByPerson.closed = true;
    await expect(later.open("https://example.com/later")).resolves.toBe(false);
  });

  it("opens nothing up front in a native shell, and uses the system browser", async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(Browser.open).mockResolvedValue(undefined);
    const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);

    const pending = reserveExternalWindow();
    expect(pending.blocked).toBe(false);
    expect(windowOpen).not.toHaveBeenCalled();
    await expect(pending.open("https://example.com/later")).resolves.toBe(true);
    expect(Browser.open).toHaveBeenCalledWith({ url: "https://example.com/later" });
  });
});
