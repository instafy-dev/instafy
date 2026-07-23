import fs from "node:fs";
import path from "node:path";

const FALLBACK_HELPER_VALUE = "!instafy git credential";
const HELPER_MARKER = "INSTAFY_GIT_HELPER=1";

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:.,@%+=-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resolveCliEntrypoint(argv: string[] = process.argv): string | null {
  const entrypoint = argv[1];
  if (!entrypoint) {
    return null;
  }
  const resolved = path.resolve(entrypoint);
  try {
    const stat = fs.statSync(resolved);
    return stat.isFile() ? resolved : null;
  } catch {
    return null;
  }
}

export function buildInstafyGitCredentialHelperValue(options?: {
  argv?: string[];
  execPath?: string;
}): string {
  const entrypoint = resolveCliEntrypoint(options?.argv ?? process.argv);
  const execPath = options?.execPath ?? process.execPath;
  if (!entrypoint || !execPath) {
    return FALLBACK_HELPER_VALUE;
  }
  return `!${HELPER_MARKER} ${shellQuote(execPath)} ${shellQuote(entrypoint)} git credential`;
}

export function isInstafyGitCredentialHelper(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("instafy git credential") ||
    normalized.includes(HELPER_MARKER) ||
    (normalized.includes("instafy.js") && normalized.includes(" git credential"))
  );
}
