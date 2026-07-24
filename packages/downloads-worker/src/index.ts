const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const SHORT_CACHE_CONTROL = "public, max-age=120";
const DOWNLOADS_CONTRACT = "desktop-stable-pointer-v1";
const EXPOSED_RESPONSE_HEADERS =
  "Accept-Ranges, Content-Disposition, Content-Length, Content-Range, ETag, X-Instafy-Desktop-Release, X-Instafy-Downloads-Contract";
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;
const FULL_GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

type ResolvedByteRange = {
  kind: "range";
  offset: number;
  length: number;
  end: number;
};

type ByteRangeResolution = ResolvedByteRange | { kind: "ignore" } | { kind: "unsatisfiable" };

type StableReleasePointer = {
  schemaVersion: 1;
  channel: "stable";
  tag: string;
  version: string;
  sourceSha: string;
  publishedAt: string;
};

type DownloadResolution =
  | { kind: "resolved"; publicKey: string; storageKey: string; releaseTag?: string }
  | { kind: "unavailable_manifest" }
  | { kind: "missing" }
  | { kind: "invalid_pointer" };

function normalizeKey(pathname: string) {
  const trimmed = pathname.replace(/^\/+/, "");
  return trimmed;
}

function basename(key: string) {
  const idx = key.lastIndexOf("/");
  return idx >= 0 ? key.slice(idx + 1) : key;
}

function resolveDownloadsPrefix(value: string | undefined, binding: string) {
  const prefix = value?.trim() ?? "";
  if (
    !prefix ||
    prefix.startsWith("/") ||
    prefix.endsWith("/") ||
    prefix.split("/").some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))
  ) {
    throw new Error(`${binding} contains an unsafe path segment.`);
  }
  return prefix;
}

function downloadsPrefixesOverlap(left: string, right: string) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function releaseTagForSegment(segment: string) {
  if (!segment.startsWith("desktop-app-v")) return null;
  const version = segment.slice("desktop-app-v".length);
  return SEMVER.test(version) ? segment : null;
}

function cacheControlForKey(key: string, desktopPrefix: string, mobilePrefix: string) {
  if (key === `${desktopPrefix}/latest.json`) return SHORT_CACHE_CONTROL;
  const relativeKey = key.startsWith(`${desktopPrefix}/`)
    ? key.slice(desktopPrefix.length + 1)
    : "";
  if (/^(internal|stable)\/latest(?:-[a-z]+)?\.(json|yml)$/.test(relativeKey)) {
    return SHORT_CACHE_CONTROL;
  }
  const desktopTag = relativeKey.split("/", 1)[0] ?? "";
  if (releaseTagForSegment(desktopTag) && relativeKey.startsWith(`${desktopTag}/`)) {
    return IMMUTABLE_CACHE_CONTROL;
  }
  const mobileRelativeKey = key.startsWith(`${mobilePrefix}/`)
    ? key.slice(mobilePrefix.length + 1)
    : "";
  if (/^[^/]+\.(zip|manifest\.json)$/.test(mobileRelativeKey)) {
    return IMMUTABLE_CACHE_CONTROL;
  }
  return SHORT_CACHE_CONTROL;
}

function contentDispositionForKey(key: string) {
  const name = basename(key);
  if (!name) return null;

  // Prefer forcing binary downloads rather than rendering installers or OTA archives in-browser.
  if (/\.(dmg|zip|exe|appimage|tar\.gz|blockmap)$/i.test(name)) {
    return `attachment; filename="${name}"`;
  }

  return null;
}

function parseStableReleasePointer(value: unknown): StableReleasePointer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const pointer = value as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion",
    "channel",
    "tag",
    "version",
    "sourceSha",
    "publishedAt",
  ]);
  if (Object.keys(pointer).some((key) => !allowed.has(key))) return null;
  if (
    pointer.schemaVersion !== 1 ||
    pointer.channel !== "stable" ||
    typeof pointer.version !== "string" ||
    !SEMVER.test(pointer.version) ||
    pointer.tag !== `desktop-app-v${pointer.version}` ||
    typeof pointer.sourceSha !== "string" ||
    !FULL_GIT_SHA.test(pointer.sourceSha) ||
    typeof pointer.publishedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(pointer.publishedAt) ||
    Number.isNaN(Date.parse(pointer.publishedAt))
  ) {
    return null;
  }
  return pointer as StableReleasePointer;
}

async function readStableReleasePointer(bucket: R2Bucket, desktopPrefix: string) {
  const object = await bucket.get(`${desktopPrefix}/stable-release.json`);
  if (!object || !("body" in object)) return { kind: "missing" as const };
  try {
    const pointer = parseStableReleasePointer(await new Response(object.body).json());
    return pointer
      ? { kind: "available" as const, pointer }
      : { kind: "invalid" as const };
  } catch {
    return { kind: "invalid" as const };
  }
}

function versionedArtifactTag(name: string) {
  const mac = /^instafy-studio-(.+)-mac-(?:arm64|x64)\.(?:dmg|zip)(?:\.blockmap)?$/.exec(name);
  const windows = /^instafy-studio-(.+)-win\.exe(?:\.blockmap)?$/.exec(name);
  const version = mac?.[1] ?? windows?.[1];
  return version && SEMVER.test(version) ? `desktop-app-v${version}` : null;
}

async function resolveDownload(
  bucket: R2Bucket,
  key: string,
  desktopPrefix: string,
): Promise<DownloadResolution> {
  let stableName: string | null = null;
  if (key === `${desktopPrefix}/latest.json`) {
    stableName = "latest.json";
  } else if (key.startsWith(`${desktopPrefix}/stable/`)) {
    stableName = key.slice(`${desktopPrefix}/stable/`.length);
    if (!stableName || stableName.includes("/")) return { kind: "missing" };
  }

  if (stableName === null) {
    const relativeKey = key.startsWith(`${desktopPrefix}/`)
      ? key.slice(desktopPrefix.length + 1)
      : "";
    const immutableTag = relativeKey.split("/", 1)[0];
    const releaseTag = releaseTagForSegment(immutableTag) ?? undefined;
    return {
      kind: "resolved",
      publicKey: key,
      storageKey: key,
      ...(releaseTag ? { releaseTag } : {}),
    };
  }

  // Updater payload names carry their version. Resolve those directly to the
  // immutable tag so a client that fetched an older feed immediately before a
  // promotion can still complete its download after the pointer changes.
  const artifactTag = versionedArtifactTag(stableName);
  if (artifactTag) {
    return {
      kind: "resolved",
      publicKey: key,
      storageKey: `${desktopPrefix}/${artifactTag}/${stableName}`,
      releaseTag: artifactTag,
    };
  }

  const pointer = await readStableReleasePointer(bucket, desktopPrefix);
  if (pointer.kind === "missing") {
    return stableName === "latest.json"
      ? { kind: "unavailable_manifest" }
      : { kind: "missing" };
  }
  if (pointer.kind === "invalid") return { kind: "invalid_pointer" };
  return {
    kind: "resolved",
    publicKey: key,
    storageKey: `${desktopPrefix}/${pointer.pointer.tag}/${stableName}`,
    releaseTag: pointer.pointer.tag,
  };
}

function resolveSingleByteRange(value: string, objectSize: number): ByteRangeResolution {
  // Unknown units, malformed fields, and valid multipart sets are ignored per
  // RFC 9110 when this origin chooses not to implement them. A syntactically
  // valid single bytes range that cannot overlap the representation is 416.
  if (!/^bytes=/i.test(value) || value.includes(",")) return { kind: "ignore" };
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value);
  if (!match || (!match[1] && !match[2])) return { kind: "ignore" };
  if (objectSize <= 0) return { kind: "unsatisfiable" };

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { kind: "unsatisfiable" };
    const length = Math.min(suffixLength, objectSize);
    const offset = objectSize - length;
    return { kind: "range", offset, length, end: objectSize - 1 };
  }

  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= objectSize) {
    return { kind: "unsatisfiable" };
  }
  let end = objectSize - 1;
  if (match[2]) {
    const requestedEnd = Number(match[2]);
    if (!Number.isSafeInteger(requestedEnd) || requestedEnd < offset) {
      return { kind: "unsatisfiable" };
    }
    end = Math.min(requestedEnd, objectSize - 1);
  }
  return { kind: "range", offset, length: end - offset + 1, end };
}

function ifRangeMatches(value: string | null, object: R2Object) {
  if (value === null) return true;
  if (value.startsWith('"')) return value === object.httpEtag;
  const validatorTime = Date.parse(value);
  if (!Number.isFinite(validatorTime)) return false;
  // HTTP dates have second precision, while R2 upload timestamps can include
  // milliseconds. Compare at HTTP-date precision.
  return Math.floor(object.uploaded.getTime() / 1000) <= Math.floor(validatorTime / 1000);
}

function notFoundResponse() {
  return new Response("Not Found", {
    status: 404,
    headers: {
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
      "x-instafy-downloads-contract": DOWNLOADS_CONTRACT,
    },
  });
}

function invalidConfigurationResponse() {
  return new Response("Downloads Worker configuration is invalid", {
    status: 500,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-expose-headers": EXPOSED_RESPONSE_HEADERS,
      "cache-control": "no-store",
      "x-instafy-downloads-contract": DOWNLOADS_CONTRACT,
    },
  });
}

function invalidPointerResponse() {
  return new Response("Stable release metadata is invalid", {
    status: 503,
    headers: {
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
      "x-instafy-downloads-contract": DOWNLOADS_CONTRACT,
    },
  });
}

function unavailableManifestResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
      "x-instafy-downloads-contract": DOWNLOADS_CONTRACT,
    },
  });
}

function rangeNotSatisfiableResponse(objectSize: number, releaseTag?: string) {
  const headers: Record<string, string> = {
    "accept-ranges": "bytes",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": EXPOSED_RESPONSE_HEADERS,
    "content-range": `bytes */${objectSize}`,
    "x-instafy-downloads-contract": DOWNLOADS_CONTRACT,
  };
  if (releaseTag) headers["x-instafy-desktop-release"] = releaseTag;
  return new Response("Range Not Satisfiable", {
    status: 416,
    headers,
  });
}

function responseHeadersForObject(
  key: string,
  object: R2Object,
  desktopPrefix: string,
  mobilePrefix: string,
  releaseTag?: string,
) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", cacheControlForKey(key, desktopPrefix, mobilePrefix));
  headers.set("accept-ranges", "bytes");
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-expose-headers", EXPOSED_RESPONSE_HEADERS);
  headers.set("x-instafy-downloads-contract", DOWNLOADS_CONTRACT);
  if (releaseTag) headers.set("x-instafy-desktop-release", releaseTag);

  const contentDisposition = contentDispositionForKey(key);
  if (contentDisposition) headers.set("content-disposition", contentDisposition);
  return headers;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const method = request.method.toUpperCase();
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,HEAD,OPTIONS",
          "access-control-allow-headers": "Range, If-Range",
          "access-control-expose-headers": EXPOSED_RESPONSE_HEADERS,
        },
      });
    }

    if (method !== "GET" && method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: {
          allow: "GET, HEAD, OPTIONS",
          "access-control-allow-origin": "*",
        },
      });
    }

    const url = new URL(request.url);
    const key = normalizeKey(url.pathname);
    if (!key) {
      return notFoundResponse();
    }
    let desktopPrefix: string;
    let mobilePrefix: string;
    try {
      desktopPrefix = resolveDownloadsPrefix(
        env.DESKTOP_DOWNLOADS_PREFIX,
        "DESKTOP_DOWNLOADS_PREFIX",
      );
      mobilePrefix = resolveDownloadsPrefix(
        env.MOBILE_OTA_DOWNLOADS_PREFIX,
        "MOBILE_OTA_DOWNLOADS_PREFIX",
      );
      if (downloadsPrefixesOverlap(desktopPrefix, mobilePrefix)) {
        throw new Error("Desktop and mobile downloads prefixes overlap.");
      }
    } catch {
      return invalidConfigurationResponse();
    }
    const stablePointerKey = `${desktopPrefix}/stable-release.json`;
    const stablePointerContractKey = `${desktopPrefix}/stable-pointer-contract.json`;
    if (key === stablePointerContractKey) {
      return Response.json(
        { schemaVersion: 1, stableAliases: "immutable-pointer" },
        {
          headers: {
            "access-control-allow-origin": "*",
            "cache-control": "no-store",
            "x-instafy-downloads-contract": DOWNLOADS_CONTRACT,
          },
        },
      );
    }
    // The pointer is an implementation detail. Publication reads and writes it
    // through authenticated R2 APIs; public clients consume only stable aliases.
    if (key === stablePointerKey) return notFoundResponse();

    const resolution = await resolveDownload(env.DOWNLOADS_BUCKET, key, desktopPrefix);
    if (resolution.kind === "missing") return notFoundResponse();
    if (resolution.kind === "unavailable_manifest") return unavailableManifestResponse();
    if (resolution.kind === "invalid_pointer") return invalidPointerResponse();
    const { publicKey, storageKey, releaseTag } = resolution;

    if (method === "HEAD") {
      const object = await env.DOWNLOADS_BUCKET.head(storageKey);
      if (!object) return notFoundResponse();
      const headers = responseHeadersForObject(
        publicKey,
        object,
        desktopPrefix,
        mobilePrefix,
        releaseTag,
      );
      headers.set("content-length", String(object.size));
      return new Response(null, { status: 200, headers });
    }

    const rangeHeader = request.headers.get("range");
    if (rangeHeader !== null) {
      // electron-updater is explicitly configured for sequential single-range
      // requests. Unsupported forms fall back to a full representation rather
      // than pretending to be a multipart/byteranges response.
      const metadata = await env.DOWNLOADS_BUCKET.head(storageKey);
      if (!metadata) return notFoundResponse();
      const range = resolveSingleByteRange(rangeHeader, metadata.size);
      if (range.kind === "unsatisfiable") {
        return rangeNotSatisfiableResponse(metadata.size, releaseTag);
      }
      if (range.kind === "ignore" || !ifRangeMatches(request.headers.get("if-range"), metadata)) {
        const object = await env.DOWNLOADS_BUCKET.get(storageKey);
        if (!object || !("body" in object)) return notFoundResponse();
        const headers = responseHeadersForObject(
          publicKey,
          object,
          desktopPrefix,
          mobilePrefix,
          releaseTag,
        );
        headers.set("content-length", String(object.size));
        return new Response(object.body, { status: 200, headers });
      }

      const object = await env.DOWNLOADS_BUCKET.get(storageKey, {
        range: { offset: range.offset, length: range.length },
      });
      if (!object || !("body" in object)) return notFoundResponse();
      const headers = responseHeadersForObject(
        publicKey,
        object,
        desktopPrefix,
        mobilePrefix,
        releaseTag,
      );
      headers.set("content-length", String(range.length));
      headers.set("content-range", `bytes ${range.offset}-${range.end}/${metadata.size}`);
      return new Response(object.body, { status: 206, headers });
    }

    const object = await env.DOWNLOADS_BUCKET.get(storageKey);
    if (!object || !("body" in object)) return notFoundResponse();
    const headers = responseHeadersForObject(
      publicKey,
      object,
      desktopPrefix,
      mobilePrefix,
      releaseTag,
    );
    headers.set("content-length", String(object.size));

    return new Response(object.body, { status: 200, headers });
  },
};

interface Env {
  DOWNLOADS_BUCKET: R2Bucket;
  DESKTOP_DOWNLOADS_PREFIX: string;
  MOBILE_OTA_DOWNLOADS_PREFIX: string;
}
