export function normalizeWorkspaceRelativePath(path: string): string {
  const trimmed = (path ?? "").trim().replace(/\\+/g, "/");
  const withoutRoot = trimmed.replace(/^\/+/, "");
  const segments = withoutRoot
    .split("/")
    .filter(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    );
  return segments.join("/");
}

export function decodeBase64(encoded: string): Uint8Array {
  if (typeof encoded !== "string" || encoded.length === 0) {
    return new Uint8Array();
  }
  if (typeof atob === "function") {
    const binary = atob(encoded);
    const length = binary.length;
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }
  const globalBuffer =
    typeof globalThis !== "undefined"
      ? (globalThis as Record<string, unknown>).Buffer
      : undefined;
  if (typeof globalBuffer === "function") {
    const buffer = (
      globalBuffer as unknown as {
        from: (
          input: string,
          encoding: string,
        ) => Uint8Array & {
          buffer: ArrayBuffer;
          byteOffset: number;
          length: number;
        };
      }
    ).from(encoded, "base64");
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);
  }
  throw new Error("Base64 decoding is not supported in this environment.");
}

export function bytesToUtf8(bytes: Uint8Array): string {
  if (!bytes || bytes.length === 0) {
    return "";
  }
  if (typeof TextDecoder !== "undefined") {
    try {
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch (_error) {
      // fall through
    }
  }
  const globalBuffer =
    typeof globalThis !== "undefined"
      ? (globalThis as Record<string, unknown>).Buffer
      : undefined;
  if (typeof globalBuffer === "function") {
    const buffer = (
      globalBuffer as unknown as {
        from: (input: Uint8Array) => {
          toString: (encoding?: string) => string;
        };
      }
    ).from(bytes);
    return buffer.toString("utf-8");
  }
  let result = "";
  for (let index = 0; index < bytes.length; index += 1) {
    result += String.fromCharCode(bytes[index] ?? 0);
  }
  return result;
}

const TEXT_MIME_PREFIXES = ["text/"];
const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/javascript",
  "application/typescript",
  "application/xml",
  "application/xhtml+xml",
  "application/x-yaml",
  "application/yaml",
  "application/graphql",
  "application/x-sh",
  "application/x-shellscript",
  "application/sql",
  "application/x-httpd-php",
  "image/svg+xml",
]);
const TEXT_FILE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "css",
  "scss",
  "sass",
  "less",
  "html",
  "htm",
  "md",
  "mdx",
  "txt",
  "yaml",
  "yml",
  "graphql",
  "gql",
  "sql",
  "py",
  "rb",
  "rs",
  "go",
  "java",
  "kt",
  "c",
  "h",
  "cpp",
  "hpp",
  "m",
  "swift",
  "sh",
  "bash",
  "zsh",
  "env",
  "lock",
  "toml",
  "ini",
  "conf",
  "config",
  "prisma",
  "php",
  "pl",
  "lua",
  "hs",
  "svg",
]);

export function isTextLikeFile(
  mimeType: string | null,
  path: string,
  bytes: Uint8Array,
): boolean {
  const lowerMime = mimeType?.toLowerCase() ?? null;
  if (lowerMime) {
    if (TEXT_MIME_PREFIXES.some((prefix) => lowerMime.startsWith(prefix))) {
      return true;
    }
    if (TEXT_MIME_TYPES.has(lowerMime)) {
      return true;
    }
    if (lowerMime.startsWith("image/") && lowerMime !== "image/svg+xml") {
      return false;
    }
  }

  const extension = extractExtension(path);
  if (extension && TEXT_FILE_EXTENSIONS.has(extension)) {
    return true;
  }

  if (lowerMime && lowerMime.startsWith("image/")) {
    return false;
  }

  return !looksBinary(bytes);
}

function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 32);
  for (let index = 0; index < limit; index += 1) {
    const value = bytes[index] ?? 0;
    if (value === 0) {
      return true;
    }
  }
  return false;
}

export function extractExtension(path: string): string | null {
  if (!path) {
    return null;
  }
  const normalized = path.trim();
  const lastSlash = normalized.lastIndexOf("/");
  const fileName =
    lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === fileName.length - 1) {
    return null;
  }
  return fileName.slice(lastDot + 1).toLowerCase();
}
