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
// Only the backend's own writes are committed: a path whose content is no longer what the backend wrote (a person,
// a turn or anything else changed it since) is left alone, so work nobody saved is still caught as unsaved work.
// Ignored paths are never added. Hooks and fsmonitor are off for these git commands. A git that is busy (another
// git process holds the index lock) is tried again on the next write or after a short wait.
//
// Zero dependencies, Node 18+.
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const GIT_ENV_DROP = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_COMMON_DIR"];
const GIT_SAFETY = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false", "-c", "core.quotePath=false"];
export const SAVE_DELAY_MS = 3_000;
export const SAVE_MAX_DELAY_MS = 20_000;
const RETRY_MS = 5_000;
const GIT_TIMEOUT_MS = 20_000;
const MAX_NOTED = 500;

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

function gitEnv() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const key of GIT_ENV_DROP) delete env[key];
  return env;
}

const LOCK_RE = /index\.lock|cannot lock ref|Another git process|Unable to create .*\.lock/i;

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

  gitArgs(args) {
    return ["--git-dir", this.gitDir, "--work-tree", this.root, ...GIT_SAFETY, ...args];
  }

  git(args, { sync = false } = {}) {
    const options = { cwd: this.root, env: gitEnv(), timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: "utf8" };
    if (sync) {
      try {
        return { code: 0, stdout: execFileSync("git", this.gitArgs(args), { ...options, stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
      } catch (error) {
        return { code: typeof error.status === "number" ? error.status : 1, stdout: String(error.stdout || ""), stderr: String(error.stderr || error.message || "") };
      }
    }
    return new Promise((resolve) => {
      execFile("git", this.gitArgs(args), options, (error, stdout, stderr) => {
        resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || (error && !stdout ? error.message : "")) });
      });
    });
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
    const run = (args) => this.git(args, { sync });
    const owned = this.ownedPaths();
    this.firstPendingAt = null;
    if (owned.length === 0) return sync ? { skipped: true, reason: "nothing to save" } : Promise.resolve({ skipped: true, reason: "nothing to save" });
    const paths = owned.map((entry) => entry.rel);
    const finish = (result) => {
      if (result.retry) {
        if (!this.closed) {
          for (const entry of owned) if (!this.noted.has(entry.rel)) this.noted.set(entry.rel, entry.bytes);
          this.schedule(RETRY_MS);
        }
        this.log("warn", `save: git is busy, trying again (${result.reason})`);
        return { skipped: true, reason: result.reason };
      }
      for (const entry of owned) {
        const now = this.noted.get(entry.rel);
        if (now && now.equals(entry.bytes)) this.noted.delete(entry.rel);
      }
      if (result.error) this.log("warn", `save: ${result.error}`);
      return result;
    };
    if (sync) return finish(this.commitSteps(paths, run, true));
    return this.commitSteps(paths, run, false).then(finish);
  }

  /** check-ignore, add, diff, commit; sync or async the same way. */
  commitSteps(paths, run, sync) {
    const failed = (step, result) => (LOCK_RE.test(result.stderr) ? { retry: true, reason: `${step}: index busy` } : { error: `${step} failed: ${(result.stderr || "").trim().split("\n")[0] || `exit ${result.code}`}` });
    const message = [
      "-m", `Save what ${this.label} recorded`,
      "-m", "Data files a site's own backend wrote for its visitors' clicks, saved by that backend.\n\nInstafy-Saved-By: site backend",
    ];
    const chain = function* () {
      // Ignored paths stay out (the repository chose not to keep them). Tracked files are never reported as ignored.
      const ignored = yield ["check-ignore", "--", ...paths];
      const skip = new Set(ignored.code === 0 ? ignored.stdout.split("\n").map((line) => line.trim()).filter(Boolean) : []);
      const keep = paths.filter((rel) => !skip.has(rel));
      if (keep.length === 0) return { skipped: true, reason: "ignored by the repository" };
      const added = yield ["add", "--", ...keep];
      if (added.code !== 0) return failed("add", added);
      const same = yield ["diff", "--cached", "--quiet", "--", ...keep];
      if (same.code === 0) return { skipped: true, reason: "already saved" };
      const email = yield ["config", "--get", "user.email"];
      const identity = email.code === 0 && email.stdout.trim() ? [] : ["-c", "user.name=Instafy site", "-c", "user.email=site@instafy.dev"];
      const committed = yield [...identity, "commit", "--no-verify", "--quiet", ...message, "--only", "--", ...keep];
      if (committed.code !== 0) return failed("commit", committed);
      return { committed: true, paths: keep };
    };
    const steps = chain();
    if (sync) {
      let step = steps.next();
      while (!step.done) step = steps.next(run(step.value));
      if (step.value.committed) this.commits += 1;
      return step.value;
    }
    const advance = (input) => {
      const step = input === undefined ? steps.next() : steps.next(input);
      if (step.done) {
        if (step.value.committed) this.commits += 1;
        return Promise.resolve(step.value);
      }
      return run(step.value).then(advance);
    };
    return advance();
  }

  /** Commit what is left, synchronously (a stopping process), and stop. */
  close() {
    if (this.closed) return { skipped: true, reason: "closed" };
    const result = this.noted.size ? this.flush({ sync: true }) : { skipped: true, reason: "nothing to save" };
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return result;
  }
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
