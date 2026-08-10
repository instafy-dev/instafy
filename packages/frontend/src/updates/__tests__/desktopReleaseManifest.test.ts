import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_APP_LATEST_URL,
  DESKTOP_APP_PUBLIC_LATEST_URL,
  DESKTOP_APP_STABLE_BASE_URL,
  DESKTOP_APP_STABLE_LATEST_URL,
  fetchDesktopReleaseManifest,
  parseDesktopAppLatestPayload,
} from "../desktopReleaseManifest";

const VERSION = "1.2.3";

function validManifest() {
  return {
    tag: `desktop-app-v${VERSION}`,
    version: VERSION,
    channel: "stable",
    sourceSha: "a".repeat(40),
    publishedAt: "2026-07-21T12:00:00Z",
    feedUrl: DESKTOP_APP_STABLE_BASE_URL,
    architectures: { mac: ["arm64"] },
    artifacts: {
      macDmg: `${DESKTOP_APP_STABLE_BASE_URL}/instafy-${VERSION}-mac-arm64.dmg`,
      macZip: `${DESKTOP_APP_STABLE_BASE_URL}/instafy-${VERSION}-mac-arm64.zip`,
      windowsExe: `${DESKTOP_APP_STABLE_BASE_URL}/instafy-${VERSION}-win.exe`,
    },
  };
}

describe("parseDesktopAppLatestPayload", () => {
  it("accepts the signed stable publication contract", () => {
    expect(parseDesktopAppLatestPayload(validManifest())).toEqual({
      version: VERSION,
      tag: `desktop-app-v${VERSION}`,
      channel: "stable",
      feedUrl: DESKTOP_APP_STABLE_BASE_URL,
      publishedAt: "2026-07-21T12:00:00Z",
      artifacts: {
        macDmg: `${DESKTOP_APP_STABLE_BASE_URL}/instafy-${VERSION}-mac-arm64.dmg`,
        macArch: "arm64",
        windowsExe: `${DESKTOP_APP_STABLE_BASE_URL}/instafy-${VERSION}-win.exe`,
      },
    });
  });

  it("rejects artifacts that do not exactly match the release version and feed", () => {
    const payload = validManifest();
    payload.artifacts.macDmg =
      `${DESKTOP_APP_STABLE_BASE_URL}/archive/instafy-${VERSION}-mac-arm64.dmg`;

    expect(parseDesktopAppLatestPayload(payload)).toBeNull();
  });

  it("rejects incomplete updater artifacts even when direct installers exist", () => {
    const payload = validManifest();
    const artifacts = payload.artifacts as Partial<typeof payload.artifacts>;
    delete artifacts.macZip;

    expect(parseDesktopAppLatestPayload(payload)).toBeNull();
  });

  it("rejects unsigned Linux artifacts in the stable manifest", () => {
    const payload = validManifest() as ReturnType<typeof validManifest> & {
      artifacts: ReturnType<typeof validManifest>["artifacts"] & { linuxAppImage: string };
    };
    payload.artifacts.linuxAppImage =
      `${DESKTOP_APP_STABLE_BASE_URL}/instafy-${VERSION}-linux.AppImage`;

    expect(parseDesktopAppLatestPayload(payload)).toBeNull();
  });
});

describe("fetchDesktopReleaseManifest", () => {
  it("returns available only after parsing a verified manifest", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(validManifest()), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-instafy-desktop-release": `desktop-app-v${VERSION}`,
        },
      }),
    );

    const result = await fetchDesktopReleaseManifest({ fetchImpl });

    expect(result.status).toBe("available");
    expect(fetchImpl).toHaveBeenCalledWith(DESKTOP_APP_LATEST_URL, {
      signal: undefined,
      headers: { accept: "application/json" },
    });
    expect(DESKTOP_APP_LATEST_URL).toBe(DESKTOP_APP_PUBLIC_LATEST_URL);
  });

  it("can verify the stable-path alias with the same strict parser", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(validManifest()), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-instafy-desktop-release": `desktop-app-v${VERSION}`,
        },
      }),
    );

    const result = await fetchDesktopReleaseManifest({
      fetchImpl,
      url: DESKTOP_APP_STABLE_LATEST_URL,
    });

    expect(result.status).toBe("available");
    expect(fetchImpl).toHaveBeenCalledWith(DESKTOP_APP_STABLE_LATEST_URL, {
      signal: undefined,
      headers: { accept: "application/json" },
    });
  });

  it("reserves unavailable for the Worker's authoritative no-release response", async () => {
    const missing = await fetchDesktopReleaseManifest({
      fetchImpl: vi.fn().mockResolvedValue(new Response("missing", { status: 404 })),
    });
    const notPublishedYet = await fetchDesktopReleaseManifest({
      fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    });

    expect(missing).toEqual({ status: "error", reason: "server" });
    expect(notPublishedYet).toEqual({ status: "unavailable" });
  });

  it("classifies malformed and transient responses as retryable errors", async () => {
    const malformed = await fetchDesktopReleaseManifest({
      fetchImpl: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ version: VERSION }), { status: 200 }),
      ),
    });
    const server = await fetchDesktopReleaseManifest({
      fetchImpl: vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })),
    });
    const network = await fetchDesktopReleaseManifest({
      fetchImpl: vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    });

    expect(malformed).toEqual({ status: "error", reason: "invalid_manifest" });
    expect(server).toEqual({ status: "error", reason: "server" });
    expect(network).toEqual({ status: "error", reason: "network" });
  });

  it("rejects a valid-looking manifest that bypasses the atomic Worker pointer", async () => {
    const missingHeader = await fetchDesktopReleaseManifest({
      fetchImpl: vi.fn().mockResolvedValue(
        new Response(JSON.stringify(validManifest()), { status: 200 }),
      ),
    });
    const wrongRelease = await fetchDesktopReleaseManifest({
      fetchImpl: vi.fn().mockResolvedValue(
        new Response(JSON.stringify(validManifest()), {
          status: 200,
          headers: { "x-instafy-desktop-release": "desktop-app-v9.9.9" },
        }),
      ),
    });

    expect(missingHeader).toEqual({ status: "error", reason: "invalid_manifest" });
    expect(wrongRelease).toEqual({ status: "error", reason: "invalid_manifest" });
  });

  it("rejects the legacy unversioned two-field metadata instead of showing an old release", async () => {
    const result = await fetchDesktopReleaseManifest({
      fetchImpl: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ tag: "desktop-app-v0.1.2", version: "0.1.2" }),
          { status: 200 },
        ),
      ),
    });

    expect(result).toEqual({ status: "error", reason: "invalid_manifest" });
  });

  it("rejects build metadata that would make artifact URL encoding ambiguous", () => {
    const payload = validManifest();
    payload.version = "1.2.3+signed.1";
    payload.tag = "desktop-app-v1.2.3+signed.1";

    expect(parseDesktopAppLatestPayload(payload)).toBeNull();
  });

  it.each(["1.2.3-01", "1.2.3-alpha.01", "1.2.3-00.beta"])(
    "rejects a numeric prerelease identifier with leading zeroes: %s",
    (version) => {
      const payload = validManifest();
      payload.version = version;
      payload.tag = `desktop-app-v${version}`;

      expect(parseDesktopAppLatestPayload(payload)).toBeNull();
    },
  );

  it.each(["1.2.3-0", "1.2.3-alpha.0", "1.2.3-01a"])(
    "accepts a valid SemVer prerelease identifier: %s",
    (version) => {
      const payload = validManifest();
      payload.version = version;
      payload.tag = `desktop-app-v${version}`;
      payload.artifacts.macDmg =
        `${DESKTOP_APP_STABLE_BASE_URL}/instafy-${version}-mac-arm64.dmg`;
      payload.artifacts.macZip =
        `${DESKTOP_APP_STABLE_BASE_URL}/instafy-${version}-mac-arm64.zip`;
      payload.artifacts.windowsExe =
        `${DESKTOP_APP_STABLE_BASE_URL}/instafy-${version}-win.exe`;

      expect(parseDesktopAppLatestPayload(payload)?.version).toBe(version);
    },
  );

  it("identifies an aborted request as a timeout instead of no release", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await fetchDesktopReleaseManifest({
      signal: controller.signal,
      fetchImpl: vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError")),
    });

    expect(result).toEqual({ status: "error", reason: "timeout" });
  });
});
