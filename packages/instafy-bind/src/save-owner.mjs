// The save owner of a site's own writes: one mechanism for every site backend. A backend that ships elsewhere carries
// this file byte for byte.
//
// A site backend (the binder, a map host) writes data files between turns, on behalf of a click: records and
// data/version.json. In an Instafy space nothing owned those writes. No turn reported them, so they sat as changed
// files in the space's checkout until a stop parked them as "unsaved work", and Studio told everyone that some work
// wasn't saved.
//
// The backend now owns them. In a folder of an Instafy space (a `.instafy/.git` checkout above the site), it commits
// the files it wrote to the checkout's branch, locally, a few seconds after the last write. That is the save path a
// turn's own commits take: the next pre-turn refresh, turn save or stop publishes the branch's commits to canonical.
// No credential and no network call are involved.
//
// The commit is made the way the space's origin changes the checkout, so the two never interleave:
// - Under the origin's own workspace lock (`.instafy/origin-apply.lock`, an exclusive flock). While the origin
//   publishes, refreshes or flushes for a stop, the save waits and is tried again a few seconds later.
// - With git plumbing only: the bytes the backend wrote are hashed with no filters into a temporary index, the commit
//   is built from that, and HEAD moves only if it is still the commit the save started from. Then the checkout's own
//   index takes the same entries, so the files are no longer changes.
// - With no hook, no fsmonitor, no signing, no global or system git config and none of the backend's environment
//   (credentials included): the checkout's config is the workspace's to write, so nothing in it runs.
// - A commit made after a stop's durable answer clears that answer (`instafy-stopped-clean` in the checkout's git
//   folder), as the origin does whenever it takes the workspace, so the checkout is kept for the next start to publish.
//
// Only the backend's own writes are committed: a path whose content is no longer what the backend wrote (a person,
// a turn or anything else changed it since) is left alone, so work nobody saved is still caught as unsaved work.
// Ignored paths are never added.
//
// Limit: a stop does not ask the backend to save first. A click in the last few seconds before a machine stops (up to
// SAVE_MAX_DELAY_MS while clicks keep coming) can still be kept by that stop as unsaved work.
//
// Zero dependencies, Node 18+, and `perl` for the lock (on every runtime image and on macOS).
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SAVE_DELAY_MS = 2_000;
export const SAVE_MAX_DELAY_MS = 10_000;
const RETRY_MS = 5_000;
const CHILD_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 20_000;
const MAX_NOTED = 500;
const SAVE_ARG = "--instafy-save-locked";
const BUSY_EXIT = 75;
const LOCK_FILE = "origin-apply.lock";
const CLEAN_STOP_MARKER = "instafy-stopped-clean";
const SAVE_MESSAGE = (label) =>
  `Save what ${label} recorded\n\nData files a site's own backend wrote for its visitors' clicks, saved by that backend.\n\nInstafy-Saved-By: site backend\n`;
// Only what git needs to run; tokens and every GIT_* variable stay out.
const ENV_KEEP = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "SYSTEMROOT"];
const GIT_SAFETY = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false", "-c", "core.quotePath=false"];
// Takes the workspace lock without waiting (exit 75 when it is held), keeps it open for the command and its children
// ($^F: not closed on exec), and runs the command.
const LOCKER = [
  "use Fcntl qw(:flock O_RDWR O_CREAT O_NOFOLLOW);",
  "$^F = 1023;",
  "my $p = shift @ARGV;",
  "sysopen(my $fh, $p, O_RDWR | O_CREAT | O_NOFOLLOW, 0600) or exit 76;",
  `flock($fh, LOCK_EX | LOCK_NB) or exit ${BUSY_EXIT};`,
  "my $c = system { $ARGV[0] } @ARGV;",
  "exit($c == -1 ? 127 : ($c & 127) ? 128 + ($c & 127) : $c >> 8);",
].join(" ");

/** The Instafy checkout a folder belongs to: the nearest `.instafy/.git` above it (or in it), else null. */
export function findSpaceCheckout(startDir) {
  let dir;
  try {
    dir = fs.realpathSync(path.resolve(startDir));
  } catch {
    return null;
  }
  for (;;) {
    const gitDir = path.join(dir, ".instafy", ".git");
    try {
      if (fs.statSync(path.join(gitDir, "HEAD")).isFile()) return { root: dir, gitDir };
    } catch {
      // keep looking
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function safeEnv(extra = {}) {
  const env = {};
  for (const key of ENV_KEEP) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...extra };
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const LOCK_RE = /index\.lock|cannot lock ref|but expected|Another git process|Unable to create .*\.lock/i;

export class SaveOwner {
  /**
   * @param {object} options
   * @param {{root: string, gitDir: string}} options.checkout
   * @param {string} options.label who wrote the files, for the commit message (a site folder)
   * @param {(level: string, text: string) => void} [options.log]
   * @param {number} [options.delayMs] quiet time after the last write before committing
   * @param {number} [options.maxDelayMs] longest a write waits while writes keep coming
   */
  constructor({ checkout, label, log = () => {}, delayMs = SAVE_DELAY_MS, maxDelayMs = SAVE_MAX_DELAY_MS }) {
    this.root = checkout.root;
    this.gitDir = checkout.gitDir;
    this.label = String(label || "a site").replace(/[\r\n]+/g, " ").slice(0, 120);
    this.log = log;
    this.delayMs = delayMs;
    this.maxDelayMs = maxDelayMs;
    /** rel path -> the exact bytes this backend wrote last */
    this.noted = new Map();
    /** index entries committed but not yet in the checkout's index (it was busy) */
    this.indexPending = [];
    this.timer = null;
    this.firstPendingAt = null;
    this.running = null;
    this.closed = false;
    this.commits = 0;
  }

  /** Inside the checkout's work tree (and not in its git folder): the posix path relative to the root, else null. */
  relative(file) {
    let real;
    try {
      real = path.join(fs.realpathSync(path.dirname(path.resolve(file))), path.basename(file));
    } catch {
      return null;
    }
    const rel = path.relative(this.root, real);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    const posix = rel.split(path.sep).join("/");
    if (posix === ".instafy" || posix.startsWith(".instafy/")) return null;
    return posix;
  }

  /** Record that this backend wrote `content` to `file`, and commit it soon. */
  note(file, content) {
    if (this.closed) return;
    const rel = this.relative(file);
    if (!rel) return;
    if (!this.noted.has(rel) && this.noted.size >= MAX_NOTED) return;
    this.noted.set(rel, Buffer.isBuffer(content) ? content : Buffer.from(String(content)));
    this.schedule(this.delayMs);
  }

  schedule(ms) {
    if (this.closed) return;
    const now = Date.now();
    this.firstPendingAt ??= now;
    const wait = Math.max(0, Math.min(ms, this.firstPendingAt + this.maxDelayMs - now));
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, wait);
    this.timer.unref?.();
  }

  /** The noted paths whose file still holds exactly what this backend wrote. */
  ownedPaths() {
    const owned = [];
    for (const [rel, bytes] of this.noted) {
      let current;
      try {
        current = fs.readFileSync(path.join(this.root, ...rel.split("/")));
      } catch {
        this.noted.delete(rel);
        continue;
      }
      if (current.equals(bytes)) owned.push({ rel, bytes });
      else this.noted.delete(rel);
    }
    return owned;
  }

  /** Commit what this backend wrote and still owns. Resolves to {committed, paths} or {skipped, reason}. */
  flush({ sync = false } = {}) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (sync) return this.commitOwned(true);
    if (this.running) {
      // One commit at a time; a write during it waits for the next round.
      return this.running.then(() => (this.noted.size ? this.flush() : { skipped: true, reason: "nothing to save" }));
    }
    this.running = Promise.resolve(this.commitOwned(false)).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  commitOwned(sync) {
    const owned = this.ownedPaths();
    this.firstPendingAt = null;
    if (owned.length === 0 && this.indexPending.length === 0) {
      const nothing = { skipped: true, reason: "nothing to save" };
      return sync ? nothing : Promise.resolve(nothing);
    }
    const payload = JSON.stringify({
      root: this.root,
      gitDir: this.gitDir,
      message: SAVE_MESSAGE(this.label),
      entries: owned.map((entry) => ({ rel: entry.rel, sha256: sha256(entry.bytes) })),
      pending: this.indexPending,
    });
    const finish = (outcome) => {
      const result = parseOutcome(outcome);
      if (Array.isArray(result.indexPending)) this.indexPending = result.indexPending;
      if (result.retry) {
        if (!this.closed) {
          for (const entry of owned) if (!this.noted.has(entry.rel)) this.noted.set(entry.rel, entry.bytes);
          this.schedule(RETRY_MS);
        }
        this.log("info", `save: the space is busy, trying again (${result.reason})`);
        return { skipped: true, reason: result.reason };
      }
      for (const entry of owned) {
        const now = this.noted.get(entry.rel);
        if (now && now.equals(entry.bytes)) this.noted.delete(entry.rel);
      }
      if (this.indexPending.length && !this.closed) this.schedule(RETRY_MS);
      if (result.committed) this.commits += 1;
      if (result.error) this.log("warn", `save: ${result.error}`);
      delete result.indexPending;
      return result;
    };
    const lock = path.join(this.root, ".instafy", LOCK_FILE);
    const args = ["-e", LOCKER, lock, process.execPath, fileURLToPath(import.meta.url), SAVE_ARG];
    const options = { cwd: this.root, env: safeEnv(), timeout: CHILD_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" };
    if (sync) {
      const ran = spawnSync("perl", args, { ...options, input: payload });
      return finish({ code: ran.error ? null : ran.status, stdout: ran.stdout, stderr: ran.stderr, error: ran.error });
    }
    return new Promise((resolve) => {
      const child = execFile("perl", args, options, (error, stdout, stderr) => {
        resolve(finish({ code: error ? (typeof error.code === "number" ? error.code : null) : 0, stdout, stderr, error: error && typeof error.code !== "number" ? error : null }));
      });
      child.stdin.on("error", () => {});
      child.stdin.end(payload);
    });
  }

  /** Commit what is left, synchronously (a stopping process), and stop. A busy space is waited for briefly. */
  close() {
    if (this.closed) return { skipped: true, reason: "closed" };
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    let result = { skipped: true, reason: "nothing to save" };
    const until = Date.now() + 3_000;
    while (this.noted.size || this.indexPending.length) {
      result = this.flush({ sync: true });
      if (!(result.skipped && /busy/.test(result.reason || "")) || Date.now() > until) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return result;
  }
}

function parseOutcome({ code, stdout, stderr, error }) {
  if (code === BUSY_EXIT) return { retry: true, reason: "workspace busy" };
  if (error) return { error: error.code === "ENOENT" ? "perl is missing, so the workspace lock cannot be taken" : String(error.message || error) };
  try {
    const parsed = JSON.parse(String(stdout || "").trim().split("\n").pop() || "null");
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // fall through
  }
  return { error: `the save stopped (exit ${code}): ${String(stderr || "").trim().split("\n")[0]}` };
}

// ---------------------------------------------------------------------------------------------------------------------
// The commit itself: runs in a child process that holds the workspace lock (see LOCKER), synchronously.
// ---------------------------------------------------------------------------------------------------------------------

function lockedSave(input) {
  const { root, gitDir, message, entries = [], pending = [] } = input;
  const attrs = {};
  const git = (args, { stdin, index } = {}) => {
    const ran = spawnSync("git", ["--git-dir", gitDir, "--work-tree", root, ...GIT_SAFETY, ...args], {
      cwd: root,
      env: safeEnv({ ...attrs, ...(index ? { GIT_INDEX_FILE: index } : {}) }),
      input: stdin,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: ran.status ?? 1, stdout: ran.stdout ? ran.stdout.toString("utf8") : "", stderr: ran.stderr ? ran.stderr.toString("utf8") : String(ran.error?.message || "") };
  };
  const failed = (step, result) =>
    LOCK_RE.test(result.stderr) ? { retry: true, reason: `${step}: busy` } : { error: `${step} failed: ${(result.stderr || "").trim().split("\n")[0] || `exit ${result.code}`}` };
  const headOid = () => {
    const head = git(["rev-parse", "-q", "--verify", "HEAD^{commit}"]);
    return head.code === 0 ? head.stdout.trim() : null;
  };
  const treeEntry = (commit, rel) => {
    if (!commit) return null;
    const listed = git(["ls-tree", "-z", commit, "--", rel]).stdout.split("\0")[0];
    const match = /^(\d+) blob ([0-9a-f]+)\t/.exec(listed);
    return match ? { mode: match[1], oid: match[2] } : null;
  };
  // The checkout's index takes the committed entries (no filters, no stat data: git fills that in on its next look).
  const syncIndex = (list) => {
    if (!list.length) return [];
    const head = headOid();
    const still = list.filter((entry) => {
      const now = treeEntry(head, entry.rel);
      return now && now.oid === entry.oid;
    });
    if (!still.length) return [];
    const info = still.map((entry) => `${entry.mode} ${entry.oid}\t${entry.rel}\0`).join("");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const updated = git(["update-index", "-z", "--index-info"], { stdin: info });
      if (updated.code === 0) return [];
      if (!LOCK_RE.test(updated.stderr)) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    return still;
  };

  // Writing the checkout's index makes git look again at files it cannot tell apart by time, through their
  // attributes' filters. Attributes come from an empty tree instead (git 2.40+), so no filter of the workspace's runs.
  const empty = git(["mktree"], { stdin: "" });
  if (empty.code !== 0) return { error: `mktree failed: ${empty.stderr.trim().split("\n")[0]}` };
  attrs.GIT_ATTR_SOURCE = empty.stdout.trim();

  let indexPending = syncIndex(pending);
  const done = (result) => ({ ...result, indexPending });
  if (fs.existsSync(path.join(gitDir, "index.lock"))) return done({ retry: true, reason: "index: busy" });

  // What still holds the backend's bytes, read once: these bytes are what gets committed.
  const files = [];
  for (const entry of entries) {
    let bytes;
    try {
      const file = path.join(root, ...entry.rel.split("/"));
      if (!fs.lstatSync(file).isFile()) continue;
      bytes = fs.readFileSync(file);
    } catch {
      continue;
    }
    if (sha256(bytes) === entry.sha256) files.push({ rel: entry.rel, bytes });
  }
  if (!files.length) return done({ skipped: true, reason: entries.length ? "changed since" : "nothing to save" });

  // Ignored paths stay out (the repository chose not to keep them). Tracked files are never reported as ignored.
  const ignored = git(["check-ignore", "-z", "--stdin"], { stdin: files.map((file) => `${file.rel}\0`).join("") });
  const skip = new Set(ignored.code === 0 ? ignored.stdout.split("\0").filter(Boolean) : []);
  const keep = files.filter((file) => !skip.has(file.rel));
  if (!keep.length) return done({ skipped: true, reason: "ignored by the repository" });

  const head = headOid();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-save-"));
  try {
    const index = path.join(tmp, "index");
    const read = head ? git(["read-tree", head], { index }) : git(["read-tree", "--empty"], { index });
    if (read.code !== 0) return done(failed("read-tree", read));
    const committed = [];
    for (const file of keep) {
      const hashed = git(["hash-object", "-w", "--no-filters", "--stdin"], { stdin: file.bytes });
      if (hashed.code !== 0) return done(failed("hash-object", hashed));
      const before = treeEntry(head, file.rel);
      committed.push({ rel: file.rel, mode: before?.mode === "100755" ? "100755" : "100644", oid: hashed.stdout.trim() });
    }
    const info = committed.map((entry) => `${entry.mode} ${entry.oid}\t${entry.rel}\0`).join("");
    const staged = git(["update-index", "-z", "--index-info"], { stdin: info, index });
    if (staged.code !== 0) return done(failed("update-index", staged));
    const tree = git(["write-tree"], { index });
    if (tree.code !== 0) return done(failed("write-tree", tree));
    const treeOid = tree.stdout.trim();
    if (head && git(["rev-parse", `${head}^{tree}`]).stdout.trim() === treeOid) {
      indexPending = syncIndex([...indexPending, ...committed]);
      return done({ skipped: true, reason: "already saved" });
    }
    const email = git(["config", "--get", "user.email"]);
    const identity =
      email.code === 0 && email.stdout.trim()
        ? {}
        : { GIT_AUTHOR_NAME: "Instafy site", GIT_AUTHOR_EMAIL: "site@instafy.dev", GIT_COMMITTER_NAME: "Instafy site", GIT_COMMITTER_EMAIL: "site@instafy.dev" };
    const commitRun = spawnSync("git", ["--git-dir", gitDir, "--work-tree", root, ...GIT_SAFETY, "commit-tree", treeOid, ...(head ? ["-p", head] : []), "-F", "-"], {
      cwd: root,
      env: safeEnv(identity),
      input: message,
      timeout: GIT_TIMEOUT_MS,
    });
    if (commitRun.status !== 0) return done(failed("commit-tree", { code: commitRun.status, stderr: String(commitRun.stderr || "") }));
    const commit = String(commitRun.stdout).trim();
    // HEAD moves only from the commit this save started from.
    const moved = git(["update-ref", "-m", "instafy: a site backend saved its writes", "HEAD", commit, head || ""]);
    if (moved.code !== 0) return done(failed("update-ref", moved));
    try {
      fs.rmSync(path.join(gitDir, CLEAN_STOP_MARKER), { force: true });
    } catch {
      // the origin's next stop decides again
    }
    indexPending = syncIndex([...indexPending, ...committed]);
    return done({ committed: true, commit, paths: committed.map((entry) => entry.rel) });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function isMain() {
  try {
    return process.argv[2] === SAVE_ARG && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  let result;
  try {
    result = lockedSave(JSON.parse(fs.readFileSync(0, "utf8")));
  } catch (error) {
    result = { error: `save failed: ${error?.message || error}` };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const owners = new Map();

/**
 * Make a backend the save owner of the files it writes under `siteDir`, when the site is in an Instafy space's
 * checkout. Returns the owner, or null outside a space (a plain folder or a person's own repository: their git is
 * theirs, and nothing is committed there).
 */
export function ownSiteWrites(siteDir, { label, log, delayMs, maxDelayMs } = {}) {
  const checkout = findSpaceCheckout(siteDir);
  if (!checkout) return null;
  let real;
  try {
    real = fs.realpathSync(siteDir);
  } catch {
    return null;
  }
  const existing = owners.get(real);
  if (existing && !existing.closed) return existing;
  const owner = new SaveOwner({ checkout, label: label || path.relative(checkout.root, real) || path.basename(real), log, delayMs, maxDelayMs });
  owner.siteDir = real;
  owners.set(real, owner);
  return owner;
}

/** The owner of a file a backend just wrote: the one whose site folder holds it. */
function ownerOf(file) {
  let dir;
  try {
    dir = fs.realpathSync(path.dirname(path.resolve(file)));
  } catch {
    return null;
  }
  let best = null;
  for (const [siteDir, owner] of owners) {
    if (owner.closed) continue;
    if ((dir === siteDir || dir.startsWith(siteDir + path.sep)) && (!best || siteDir.length > best.siteDir.length)) best = owner;
  }
  return best;
}

/**
 * Called by a backend's write path after it wrote `content` (bytes, text, or a function that reads them) to `file`.
 * No owner in this process (no running server, or not in a space): nothing happens.
 */
export function noteSiteWrite(file, content) {
  if (owners.size === 0) return;
  const owner = ownerOf(file);
  if (!owner) return;
  try {
    owner.note(file, typeof content === "function" ? content() : content);
  } catch {
    // a write the owner cannot read back is left to the next save
  }
}

/** Stop owning a site's writes, committing what is left. */
export function releaseSiteWrites(siteDir) {
  let real;
  try {
    real = fs.realpathSync(siteDir);
  } catch {
    real = path.resolve(siteDir);
  }
  const owner = owners.get(real);
  owners.delete(real);
  return owner ? owner.close() : null;
}
