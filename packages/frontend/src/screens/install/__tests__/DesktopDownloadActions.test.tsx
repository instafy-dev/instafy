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
        macDmg: `${DESKTOP_APP_STABLE_BASE_URL}/instafy-1.2.3-mac-arm64.dmg`,
        macArch: "arm64",
        windowsExe: `${DESKTOP_APP_STABLE_BASE_URL}/instafy-1.2.3-win.exe`,
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
      "Download for macOS (Apple silicon)",
      "Windows (EXE)",
    ]);
    expect(links[0]?.href).toBe(
      `${DESKTOP_APP_STABLE_BASE_URL}/instafy-1.2.3-mac-arm64.dmg`,
    );
  });

  it("offers macOS and names the platforms we do not ship yet in one sentence", () => {
    // Windows needs a code-signing certificate no CA issues in exportable
    // form any more, and the mac build is Apple silicon only. Both absences
    // must read as deliberate rather than as a missing or dead button: a
    // windowsExe-less manifest previously rendered <a href={undefined}>.
    // They are named in a single muted sentence, NOT as outlined chips --
    // chips sat at the same visual weight as the real download and made the
    // page's one action look like one option among disabled equals.
    const lookup = availableLookup();
    delete (lookup as { manifest: { artifacts: { windowsExe?: string } } })
      .manifest.artifacts.windowsExe;

    act(() => {
      root.render(<DesktopDownloadActions lookup={lookup} onRetry={() => {}} />);
    });

    const macLink = container.querySelector<HTMLAnchorElement>(
      'a[href$="instafy-1.2.3-mac-arm64.dmg"]',
    );
    expect(macLink?.textContent).toContain("Apple silicon");
    expect(container.querySelector('a[href="undefined"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="desktop-download-windows-coming-soon"]')
        ?.textContent,
    ).toBe("Windows");
    expect(
      container.querySelector('[data-testid="desktop-download-mac-intel-coming-soon"]')
        ?.textContent,
    ).toContain("macOS Intel");
    expect(container.textContent).toContain(
      "Windows and macOS Intel builds are coming soon.",
    );
    // The absent platforms must never render as anchors.
    const linkTexts = Array.from(container.querySelectorAll("a")).map((a) => a.textContent);
    expect(linkTexts).toEqual(["Download for macOS (Apple silicon)"]);
  });
});
