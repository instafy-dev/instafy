// SPDX-License-Identifier: AGPL-3.0-only
//
// What every command that reaches the web for an agent shares (`instafy web read` today, a web search later), so the
// rules live in one place:
//
// - the link-only guard: the web-research skill's list (skill-owned data, bundled from its one file), plus what a
//   space's copy adds or makes stricter. A "no-agents" site is never fetched; a "no-reuse" site is read and marked.
//   Without a list that loads, nothing is fetched;
// - the per-turn budget and stop memory, kept under a lock file so parallel calls of one turn share it;
// - the workspace cache: in the space's own folder (`INSTAFY_CACHE_DIR`) on a runtime, so a worker whose home folder is
//   new every turn still finds robots.txt and stop records, and in `~/.cache` on a person's own computer;
// - the untrusted wrapper every page-written string goes out in;
// - the address check: every resolved address must be public, and only the checked addresses are dialled;
// - offline fixtures (`INSTAFY_WEB_FIXTURES`), honoured only by test builds: hand-written answers instead of the
//   network, labelled `fixture`, so tests and evals never touch a live site.
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import * as linkOnly from "@instafy/browser-action-policy/linkOnly";
import bundledLinkOnlySites from "virtual:instafy/link-only-sites";
import { checkPublicUrl } from "@instafy/bind/net";

/** Who read a page: this command over plain HTTP, a search provider's result list, or (test builds only) a fixture file. */
export type WebViewer = "server fetch" | "search result" | "fixture";
export const NETWORK_VIEWER: WebViewer = "server fetch";
export const SEARCH_VIEWER: WebViewer = "search result";
export const FIXTURE_VIEWER: WebViewer = "fixture";

export const UNTRUSTED_TAG = "untrusted_page_content";

// ---------------------------------------------------------------------------------------------------------------
// Link-only guard: skill-owned data, enforced here

export const LINK_ONLY_FILE = "link-only-sites.json";
export const LINK_ONLY_SCHEMA = linkOnly.LINK_ONLY_SITES_SCHEMA;
/** Where a skill folder keeps its copy of the list: the web-research skill's `references/`, or the folder itself. */
export const LINK_ONLY_PLACES: readonly string[] = [path.join("references", LINK_ONLY_FILE), LINK_ONLY_FILE];
/** The web-research skill's list as the build bundled it (from the skill's own file, so there is one source). */
export const BUNDLED_LINK_ONLY_SITES: unknown = bundledLinkOnlySites;

/**
 * A listed site an address is on: `kind` is what its terms bar ("no-agents": AI agents and automated access, so it is
 * never fetched; "no-reuse": copying, so it is read but not reused), `via` names the wrappers (translator, cache,
 * archive) it was found through.
 */
export type LinkOnlySite = { name: string; reason: string; kind: linkOnly.LinkOnlyKind; via: string[] };
export type LinkOnlyGuard = { list: linkOnly.LinkOnlyList; sources: string[]; warnings: string[] };

/** The bundled list is missing or malformed: nothing is read rather than reading without it. */
export class LinkOnlyListUnavailableError extends Error {}

const MAX_LINK_ONLY_BYTES = 256 * 1024;

/** The user's home folder: the `HOME` the command was given, else the account's. */
export function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || os.homedir();
}

/** Folders that may hold skills: `.agents/skills` in cwd and every parent, `~/.agents/skills`, and the skill packs. */
export function defaultSkillRoots(cwd: string, env: NodeJS.ProcessEnv): string[] {
  const roots: string[] = [];
  let dir = path.resolve(cwd);
  for (;;) {
    roots.push(path.join(dir, ".agents", "skills"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  roots.push(path.join(homeDir(env), ".agents", "skills"));
  const packs = env.INSTAFY_SKILL_PACKS_DIR?.trim();
  if (packs) {
    roots.push(packs);
    try {
      for (const entry of fs.readdirSync(packs, { withFileTypes: true })) {
        if (entry.isDirectory()) roots.push(path.join(packs, entry.name, "skills"));
      }
    } catch {
      // no packs here
    }
  }
  return roots;
}

/** One skill's copy of the list, or why it is left out. Never echoes the file's content. */
function readLinkOnlyCopy(file: string): { data: unknown } | { warning: string } | null {
  let real: string;
  try {
    real = fs.realpathSync(file);
  } catch {
    return null;
  }
  try {
    const stat = fs.statSync(real);
    if (!stat.isFile()) return { warning: `${file} is not a file and was ignored; the bundled list still applies` };
    if (stat.size > MAX_LINK_ONLY_BYTES) {
      return { warning: `${file} is larger than ${MAX_LINK_ONLY_BYTES} bytes and was ignored; the bundled list still applies` };
    }
    return { data: JSON.parse(fs.readFileSync(real, "utf8")) as unknown };
  } catch (error) {
    const why = error instanceof SyntaxError ? "is not valid JSON" : "could not be read";
    return { warning: `${file} ${why} and was ignored; the bundled list still applies` };
  }
}

/**
 * The list a command enforces: the bundled copy of the web-research skill's list, plus every
 * `<root>/<skill>/references/link-only-sites.json` (and `<root>/<skill>/link-only-sites.json`) a skill folder holds,
 * such as the space's own copy. A copy only adds sites and wrappers; one that is not a list is left out with a warning.
 * Throws LinkOnlyListUnavailableError, naming `command`, when the bundled copy does not load.
 */
export function loadLinkOnlyGuard(
  roots: string[],
  bundled: unknown = BUNDLED_LINK_ONLY_SITES,
  command = "`instafy web read`",
): LinkOnlyGuard {
  const additions: Array<{ data: unknown; source: string }> = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      for (const place of LINK_ONLY_PLACES) {
        const file = path.join(root, entry.name, place);
        let real: string;
        try {
          real = fs.realpathSync(file);
        } catch {
          continue;
        }
        if (seen.has(real)) continue;
        seen.add(real);
        const copy = readLinkOnlyCopy(file);
        if (!copy) continue;
        if ("warning" in copy) warnings.push(copy.warning);
        else additions.push({ data: copy.data, source: file });
      }
    }
  }
  const merged = linkOnly.linkOnlyListFrom(bundled, additions);
  if (!merged.list) {
    throw new LinkOnlyListUnavailableError(
      `The link-only site list built into ${command} could not be loaded, so nothing was read. Reinstall or update the Instafy CLI.`,
    );
  }
  return { list: merged.list, sources: merged.sources, warnings: [...warnings, ...merged.warnings] };
}

/**
 * Every skill folder's copy of a skill data file (`<root>/<skill>/references/<file>` or `<root>/<skill>/<file>`),
 * parsed, each once however many roots reach it. A copy that is not a file, is larger than 256 KB or is not JSON is
 * left out with a warning; its content is never echoed. What a copy may change is the reader's rule, not this one's.
 */
export function skillDataCopies(roots: string[], file: string): { copies: Array<{ data: unknown; source: string }>; warnings: string[] } {
  const copies: Array<{ data: unknown; source: string }> = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      for (const place of [path.join("references", file), file]) {
        const candidate = path.join(root, entry.name, place);
        let real: string;
        try {
          real = fs.realpathSync(candidate);
        } catch {
          continue;
        }
        if (seen.has(real)) continue;
        seen.add(real);
        try {
          const stat = fs.statSync(real);
          if (!stat.isFile() || stat.size > MAX_LINK_ONLY_BYTES) {
            warnings.push(`${candidate} is not a file of at most ${MAX_LINK_ONLY_BYTES} bytes and was ignored`);
            continue;
          }
          copies.push({ data: JSON.parse(fs.readFileSync(real, "utf8")) as unknown, source: candidate });
        } catch (error) {
          warnings.push(`${candidate} ${error instanceof SyntaxError ? "is not valid JSON" : "could not be read"} and was ignored`);
        }
      }
    }
  }
  return { copies, warnings };
}

/** The listed site an address is on, directly or as a wrapper's copy of it, of any kind (the strictest), or null. */
export function listedSite(url: string | URL, guard: LinkOnlyGuard): LinkOnlySite | null {
  const hit = linkOnly.linkOnlyMatch(guard.list, url);
  return hit ? { name: hit.site, reason: hit.why, kind: hit.kind, via: hit.via } : null;
}

/** The "no-agents" site an address is on, directly or as a wrapper's copy of it, or null: never fetched. */
export function linkOnlySite(url: string | URL, guard: LinkOnlyGuard): LinkOnlySite | null {
  const hit = listedSite(url, guard);
  return hit && linkOnly.barsAgents(hit) ? hit : null;
}

/** Whether a listed site keeps every agent out: any kind but "no-reuse". */
export function barsAgents(site: LinkOnlySite | linkOnly.LinkOnlySite | null): boolean {
  return linkOnly.barsAgents(site);
}

/** The "no-reuse" site a read page is on, or null, when no address of it is on a "no-agents" site. */
export function noReuseSite(urls: string[], guard: LinkOnlyGuard): LinkOnlySite | null {
  const hits = urls.map((url) => listedSite(url, guard)).filter((hit): hit is LinkOnlySite => hit !== null);
  return hits.some((hit) => linkOnly.barsAgents(hit)) ? null : (hits[0] ?? null);
}

/** "Booking.com is link-only (terms bar AI agents); this address is its copy on the Wayback Machine" */
export function linkOnlyMessage(site: LinkOnlySite): string {
  const copy = site.via.length ? `; this address is its copy on ${site.via.join(", then ")}` : "";
  return `${site.name} is link-only (${site.reason})${copy}`;
}

/** Addresses a response says it is a copy of: the Memento `Link: <…>; rel="original"` header (RFC 7089), read by the
 * matcher the Shared and Personal Browser use too. */
export function mementoOriginals(header: string | string[] | undefined, base: URL): string[] {
  return linkOnly.mementoOriginals(header, base);
}

// ---------------------------------------------------------------------------------------------------------------
// Files

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function writeFileAtomic(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn` while holding `lockFile` (created exclusively), so parallel calls of one turn take turns. A lock older than
 * `staleMs` is from a call that died and is taken over; after `waitMs` the call gives up.
 */
export async function withFileLock<T>(
  lockFile: string,
  fn: () => T | Promise<T>,
  { staleMs = 10_000, waitMs = 15_000 }: { staleMs?: number; waitMs?: number } = {},
): Promise<T> {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  const started = Date.now();
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockFile, "wx", 0o600));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > staleMs) fs.rmSync(lockFile, { force: true });
      } catch {
        // released meanwhile
      }
      if (Date.now() - started > waitMs) throw new Error(`${path.dirname(lockFile)} stayed locked`);
      await realSleep(20);
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Where the turn budget and the cache live

/**
 * The space's own folder for state that outlasts a turn (`INSTAFY_CACHE_DIR`, which the runtime gives every turn: one
 * folder per project, outside the workspace), when it is an absolute path this process can write. Null on a person's
 * own computer, where nothing sets it, and where the runtime names a folder this worker may not write.
 */
export function spaceCacheDir(env: NodeJS.ProcessEnv): string | null {
  const dir = env.INSTAFY_CACHE_DIR?.trim();
  if (!dir || !path.isAbsolute(dir)) return null;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.accessSync(dir, fs.constants.W_OK);
    return dir;
  } catch {
    return null;
  }
}

function workspaceRoot(cwd: string): string {
  let dir = path.resolve(cwd);
  for (;;) {
    if ([".git", ".agents", ".instafy"].some((name) => fs.existsSync(path.join(dir, name)))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(cwd);
    dir = parent;
  }
}

export type WebDirs = { stateDir: string; cacheDir: string };

/**
 * The turn budget and the workspace cache of one command; `what` is its folder name, such as "web-read". On a runtime both live in the space's folder
 * (`$INSTAFY_CACHE_DIR/instafy/<what>/{state,cache}`), so they survive a worker whose home folder is new every turn and
 * every worker of a turn shares one budget. Elsewhere the budget lives in `$XDG_STATE_HOME/instafy/<what>` (or
 * `~/.local/state`) and the cache in `$XDG_CACHE_HOME/instafy/<what>/<workspace hash>` (or `~/.cache`).
 */
export function webDirs(what: string, env: NodeJS.ProcessEnv, cwd: string): WebDirs {
  const space = spaceCacheDir(env);
  if (space) return { stateDir: path.join(space, "instafy", what, "state"), cacheDir: path.join(space, "instafy", what, "cache") };
  const home = homeDir(env);
  const stateBase = env.XDG_STATE_HOME?.trim() || path.join(home, ".local", "state");
  const cacheBase = env.XDG_CACHE_HOME?.trim() || path.join(home, ".cache");
  return {
    stateDir: path.join(stateBase, "instafy", what),
    cacheDir: path.join(cacheBase, "instafy", what, sha256(workspaceRoot(cwd)).slice(0, 16)),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Turn budget and stop memory

export type StopRecord<Code extends string = string> = { code: Code; message: string; at: number };
export type TurnState<Code extends string = string> = {
  v: 1;
  turn: string;
  touchedAt: number;
  loads: number;
  hosts: Record<string, { loads: number; lastAt: number }>;
  stops: Record<string, StopRecord<Code>>;
  hostStops: Record<string, StopRecord<Code>>;
  /** Hosts asked for first that did not answer this turn (hashed), so "www." added or removed is named only once. */
  unanswered?: Record<string, number>;
};

/** The site a host belongs to for caps and site-wide stops: lower case, no trailing dot, no leading "www.". */
export function siteKey(host: string): string {
  return host.toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");
}

/**
 * The keys a stop is remembered under, hashed so no address is written to disk: the address without scheme, "www.",
 * trailing slash or fragment, and the same without its query. So http/https, "?x" or a trailing slash is not a new
 * URL for a stopped one.
 */
export function stopKeys(url: URL): { exact: string; path: string } {
  const where = `${siteKey(url.hostname)}${url.pathname.replace(/\/+$/, "") || "/"}`;
  return { exact: sha256(`url:${where}${url.search}`), path: sha256(`path:${where}`) };
}

/** A local session (no Instafy turn here) lapses after this long without reads. */
export const LOCAL_TURN_IDLE_MS = 15 * 60_000;

/** The turn this call belongs to: the runtime's turn (INSTAFY_TURN_STARTED_AT), else a local session that lapses when idle. */
export function turnScope(env: NodeJS.ProcessEnv): { key: string; label: string; idleReset: boolean } {
  const started = env.INSTAFY_TURN_STARTED_AT?.trim();
  if (started) return { key: sha256(`${env.INSTAFY_PROJECT_ID ?? ""}|${started}`).slice(0, 24), label: "this turn", idleReset: false };
  return { key: "local", label: "this session (no Instafy turn here; it lapses after 15 minutes without reads)", idleReset: true };
}

export class TurnStore<Code extends string = string> {
  private readonly file: string;
  private readonly lock: string;

  constructor(
    private readonly dir: string,
    private readonly scope: { key: string; idleReset: boolean },
    private readonly now: () => number,
  ) {
    this.file = path.join(dir, `turn-${scope.key}.json`);
    this.lock = `${this.file}.lock`;
  }

  /** Runs `fn` on the turn state under a lock file, so parallel calls cannot both spend the same budget. */
  async update<T>(fn: (state: TurnState<Code>) => T): Promise<T> {
    return withFileLock(this.lock, () => {
      const now = this.now();
      let state = readJson<TurnState<Code>>(this.file);
      if (!state || state.v !== 1 || (this.scope.idleReset && now - state.touchedAt > LOCAL_TURN_IDLE_MS)) {
        state = { v: 1, turn: this.scope.key, touchedAt: now, loads: 0, hosts: {}, stops: {}, hostStops: {} };
      }
      const result = fn(state);
      state.touchedAt = now;
      writeFileAtomic(this.file, state);
      return result;
    });
  }

  /** Removes other turns' files older than two days. */
  prune() {
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (!/^turn-[\w-]+\.json$/.test(name) || name === path.basename(this.file)) continue;
        const file = path.join(this.dir, name);
        if (Date.now() - fs.statSync(file).mtimeMs > 2 * 86_400_000) fs.rmSync(file, { force: true });
      }
    } catch {
      // best effort
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Cache: entries per workspace, keyed by a hash, written only from what the command itself fetched

export class Cache<Kind extends string = string> {
  constructor(private readonly dir: string | null) {}

  // Entries are stored under the key's hash, so no requested or redirect address is written in the clear.
  private file(kind: Kind, id: string) {
    return this.dir ? path.join(this.dir, kind, `${id.slice(0, 40)}.json`) : null;
  }

  get<T>(kind: Kind, key: string, ttlMs: number, now: number): T | null {
    const id = sha256(key);
    const file = this.file(kind, id);
    if (!file) return null;
    const entry = readJson<{ key: string; savedAt: number; value: T }>(file);
    if (!entry || entry.key !== id || typeof entry.savedAt !== "number" || now - entry.savedAt > ttlMs || now < entry.savedAt - 60_000) return null;
    return entry.value;
  }

  put(kind: Kind, key: string, value: unknown, now: number) {
    const id = sha256(key);
    const file = this.file(kind, id);
    if (!file) return;
    try {
      writeFileAtomic(file, { key: id, savedAt: now, value });
    } catch {
      // a cache that cannot be written is only slower
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Untrusted wrapper

function escapeAttribute(value: string): string {
  return value.replace(/[&"<>]/g, (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c]!);
}

/** Page-written text inside <untrusted_page_content>, with any tag of that name in the text defused so it cannot close it. */
export function wrapUntrusted(text: string, url: string, readAt: string, viewer: WebViewer = NETWORK_VIEWER): string {
  const safe = text.replace(/<(\s*\/?\s*untrusted_page_content)/gi, "‹$1");
  return `<${UNTRUSTED_TAG} url="${escapeAttribute(url)}" read_at="${escapeAttribute(readAt)}" viewer="${viewer}">\n${safe}\n</${UNTRUSTED_TAG}>`;
}

// ---------------------------------------------------------------------------------------------------------------
// Address check

export type ResolvedAddress = { address: string; family: number };
export type Resolver = (host: string) => Promise<ResolvedAddress[]>;

/** Checks the URL's host (every resolved address must be public) and returns the addresses to dial, or a refusal. */
export async function checkAddress(
  url: URL,
  resolve: Resolver,
): Promise<{ addresses: string[] } | { refused: string; unresolved?: true }> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return { refused: `not a web address (${url.protocol})` };
  if (url.username || url.password) return { refused: "addresses with a user name or password are not read" };
  if (url.port && url.port !== "80" && url.port !== "443") return { refused: `port ${url.port}: only the web ports 80 and 443 are read` };
  const result = await checkPublicUrl(url.href, { lookup: (host: string) => resolve(host) });
  if (!("addresses" in result) || !result.ok) {
    const reason = "reason" in result ? result.reason : `${url.hostname} was refused`;
    // A name that does not resolve is a site that is not there, not a refused address.
    return / does not resolve /.test(reason) ? { refused: reason, unresolved: true } : { refused: reason };
  }
  if (!result.addresses.length) return { refused: `${url.hostname} has no address` };
  return { addresses: result.addresses };
}

// ---------------------------------------------------------------------------------------------------------------
// Offline fixtures (test builds only)

declare const __INSTAFY_TEST_BUILD__: boolean | undefined;

/**
 * Whether this build answers from `INSTAFY_WEB_FIXTURES`: only a test build does (built with `INSTAFY_TEST_BUILD=1`,
 * and the unit tests). The published CLI refuses the variable rather than reading the live web in its place.
 */
export const WEB_FIXTURES_ALLOWED: boolean = typeof __INSTAFY_TEST_BUILD__ === "boolean" && __INSTAFY_TEST_BUILD__;

export const WEB_FIXTURES_ENV = "INSTAFY_WEB_FIXTURES";
export const WEB_FIXTURES_FILE = "fixtures.json";
export const WEB_FIXTURES_SCHEMA = "instafy.web-fixtures@1";
/** What a fixture host resolves to when the fixtures name no address for it: a public address that is never dialled. */
export const FIXTURE_DEFAULT_ADDRESS = "93.184.216.34";

/** `INSTAFY_WEB_FIXTURES` is set in a build that does not honour it, or names fixtures that do not load. */
export class WebFixturesError extends Error {}

/** One hand-written answer. */
export type WebFixtureAnswer = { status: number; headers: Record<string, string>; body: Buffer };

/** What a request sends, for fixtures that answer a POST (a search API) by its JSON body. */
export type WebFixtureRequest = { method?: "GET" | "POST"; body?: unknown };

export type WebFixtures = {
  folder: string;
  /** Fixture DNS: the host's listed addresses, a public stand-in for a host that has pages, otherwise "does not resolve". */
  resolve: Resolver;
  /** The answer to a request of this address (a GET unless `request` says otherwise): its page, or a plain 404 for an
   * address and method the fixtures do not list. */
  answer(url: URL, request?: WebFixtureRequest): WebFixtureAnswer;
};

type FixtureEntry = {
  status?: unknown;
  type?: unknown;
  headers?: unknown;
  body?: unknown;
  file?: unknown;
  method?: unknown;
  requestBody?: unknown;
};

/** JSON with its object keys sorted, so two bodies compare by content. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const FIXTURE_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json",
  ".xml": "application/xml",
};
const MAX_FIXTURES_BYTES = 4 * 1024 * 1024;

/** The fixture folder this call reads from, or null for the network. Throws WebFixturesError outside a test build. */
export function webFixturesFolder(env: NodeJS.ProcessEnv, cwd: string): string | null {
  const raw = env[WEB_FIXTURES_ENV]?.trim();
  if (!raw) return null;
  if (!WEB_FIXTURES_ALLOWED) {
    throw new WebFixturesError(
      `${WEB_FIXTURES_ENV} is set, but only a test build of the Instafy CLI answers from fixtures, so nothing was read. Unset it to read the web.`,
    );
  }
  return path.resolve(cwd, raw);
}

function fixtureKey(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  return url.href;
}

/**
 * Loads `<folder>/fixtures.json`:
 *
 *     { "schema": "instafy.web-fixtures@1",
 *       "hosts": { "intranet.example": ["10.0.0.5"] },
 *       "pages": { "https://news.example/a": { "file": "a.html" },
 *                  "https://news.example/robots.txt": { "body": "User-agent: *\nDisallow: /private", "type": "text/plain" },
 *                  "https://busy.example/": { "status": 429 },
 *                  "https://old.example/": { "status": 301, "headers": { "location": "https://news.example/a" } },
 *                  "https://api.search.example/v1/search": [
 *                    { "method": "POST", "requestBody": { "query": "ramen" }, "file": "ramen.json" } ] } }
 *
 * A page's body is `body` or the file `file` names inside the folder; its type follows the file's extension unless
 * `type` says otherwise (HTML by default). An entry answers a GET unless its `method` is "POST"; with `requestBody` it
 * answers only a request whose JSON body has that content. An address may list several such entries; the first that
 * matches answers. An address or method that is not listed answers 404 (so a missing robots.txt means no rules), and a
 * host with no page and no listed address does not resolve.
 */
export function loadWebFixtures(folder: string): WebFixtures {
  const root = (() => {
    try {
      return fs.realpathSync(folder);
    } catch {
      throw new WebFixturesError(`${WEB_FIXTURES_ENV} names ${folder}, which is not a folder, so nothing was read.`);
    }
  })();
  const manifestFile = path.join(root, WEB_FIXTURES_FILE);
  let manifest: { schema?: unknown; hosts?: unknown; pages?: unknown };
  try {
    if (fs.statSync(manifestFile).size > MAX_FIXTURES_BYTES) throw new Error("too large");
    manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as typeof manifest;
  } catch {
    throw new WebFixturesError(`${manifestFile} is missing or not valid JSON, so nothing was read.`);
  }
  if (!manifest || manifest.schema !== WEB_FIXTURES_SCHEMA || typeof manifest.pages !== "object" || manifest.pages === null) {
    throw new WebFixturesError(`${manifestFile} is not a ${WEB_FIXTURES_SCHEMA} file with "pages", so nothing was read.`);
  }
  const pages = new Map<string, FixtureEntry[]>();
  const pageHosts = new Set<string>();
  for (const [address, value] of Object.entries(manifest.pages as Record<string, unknown>)) {
    let key: string;
    try {
      key = fixtureKey(address);
    } catch {
      throw new WebFixturesError(`${manifestFile}: "${address.slice(0, 200)}" is not an address.`);
    }
    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new WebFixturesError(`${manifestFile}: the page ${key} is not an object.`);
      const method = (entry as FixtureEntry).method;
      if (method !== undefined && method !== "GET" && method !== "POST") {
        throw new WebFixturesError(`${manifestFile}: the page ${key} has a method other than GET or POST.`);
      }
    }
    pages.set(key, entries as FixtureEntry[]);
    pageHosts.add(new URL(key).hostname.toLowerCase());
  }
  const hosts = new Map<string, string[]>();
  for (const [host, addresses] of Object.entries((manifest.hosts ?? {}) as Record<string, unknown>)) {
    if (!Array.isArray(addresses) || !addresses.every((address) => typeof address === "string" && net.isIP(address))) {
      throw new WebFixturesError(`${manifestFile}: the host ${host} needs a list of IP addresses.`);
    }
    hosts.set(host.toLowerCase().replace(/\.+$/, ""), addresses as string[]);
  }

  const body = (key: string, entry: FixtureEntry): Buffer => {
    if (typeof entry.body === "string") return Buffer.from(entry.body, "utf8");
    if (typeof entry.file !== "string") return Buffer.alloc(0);
    const file = path.resolve(root, entry.file);
    let real: string;
    try {
      real = fs.realpathSync(file);
    } catch {
      throw new WebFixturesError(`${manifestFile}: the file of ${key} (${entry.file}) does not exist.`);
    }
    if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
      throw new WebFixturesError(`${manifestFile}: the file of ${key} is outside the fixture folder.`);
    }
    return fs.readFileSync(real);
  };

  return {
    folder: root,
    resolve: async (host) => {
      const name = host.toLowerCase().replace(/\.+$/, "");
      const listed = hosts.get(name) ?? (pageHosts.has(name) ? [FIXTURE_DEFAULT_ADDRESS] : null);
      if (!listed) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host} (not in the fixtures)`), { code: "ENOTFOUND" });
      return listed.map((address) => ({ address, family: net.isIP(address) }));
    },
    answer(url, request = {}) {
      const key = fixtureKey(url.href);
      const method = request.method ?? "GET";
      const sent = request.body === undefined ? null : canonicalJson(request.body);
      const entry = (pages.get(key) ?? []).find(
        (candidate) =>
          (candidate.method ?? "GET") === method &&
          (candidate.requestBody === undefined || (sent !== null && canonicalJson(candidate.requestBody) === sent)),
      );
      if (!entry) return { status: 404, headers: { "content-type": "text/plain; charset=utf-8" }, body: Buffer.from("not found") };
      const headers: Record<string, string> = {};
      if (entry.headers && typeof entry.headers === "object") {
        for (const [name, value] of Object.entries(entry.headers as Record<string, unknown>)) {
          if (typeof value === "string") headers[name.toLowerCase()] = value;
        }
      }
      const extension = typeof entry.file === "string" ? path.extname(entry.file).toLowerCase() : "";
      headers["content-type"] ??=
        typeof entry.type === "string" ? entry.type : (FIXTURE_TYPES[extension] ?? (extension ? "application/octet-stream" : FIXTURE_TYPES[".html"]!));
      const status = typeof entry.status === "number" && Number.isInteger(entry.status) ? entry.status : 200;
      return { status, headers, body: body(key, entry) };
    },
  };
}
