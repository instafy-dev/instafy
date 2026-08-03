import { desktopDownloadsConfig } from "../config/desktopDownloads";

export const DESKTOP_APP_BASE_URL = desktopDownloadsConfig.desktopBaseUrl;
export const DESKTOP_APP_STABLE_BASE_URL = `${DESKTOP_APP_BASE_URL}/stable`;
export const DESKTOP_APP_STABLE_LATEST_URL = `${DESKTOP_APP_STABLE_BASE_URL}/latest.json`;
export const DESKTOP_APP_PUBLIC_LATEST_URL = `${DESKTOP_APP_BASE_URL}/latest.json`;
// Every web acquisition surface uses the cache-compatible unversioned alias.
// The downloads Worker maps it and stable/latest.json through the same atomic
// release pointer, while the strict parser below rejects the old two-field file.
export const DESKTOP_APP_LATEST_URL = DESKTOP_APP_PUBLIC_LATEST_URL;

export type DesktopReleaseManifestUrl =
  | typeof DESKTOP_APP_PUBLIC_LATEST_URL
  | typeof DESKTOP_APP_STABLE_LATEST_URL;

const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const FULL_GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function isStrictSemver(value: string): boolean {
  const match = SEMVER.exec(value);
  if (!match) return false;
  const prerelease = match[1];
  if (!prerelease) return true;
  return prerelease
    .split(".")
    .every(
      (identifier) =>
        !/^\d+$/.test(identifier) || identifier === "0" || !identifier.startsWith("0"),
    );
}

export type DesktopAppDownloads = {
  macDmg: string;
  macArch: "arm64" | "x64";
  /** Absent until Windows code signing exists; the install page shows it as coming soon. */
  windowsExe?: string;
};

export type DesktopReleaseManifest = {
  version: string;
  tag: string;
  channel: "stable";
  feedUrl: typeof DESKTOP_APP_STABLE_BASE_URL;
  publishedAt: string;
  artifacts: DesktopAppDownloads;
};

export type DesktopReleaseLookup =
  | { status: "loading" }
  | { status: "available"; manifest: DesktopReleaseManifest }
  | { status: "unavailable" }
  | {
      status: "error";
      reason: "timeout" | "network" | "server" | "invalid_manifest";
    };

function parseDesktopArtifactUrl(value: unknown, expectedName: string): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    const expected = new URL(
      `${DESKTOP_APP_STABLE_BASE_URL}/${encodeURIComponent(expectedName)}`,
    );
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.href !== expected.href
    ) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

export function parseDesktopAppLatestPayload(
  payload: unknown,
): DesktopReleaseManifest | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const version = record.version;
  const tag = record.tag;
  const channel = record.channel;
  const feedUrl = record.feedUrl;
  const publishedAt = record.publishedAt;
  const sourceSha = record.sourceSha;
  const artifacts = record.artifacts;
  const architectures = record.architectures;
  if (
    typeof version !== "string" ||
    !isStrictSemver(version) ||
    tag !== `desktop-app-v${version}`
  ) {
    return null;
  }
  if (
    channel !== "stable" ||
    feedUrl !== DESKTOP_APP_STABLE_BASE_URL ||
    typeof publishedAt !== "string" ||
    Number.isNaN(Date.parse(publishedAt)) ||
    typeof sourceSha !== "string" ||
    !FULL_GIT_SHA.test(sourceSha)
  ) {
    return null;
  }
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) return null;
  if (!architectures || typeof architectures !== "object" || Array.isArray(architectures)) {
    return null;
  }

  const artifactRecord = artifacts as Record<string, unknown>;
  // macOS is present in every release; Windows only when that platform was
  // built and signed. Treating windowsExe as required made a macOS-only
  // release parse as no release at all, so the install page would report that
  // nothing is published while signed macOS installers sat in the feed.
  const requiredArtifactKinds = ["macDmg", "macZip"];
  const optionalArtifactKinds = ["windowsExe"];
  const knownArtifactKinds = [...requiredArtifactKinds, ...optionalArtifactKinds];
  if (
    requiredArtifactKinds.some((kind) => !(kind in artifactRecord)) ||
    Object.keys(artifactRecord).some((kind) => !knownArtifactKinds.includes(kind))
  ) {
    return null;
  }
  const architectureRecord = architectures as Record<string, unknown>;
  const macArchitectures = architectureRecord.mac;
  if (
    !Array.isArray(macArchitectures) ||
    macArchitectures.length !== 1 ||
    (macArchitectures[0] !== "arm64" && macArchitectures[0] !== "x64")
  ) {
    return null;
  }

  const macArch = macArchitectures[0];
  const macDmg = parseDesktopArtifactUrl(
    artifactRecord.macDmg,
    `instafy-studio-${version}-mac-${macArch}.dmg`,
  );
  const macZip = parseDesktopArtifactUrl(
    artifactRecord.macZip,
    `instafy-studio-${version}-mac-${macArch}.zip`,
  );
  if (!macDmg || !macZip) return null;

  // Optional, but not unchecked: when a Windows artifact is declared it must
  // still be a well-formed URL naming this exact version, or the manifest is
  // rejected outright rather than silently losing the platform.
  let windowsExe: string | undefined;
  if ("windowsExe" in artifactRecord) {
    const parsed = parseDesktopArtifactUrl(
      artifactRecord.windowsExe,
      `instafy-studio-${version}-win.exe`,
    );
    if (!parsed) return null;
    windowsExe = parsed;
  }

  return {
    version,
    tag,
    channel,
    feedUrl,
    publishedAt,
    artifacts: {
      macDmg,
      macArch,
      ...(windowsExe ? { windowsExe } : {}),
    },
  };
}

export async function fetchDesktopReleaseManifest(options: {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  url?: DesktopReleaseManifestUrl;
} = {}): Promise<DesktopReleaseLookup> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const url = options.url ?? DESKTOP_APP_LATEST_URL;
  try {
    const response = await fetchImpl(url, {
      signal: options.signal,
      headers: { accept: "application/json" },
    });
    if (response.status === 204) {
      return { status: "unavailable" };
    }
    if (!response.ok) {
      return { status: "error", reason: "server" };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return {
        status: "error",
        reason: options.signal?.aborted ? "timeout" : "invalid_manifest",
      };
    }
    const manifest = parseDesktopAppLatestPayload(payload);
    if (
      !manifest ||
      response.headers.get("x-instafy-desktop-release") !== manifest.tag
    ) {
      return { status: "error", reason: "invalid_manifest" };
    }
    return { status: "available", manifest };
  } catch {
    return {
      status: "error",
      reason: options.signal?.aborted ? "timeout" : "network",
    };
  }
}
