#!/usr/bin/env node

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;
const FULL_GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SAFE_ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function normalizeDownloadsBaseUrl(value) {
  const url = new URL(requiredString(value, "downloadsBaseUrl"));
  if (url.protocol !== "https:") throw new Error("downloadsBaseUrl must use HTTPS.");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("downloadsBaseUrl must not contain credentials, a query, or a fragment.");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
}

function normalizePrefix(value) {
  const prefix = requiredString(value, "desktopPrefix").replace(/^\/+|\/+$/g, "");
  if (!prefix || prefix.split("/").some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))) {
    throw new Error("desktopPrefix must contain only safe path segments.");
  }
  return prefix;
}

function unquoteYamlScalar(raw) {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function decodeSha512(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(value)) {
    throw new Error(`${label} must be a canonical base64-encoded SHA-512 digest.`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== value) {
    throw new Error(`${label} must be a canonical base64-encoded SHA-512 digest.`);
  }
  return value;
}

export function parseDesktopUpdaterYaml(text, label = "updater metadata") {
  if (typeof text !== "string" || !text.trim()) throw new Error(`${label} is empty.`);

  let version = null;
  const files = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const versionMatch = /^version:\s*(.+?)\s*$/.exec(line);
    if (versionMatch) {
      if (version !== null) throw new Error(`${label} contains more than one top-level version.`);
      version = unquoteYamlScalar(versionMatch[1]);
      continue;
    }

    const urlMatch = /^\s*-\s+url:\s*(.+?)\s*$/.exec(line);
    if (urlMatch) {
      current = { url: unquoteYamlScalar(urlMatch[1]) };
      files.push(current);
      continue;
    }
    if (!current) continue;

    const sha512Match = /^\s+sha512:\s*(.+?)\s*$/.exec(line);
    if (sha512Match && current.sha512 === undefined) {
      current.sha512 = unquoteYamlScalar(sha512Match[1]);
      continue;
    }
    const sizeMatch = /^\s+size:\s*(\d+)\s*$/.exec(line);
    if (sizeMatch && current.size === undefined) {
      current.size = Number.parseInt(sizeMatch[1], 10);
    }
  }

  if (typeof version !== "string" || !SEMVER.test(version)) {
    throw new Error(`${label} is missing a valid top-level SemVer version.`);
  }
  if (files.length === 0) throw new Error(`${label} does not contain any files entries.`);
  for (const [index, file] of files.entries()) {
    if (typeof file.url !== "string" || !file.url) {
      throw new Error(`${label} files[${index}] is missing its URL.`);
    }
    decodeSha512(file.sha512, `${label} files[${index}].sha512`);
    if (!Number.isSafeInteger(file.size) || file.size <= 0) {
      throw new Error(`${label} files[${index}].size must be a positive safe integer.`);
    }
  }

  return { version, files };
}

function directChildArtifactUrl(rawValue, feedUrl, label) {
  const value = requiredString(rawValue, label);
  if (value.includes("\\")) throw new Error(`${label} contains an unsafe path separator.`);

  let url;
  try {
    url = new URL(value, `${feedUrl}/`);
  } catch (error) {
    throw new Error(`${label} is not a valid URL: ${error instanceof Error ? error.message : error}`);
  }
  const expectedFeed = new URL(`${feedUrl}/`);
  const encodedName = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
  const directory = url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1);
  let name;
  try {
    name = decodeURIComponent(encodedName);
  } catch {
    throw new Error(`${label} contains an invalid encoded file name.`);
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== expectedFeed.origin ||
    directory !== expectedFeed.pathname ||
    url.search ||
    url.hash ||
    !SAFE_ARTIFACT_NAME.test(name) ||
    encodeURIComponent(name) !== encodedName
  ) {
    throw new Error(`${label} must be one safe HTTPS file directly beneath ${feedUrl}.`);
  }
  return { name, url: url.href };
}

function cacheBustedUrl(value, token, attempt) {
  const url = new URL(value);
  url.searchParams.set("instafy-publication-check", `${token}-${attempt}-${Date.now()}`);
  return url.href;
}

async function retry(label, attempts, delayMs, logger, operation) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      logger.warn(
        `[desktop-publication] ${label} was not ready (attempt ${attempt}/${attempts}): ${
          error instanceof Error ? error.message : error
        }`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(
    `${label} failed after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${
      lastError instanceof Error ? lastError.message : lastError
    }`,
  );
}

async function requirePublicResponse(fetchImpl, url, options, label) {
  const {
    accept = "*/*",
    expectedStatus = 200,
    headers: additionalHeaders = {},
    timeoutMs,
    ...requestOptions
  } = options;
  const response = await fetchImpl(url, {
    ...requestOptions,
    redirect: "manual",
    headers: {
      ...additionalHeaders,
      accept: requestOptions.method === "HEAD" ? "*/*" : accept,
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status !== expectedStatus) {
    throw new Error(`${label} returned HTTP ${response.status}; expected ${expectedStatus}.`);
  }
  return response;
}

async function fetchTextWithRetry(
  context,
  url,
  label,
  validate = (text) => text,
  expectedReleaseTag,
) {
  return retry(label, context.metadataAttempts, context.retryDelayMs, context.logger, async (attempt) => {
    const response = await requirePublicResponse(
      context.fetchImpl,
      cacheBustedUrl(url, context.cacheToken, attempt),
      { method: "GET", accept: "application/json, text/yaml, text/plain", timeoutMs: 30_000 },
      label,
    );
    if (
      expectedReleaseTag &&
      response.headers.get("x-instafy-desktop-release") !== expectedReleaseTag
    ) {
      throw new Error(
        `${label} was not resolved through atomic release pointer ${expectedReleaseTag}.`,
      );
    }
    return validate(await response.text());
  });
}

async function hashPublicObject(context, entry, label) {
  return retry(label, context.artifactAttempts, context.retryDelayMs, context.logger, async (attempt) => {
    const response = await requirePublicResponse(
      context.fetchImpl,
      cacheBustedUrl(entry.url, context.cacheToken, attempt),
      { method: "GET", timeoutMs: 300_000 },
      label,
    );
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && !/^\d+$/.test(contentLength)) {
      throw new Error(`${label} returned an invalid Content-Length ${contentLength}.`);
    }
    if (entry.size !== undefined && contentLength !== null && Number.parseInt(contentLength, 10) !== entry.size) {
      throw new Error(`${label} Content-Length ${contentLength} does not match metadata size ${entry.size}.`);
    }
    if (!response.body) throw new Error(`${label} returned an empty response body.`);

    const hash = createHash("sha512");
    let size = 0;
    const maximumSize = entry.size ?? 64 * 1024 * 1024;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maximumSize) {
        throw new Error(`${label} exceeded maximum expected size ${maximumSize}.`);
      }
      hash.update(chunk);
    }
    if (entry.size !== undefined && size !== entry.size) {
      throw new Error(`${label} size ${size} does not match metadata size ${entry.size}.`);
    }
    if (entry.size === undefined && size === 0) {
      throw new Error(`${label} is empty.`);
    }
    const digest = hash.digest("base64");
    if (entry.sha512 !== undefined && digest !== entry.sha512) {
      throw new Error(`${label} SHA-512 does not match updater metadata.`);
    }
    return { size, sha512: digest };
  });
}

async function requirePublicByteRange(context, url, expectedSize, label) {
  return retry(label, context.metadataAttempts, context.retryDelayMs, context.logger, async (attempt) => {
    const response = await requirePublicResponse(
      context.fetchImpl,
      cacheBustedUrl(url, context.cacheToken, attempt),
      {
        method: "GET",
        expectedStatus: 206,
        headers: { range: "bytes=0-0" },
        timeoutMs: 30_000,
      },
      label,
    );
    if (response.headers.get("accept-ranges")?.toLowerCase() !== "bytes") {
      throw new Error(`${label} did not advertise Accept-Ranges: bytes.`);
    }
    if (response.headers.get("content-range") !== `bytes 0-0/${expectedSize}`) {
      throw new Error(`${label} returned an invalid Content-Range.`);
    }
    if (response.headers.get("content-length") !== "1") {
      throw new Error(`${label} returned an invalid ranged Content-Length.`);
    }
    if ((await response.arrayBuffer()).byteLength !== 1) {
      throw new Error(`${label} did not return exactly one byte.`);
    }
  });
}

function requireLatestJson(payload, expected, feedUrl) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("latest.json must contain a JSON object.");
  }
  if (payload.channel !== expected.channel) {
    throw new Error(`latest.json channel ${JSON.stringify(payload.channel)} does not match ${expected.channel}.`);
  }
  if (payload.version !== expected.version || !SEMVER.test(payload.version)) {
    throw new Error(`latest.json version ${JSON.stringify(payload.version)} does not match ${expected.version}.`);
  }
  if (payload.tag !== expected.tag) {
    throw new Error(`latest.json tag ${JSON.stringify(payload.tag)} does not match ${expected.tag}.`);
  }
  if (payload.sourceSha !== expected.sourceSha || !FULL_GIT_SHA.test(payload.sourceSha)) {
    throw new Error("latest.json sourceSha does not match the full release commit SHA.");
  }
  if (payload.feedUrl !== feedUrl) {
    throw new Error(`latest.json feedUrl ${JSON.stringify(payload.feedUrl)} does not match ${feedUrl}.`);
  }
  if (typeof payload.publishedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(payload.publishedAt)) {
    throw new Error("latest.json publishedAt must be a UTC second-precision timestamp.");
  }
  if (!payload.artifacts || typeof payload.artifacts !== "object" || Array.isArray(payload.artifacts)) {
    throw new Error("latest.json artifacts must be an object.");
  }

  const requiredKinds =
    expected.channel === "stable"
      ? ["macDmg", "macZip", "windowsExe"]
      : ["macDmg", "macZip", "windowsExe", "linuxAppImage"];
  const allowedKinds = new Set(requiredKinds);
  for (const kind of requiredKinds) {
    if (typeof payload.artifacts[kind] !== "string") throw new Error(`latest.json is missing ${kind}.`);
  }
  for (const kind of Object.keys(payload.artifacts)) {
    if (!allowedKinds.has(kind)) throw new Error(`latest.json contains unexpected artifact kind ${kind}.`);
  }

  const artifacts = Object.fromEntries(
    Object.entries(payload.artifacts).map(([kind, value]) => [
      kind,
      directChildArtifactUrl(value, feedUrl, `latest.json artifacts.${kind}`),
    ]),
  );
  const escapedVersion = expected.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const dmg = new RegExp(`^instafy-studio-${escapedVersion}-mac-(arm64|x64)\\.dmg$`).exec(artifacts.macDmg.name);
  const zip = new RegExp(`^instafy-studio-${escapedVersion}-mac-(arm64|x64)\\.zip$`).exec(artifacts.macZip.name);
  if (!dmg || !zip || dmg[1] !== zip[1]) {
    throw new Error("latest.json macOS artifacts must contain the expected version and one matching architecture.");
  }
  if (artifacts.windowsExe.name !== `instafy-studio-${expected.version}-win.exe`) {
    throw new Error("latest.json Windows artifact does not contain the expected version.");
  }
  if (expected.channel === "internal" && artifacts.linuxAppImage.name !== `instafy-studio-${expected.version}-linux.AppImage`) {
    throw new Error("latest.json Linux artifact does not contain the expected version.");
  }
  if (
    !payload.architectures ||
    !Array.isArray(payload.architectures.mac) ||
    payload.architectures.mac.length !== 1 ||
    payload.architectures.mac[0] !== dmg[1]
  ) {
    throw new Error("latest.json architectures.mac must match the published macOS artifacts.");
  }
  return artifacts;
}

function platformForMetadataName(name) {
  if (name === "latest-mac.yml") return "mac";
  if (name === "latest.yml") return "windows";
  if (name === "latest-linux.yml") return "linux";
  throw new Error(`Unsupported updater metadata file ${name}.`);
}

function expectedArtifactKindsForPlatform(platform) {
  if (platform === "mac") return ["macDmg", "macZip"];
  if (platform === "windows") return ["windowsExe"];
  return ["linuxAppImage"];
}

function parseExpectedUpdaterMetadata({
  artifacts,
  baseUrl,
  expectedVersion,
  metadataName,
  metadataText,
  platform,
  scope,
}) {
  const yaml = parseDesktopUpdaterYaml(metadataText, `${scope} ${metadataName}`);
  if (yaml.version !== expectedVersion) {
    throw new Error(`${scope} ${metadataName} version ${yaml.version} does not match ${expectedVersion}.`);
  }
  const entries = [];
  const names = new Set();
  for (const file of yaml.files) {
    const resolved = directChildArtifactUrl(file.url, baseUrl, `${scope} ${metadataName} file URL`);
    if (names.has(resolved.name)) {
      throw new Error(`${scope} ${metadataName} references ${resolved.name} more than once.`);
    }
    names.add(resolved.name);
    entries.push({ ...file, ...resolved });
  }
  const expectedKinds = expectedArtifactKindsForPlatform(platform);
  for (const kind of expectedKinds) {
    if (!names.has(artifacts[kind].name)) {
      throw new Error(`${scope} ${metadataName} does not checksum latest.json artifact ${artifacts[kind].name}.`);
    }
  }
  const allowedNames = new Set(expectedKinds.map((kind) => artifacts[kind].name));
  for (const name of names) {
    if (!allowedNames.has(name)) throw new Error(`${scope} ${metadataName} references unexpected artifact ${name}.`);
  }
  return entries;
}

function requireMatchingEntries(channelEntries, immutableEntries, metadataName) {
  const immutableByName = new Map(immutableEntries.map((entry) => [entry.name, entry]));
  if (immutableByName.size !== channelEntries.length || immutableEntries.length !== channelEntries.length) {
    throw new Error(`Immutable ${metadataName} does not contain the same files as the channel copy.`);
  }
  for (const entry of channelEntries) {
    const immutable = immutableByName.get(entry.name);
    if (!immutable || immutable.size !== entry.size || immutable.sha512 !== entry.sha512) {
      throw new Error(`Immutable ${metadataName} checksum or size differs for ${entry.name}.`);
    }
  }
}

export async function verifyDesktopPublicRelease(options) {
  const phase = options.phase ?? "publication";
  if (phase !== "candidate" && phase !== "publication") {
    throw new Error("phase must be candidate or publication.");
  }
  const expected = {
    channel: requiredString(options.channel, "channel"),
    version: requiredString(options.expectedVersion, "expectedVersion"),
    tag: requiredString(options.expectedTag, "expectedTag"),
    sourceSha: requiredString(options.expectedSourceSha, "expectedSourceSha"),
  };
  if (expected.channel !== "stable" && expected.channel !== "internal") {
    throw new Error("channel must be stable or internal.");
  }
  if (!SEMVER.test(expected.version)) throw new Error("expectedVersion must be valid SemVer.");
  if (!FULL_GIT_SHA.test(expected.sourceSha)) throw new Error("expectedSourceSha must be a full lowercase Git SHA.");
  if (expected.channel === "stable" && expected.tag !== `desktop-app-v${expected.version}`) {
    throw new Error("A stable expectedTag must exactly equal desktop-app-v<expectedVersion>.");
  }
  if (!SAFE_ARTIFACT_NAME.test(expected.tag)) {
    throw new Error("expectedTag must be one safe path segment.");
  }
  if (phase === "candidate" && expected.channel !== "stable") {
    throw new Error("candidate verification is supported only for stable releases.");
  }

  const downloadsBase = normalizeDownloadsBaseUrl(options.downloadsBaseUrl);
  const desktopPrefix = normalizePrefix(options.desktopPrefix ?? "desktop-app");
  const feedUrl = new URL(`${desktopPrefix}/${expected.channel}`, downloadsBase).href.replace(/\/+$/, "");
  const immutableFeedUrl = new URL(
    `${desktopPrefix}/${encodeURIComponent(expected.tag)}`,
    downloadsBase,
  ).href.replace(/\/+$/, "");
  const context = {
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    metadataAttempts: options.metadataAttempts ?? 18,
    artifactAttempts: options.artifactAttempts ?? 3,
    retryDelayMs: options.retryDelayMs ?? 10_000,
    logger: options.logger ?? console,
    cacheToken: encodeURIComponent(expected.tag),
  };
  if (typeof context.fetchImpl !== "function") throw new Error("A fetch implementation is required.");
  if (!Number.isInteger(context.metadataAttempts) || context.metadataAttempts < 1) {
    throw new Error("metadataAttempts must be a positive integer.");
  }
  if (!Number.isInteger(context.artifactAttempts) || context.artifactAttempts < 1) {
    throw new Error("artifactAttempts must be a positive integer.");
  }

  const latestUrl = `${phase === "candidate" ? immutableFeedUrl : feedUrl}/latest.json`;
  const { latest, artifacts } = await fetchTextWithRetry(
    context,
    latestUrl,
    `${phase === "candidate" ? expected.tag : expected.channel}/latest.json`,
    (latestText) => {
      let parsed;
      try {
        parsed = JSON.parse(latestText);
      } catch (error) {
        throw new Error(`latest.json is not valid JSON: ${error instanceof Error ? error.message : error}`);
      }
      return { latest: parsed, artifacts: requireLatestJson(parsed, expected, feedUrl) };
    },
    expected.channel === "stable" ? expected.tag : undefined,
  );

  if (expected.channel === "stable" && phase === "publication") {
    const aliasUrl = new URL(`${desktopPrefix}/latest.json`, downloadsBase).href;
    await fetchTextWithRetry(context, aliasUrl, `${desktopPrefix}/latest.json`, (aliasText) => {
      let alias;
      try {
        alias = JSON.parse(aliasText);
      } catch (error) {
        throw new Error(`${desktopPrefix}/latest.json is not valid JSON: ${error instanceof Error ? error.message : error}`);
      }
      if (!isDeepStrictEqual(alias, latest)) {
        throw new Error(`${desktopPrefix}/latest.json does not exactly match stable/latest.json.`);
      }
    }, expected.tag);
  }

  const metadataNames =
    expected.channel === "stable" ? ["latest-mac.yml", "latest.yml"] : ["latest-mac.yml", "latest.yml", "latest-linux.yml"];
  const channelEntriesByName = new Map();
  const immutableEntriesByName = new Map();
  for (const metadataName of metadataNames) {
    const platform = platformForMetadataName(metadataName);
    const channelMetadata =
      phase === "publication"
        ? await fetchTextWithRetry(
            context,
            `${feedUrl}/${metadataName}`,
            `${expected.channel}/${metadataName}`,
            (metadataText) => {
              return {
                text: metadataText,
                entries: parseExpectedUpdaterMetadata({
                  artifacts,
                  baseUrl: feedUrl,
                  expectedVersion: expected.version,
                  metadataName,
                  metadataText,
                  platform,
                  scope: "Channel",
                }),
              };
            },
            expected.channel === "stable" ? expected.tag : undefined,
          )
        : null;
    const immutableMetadata = await fetchTextWithRetry(
      context,
      `${immutableFeedUrl}/${metadataName}`,
      `${expected.tag}/${metadataName}`,
      (metadataText) => {
        if (channelMetadata && metadataText !== channelMetadata.text) {
          throw new Error(`Immutable ${metadataName} bytes differ from the channel copy.`);
        }
        return {
          entries: parseExpectedUpdaterMetadata({
            artifacts,
            baseUrl: immutableFeedUrl,
            expectedVersion: expected.version,
            metadataName,
            metadataText,
            platform,
            scope: "Immutable",
          }),
        };
      },
    );
    if (channelMetadata) {
      requireMatchingEntries(channelMetadata.entries, immutableMetadata.entries, metadataName);

      for (const entry of channelMetadata.entries) {
        const existing = channelEntriesByName.get(entry.name);
        if (existing && (existing.sha512 !== entry.sha512 || existing.size !== entry.size)) {
          throw new Error(`Updater feeds disagree about checksum or size for ${entry.name}.`);
        }
        channelEntriesByName.set(entry.name, entry);
      }
    }
    for (const entry of immutableMetadata.entries) {
      immutableEntriesByName.set(entry.name, entry);
    }
  }

  if (phase === "candidate") {
    for (const entry of immutableEntriesByName.values()) {
      await hashPublicObject(context, entry, `immutable candidate artifact ${entry.name}`);
    }
  } else {
    for (const entry of channelEntriesByName.values()) {
      const immutableEntry = immutableEntriesByName.get(entry.name);
      if (!immutableEntry) throw new Error(`Immutable updater feeds are missing ${entry.name}.`);
      const channelIntegrity = await hashPublicObject(context, entry, `channel artifact ${entry.name}`);
      const immutableIntegrity = await hashPublicObject(
        context,
        immutableEntry,
        `immutable artifact ${entry.name}`,
      );
      if (!isDeepStrictEqual(channelIntegrity, immutableIntegrity)) {
        throw new Error(`Immutable and channel artifact bytes differ for ${entry.name}.`);
      }
      context.logger.log(
        `[desktop-publication] Verified channel and immutable SHA-512/size for ${entry.name}.`,
      );
    }
  }

  const blockmapNames = [`${artifacts.macZip.name}.blockmap`, `${artifacts.windowsExe.name}.blockmap`];
  if (expected.channel === "internal") blockmapNames.push(`${artifacts.linuxAppImage.name}.blockmap`);
  for (const name of blockmapNames) {
    const immutableIntegrity = await hashPublicObject(
      context,
      { url: `${immutableFeedUrl}/${encodeURIComponent(name)}` },
      `immutable blockmap ${name}`,
    );
    if (phase === "publication") {
      const channelIntegrity = await hashPublicObject(
        context,
        { url: `${feedUrl}/${encodeURIComponent(name)}` },
        `channel blockmap ${name}`,
      );
      if (!isDeepStrictEqual(channelIntegrity, immutableIntegrity)) {
        throw new Error(`Immutable and channel blockmap checksum or size differs for ${name}.`);
      }
    }
  }

  const rangeProbeEntry = immutableEntriesByName.values().next().value;
  if (!rangeProbeEntry) throw new Error("No immutable artifact was available for the byte-range probe.");
  await requirePublicByteRange(
    context,
    rangeProbeEntry.url,
    rangeProbeEntry.size,
    `immutable byte-range probe ${rangeProbeEntry.name}`,
  );

  context.logger.log(
    phase === "candidate"
      ? `[desktop-publication] Verified immutable candidate ${expected.tag}: latest.json, updater feeds, ${immutableEntriesByName.size} checksummed artifacts, ${blockmapNames.length} blockmaps, and single-byte range delivery are public over HTTPS.`
      : `[desktop-publication] Verified ${expected.channel} ${expected.tag}: latest.json, channel and immutable updater feeds, ${channelEntriesByName.size} checksummed artifact pairs, ${blockmapNames.length} blockmap pairs, and single-byte range delivery are public over HTTPS.`,
  );
  return {
    feedUrl,
    artifactsVerified:
      phase === "candidate" ? immutableEntriesByName.size : channelEntriesByName.size,
    blockmapsVerified: blockmapNames.length,
  };
}

async function main() {
  await verifyDesktopPublicRelease({
    downloadsBaseUrl: process.env.DOWNLOADS_BASE_URL,
    desktopPrefix: process.env.DESKTOP_DOWNLOADS_PREFIX ?? "desktop-app",
    channel: process.env.DESKTOP_PUBLICATION_CHANNEL,
    expectedVersion: process.env.DESKTOP_PUBLICATION_VERSION,
    expectedTag: process.env.DESKTOP_PUBLICATION_TAG,
    expectedSourceSha: process.env.DESKTOP_PUBLICATION_SOURCE_SHA,
    phase: process.env.DESKTOP_PUBLICATION_PHASE ?? "publication",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[desktop-publication] ${error instanceof Error ? error.stack ?? error.message : error}`);
    process.exitCode = 1;
  });
}
