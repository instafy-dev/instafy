// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_APP_LATEST_URL,
  DESKTOP_APP_PUBLIC_LATEST_URL,
  DESKTOP_APP_STABLE_BASE_URL,
  type DesktopReleaseManifestUrl,
} from "../desktopReleaseManifest";
import {
  DESKTOP_MANIFEST_RECHECK_MS,
  useDesktopReleaseLookup,
} from "../useDesktopReleaseLookup";

function releasePayload(version = "0.2.0") {
  return {
    version,
    tag: `desktop-app-v${version}`,
    channel: "stable",
    feedUrl: DESKTOP_APP_STABLE_BASE_URL,
    publishedAt: "2026-07-22T10:00:00.000Z",
    sourceSha: "a".repeat(40),
    architectures: { mac: ["arm64"] },
    artifacts: {
      macDmg: `${DESKTOP_APP_STABLE_BASE_URL}/instafy-${version}-mac-arm64.dmg`,
      macZip: `${DESKTOP_APP_STABLE_BASE_URL}/instafy-${version}-mac-arm64.zip`,
      windowsExe: `${DESKTOP_APP_STABLE_BASE_URL}/instafy-${version}-win.exe`,
    },
  };
}

function LookupProbe({
  enabled = true,
  manifestUrl,
}: {
  enabled?: boolean;
  manifestUrl?: DesktopReleaseManifestUrl;
}) {
  const { lookup, retry } = useDesktopReleaseLookup({ enabled, manifestUrl });
  return (
    <div>
      <span data-testid="lookup-status">{lookup.status}</span>
      <span data-testid="lookup-version">
        {lookup.status === "available" ? lookup.manifest.version : ""}
      </span>
      <button type="button" onClick={retry}>Retry</button>
    </div>
  );
}

describe("useDesktopReleaseLookup", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    originalFetch = globalThis.fetch;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function flushAsyncWork() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("does no release lookup while the acquisition UI is disabled", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await act(async () => root.render(<LookupProbe enabled={false} />));
    await flushAsyncWork();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="lookup-status"]')?.textContent).toBe(
      "loading",
    );
  });

  it("can retry an unavailable feed and expose a subsequently verified release", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ status: 204, ok: true })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        headers: new Headers({
          "x-instafy-desktop-release": `desktop-app-v${releasePayload().version}`,
        }),
        json: vi.fn().mockResolvedValue(releasePayload()),
      });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await act(async () => root.render(<LookupProbe />));
    await flushAsyncWork();
    expect(container.querySelector('[data-testid="lookup-status"]')?.textContent).toBe(
      "unavailable",
    );

    const retryButton = container.querySelector<HTMLButtonElement>("button");
    await act(async () => retryButton?.click());
    await flushAsyncWork();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, DESKTOP_APP_LATEST_URL, {
      signal: expect.any(AbortSignal),
      headers: { accept: "application/json" },
    });
    expect(container.querySelector('[data-testid="lookup-status"]')?.textContent).toBe(
      "available",
    );
  });

  it("automatically discovers a release published while the page stays open", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ status: 204, ok: true })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        headers: new Headers({
          "x-instafy-desktop-release": `desktop-app-v${releasePayload().version}`,
        }),
        json: vi.fn().mockResolvedValue(releasePayload()),
      });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await act(async () => root.render(<LookupProbe />));
    await flushAsyncWork();
    expect(container.querySelector('[data-testid="lookup-status"]')?.textContent).toBe(
      "unavailable",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DESKTOP_MANIFEST_RECHECK_MS);
    });
    await flushAsyncWork();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="lookup-status"]')?.textContent).toBe(
      "available",
    );
  });

  it("periodically refreshes an available release while the page stays open", async () => {
    vi.useFakeTimers();
    const firstRelease = releasePayload("0.2.0");
    const nextRelease = releasePayload("0.2.1");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        headers: new Headers({
          "x-instafy-desktop-release": firstRelease.tag,
        }),
        json: vi.fn().mockResolvedValue(firstRelease),
      })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        headers: new Headers({
          "x-instafy-desktop-release": nextRelease.tag,
        }),
        json: vi.fn().mockResolvedValue(nextRelease),
      });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await act(async () => root.render(<LookupProbe />));
    await flushAsyncWork();
    expect(container.querySelector('[data-testid="lookup-version"]')?.textContent).toBe(
      firstRelease.version,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DESKTOP_MANIFEST_RECHECK_MS);
    });
    await flushAsyncWork();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="lookup-version"]')?.textContent).toBe(
      nextRelease.version,
    );
  });

  it("deduplicates concurrent acquisition lookups for one public alias", async () => {
    let resolveFetch: ((response: {
      status: number;
      ok: boolean;
      headers: Headers;
      json: () => Promise<ReturnType<typeof releasePayload>>;
    }) => void) | null = null;
    const fetchMock = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await act(async () => {
      root.render(
        <>
          <LookupProbe manifestUrl={DESKTOP_APP_PUBLIC_LATEST_URL} />
          <LookupProbe manifestUrl={DESKTOP_APP_PUBLIC_LATEST_URL} />
        </>,
      );
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFetch?.({
        status: 200,
        ok: true,
        headers: new Headers({
          "x-instafy-desktop-release": `desktop-app-v${releasePayload().version}`,
        }),
        json: async () => releasePayload(),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      Array.from(container.querySelectorAll('[data-testid="lookup-status"]')).map(
        (node) => node.textContent,
      ),
    ).toEqual(["available", "available"]);
  });
});
