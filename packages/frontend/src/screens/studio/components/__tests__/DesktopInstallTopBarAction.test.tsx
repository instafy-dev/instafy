// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_APP_PUBLIC_LATEST_URL,
  DESKTOP_APP_STABLE_BASE_URL,
} from "../../../../updates/desktopReleaseManifest";
import { useDesktopReleaseLookup } from "../../../../updates/useDesktopReleaseLookup";
import { DesktopInstallTopBarAction } from "../DesktopInstallTopBarAction";

vi.mock("../../../../updates/useDesktopReleaseLookup", () => ({
  useDesktopReleaseLookup: vi.fn(),
}));

const useDesktopReleaseLookupMock = vi.mocked(useDesktopReleaseLookup);

function availableLookup(): ReturnType<typeof useDesktopReleaseLookup> {
  const version = "0.2.0";
  return {
    lookup: {
      status: "available" as const,
      manifest: {
        version,
        tag: `desktop-app-v${version}`,
        channel: "stable" as const,
        feedUrl: DESKTOP_APP_STABLE_BASE_URL,
        publishedAt: "2026-07-22T10:00:00.000Z",
        artifacts: {
          macDmg: `${DESKTOP_APP_STABLE_BASE_URL}/instafy-${version}-mac-arm64.dmg`,
          macArch: "arm64" as const,
          windowsExe: `${DESKTOP_APP_STABLE_BASE_URL}/instafy-${version}-win.exe`,
        },
      },
    },
    retry: vi.fn(),
  };
}

describe("DesktopInstallTopBarAction", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    delete window.instafyDesktop;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete window.instafyDesktop;
    vi.clearAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderAction(enabled = true) {
    await act(async () => {
      root.render(<DesktopInstallTopBarAction enabled={enabled} />);
    });
  }

  it("links a verified web release to the Desktop section without replacing Studio", async () => {
    useDesktopReleaseLookupMock.mockReturnValue(availableLookup());

    await renderAction();

    const link = container.querySelector<HTMLAnchorElement>(
      '[data-testid="topbar-get-desktop"]',
    );
    expect(link?.getAttribute("href")).toBe("/install#desktop");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noreferrer");
    expect(link?.getAttribute("title")).toContain("v0.2.0");
    expect(useDesktopReleaseLookupMock).toHaveBeenCalledWith({
      enabled: true,
      manifestUrl: DESKTOP_APP_PUBLIC_LATEST_URL,
    });
  });

  it.each(["loading", "unavailable", "error"] as const)(
    "does not advertise an installer while lookup status is %s",
    async (status) => {
      useDesktopReleaseLookupMock.mockReturnValue({
        lookup:
          status === "error"
            ? { status, reason: "network" }
            : { status },
        retry: vi.fn(),
      });

      await renderAction();

      expect(container.querySelector('[data-testid="topbar-get-desktop"]')).toBeNull();
    },
  );

  it("does not fetch or render outside the wide-screen posture", async () => {
    useDesktopReleaseLookupMock.mockReturnValue(availableLookup());

    await renderAction(false);

    expect(container.querySelector('[data-testid="topbar-get-desktop"]')).toBeNull();
    expect(useDesktopReleaseLookupMock).toHaveBeenCalledWith({
      enabled: false,
      manifestUrl: DESKTOP_APP_PUBLIC_LATEST_URL,
    });
  });

  it("stays hidden inside Instafy Desktop", async () => {
    window.instafyDesktop = {} as typeof window.instafyDesktop;
    useDesktopReleaseLookupMock.mockReturnValue(availableLookup());

    await renderAction();

    expect(container.querySelector('[data-testid="topbar-get-desktop"]')).toBeNull();
    expect(useDesktopReleaseLookupMock).toHaveBeenCalledWith({
      enabled: false,
      manifestUrl: DESKTOP_APP_PUBLIC_LATEST_URL,
    });
  });
});
