// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_APP_STABLE_BASE_URL,
  type DesktopReleaseLookup,
} from "../../../updates/desktopReleaseManifest";
import { DesktopDownloadActions } from "../DesktopDownloadActions";

function availableLookup(): DesktopReleaseLookup {
  return {
    status: "available",
    manifest: {
      version: "1.2.3",
      tag: "desktop-app-v1.2.3",
      channel: "stable",
      feedUrl: DESKTOP_APP_STABLE_BASE_URL,
      publishedAt: "2026-07-21T12:00:00Z",
      artifacts: {
        macDmg: `${DESKTOP_APP_STABLE_BASE_URL}/instafy-studio-1.2.3-mac-arm64.dmg`,
        macArch: "arm64",
        windowsExe: `${DESKTOP_APP_STABLE_BASE_URL}/instafy-studio-1.2.3-win.exe`,
      },
    },
  };
}

describe("DesktopDownloadActions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderLookup(lookup: DesktopReleaseLookup, onRetry = vi.fn()) {
    await act(async () => {
      root.render(<DesktopDownloadActions lookup={lookup} onRetry={onRetry} />);
    });
    return onRetry;
  }

  it("shows an honest loading state before publication metadata resolves", async () => {
    await renderLookup({ status: "loading" });

    expect(container.textContent).toContain("Checking for signed desktop installers");
    expect(container.querySelector("a")).toBeNull();
  });

  it("uses not-published copy only for an authoritative missing manifest", async () => {
    const onRetry = await renderLookup({ status: "unavailable" });

    expect(container.textContent).toContain("Signed desktop installers are not published yet.");
    expect(container.textContent).toContain("checks again automatically");
    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Check again");
    await act(async () => button?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("offers a retry for timeout and verification failures", async () => {
    const onRetry = await renderLookup({ status: "error", reason: "timeout" });
    const button = container.querySelector("button");

    expect(container.textContent).toContain("Desktop downloads took too long to respond.");
    expect(button?.textContent).toBe("Retry downloads");
    await act(async () => button?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders only verified platform links for an available release", async () => {
    await renderLookup(availableLookup());
    const links = Array.from(container.querySelectorAll("a"));

    expect(links.map((link) => link.textContent)).toEqual([
      "macOS Apple silicon (DMG)",
      "Windows (EXE)",
    ]);
    expect(links[0]?.href).toBe(
      `${DESKTOP_APP_STABLE_BASE_URL}/instafy-studio-1.2.3-mac-arm64.dmg`,
    );
  });
});
