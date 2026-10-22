// The binder is the save owner of the data files it writes for clicks (src/save-owner.mjs). In an Instafy space's
// checkout (`.instafy/.git` above the site) it commits them locally, under the origin's workspace lock, so the space's
// next save publishes them. Work it did not write stays a changed file, so a stop still keeps it as unsaved.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { findSpaceCheckout, noteSiteWrite, ownSiteWrites, releaseSiteWrites, SaveOwner } from "../src/save-owner.mjs";
import { writeRecords } from "../src/apply.mjs";
import { cleanup, eventsUrl, intentMessage, openSse, postIntent, simpleParams, sleep, startBinder, claim } from "./helpers.mjs";

const HANDLER = `
const kit = await import(process.env.BIND_KIT);
const { intent } = await kit.readInput();
kit.records([{ type: "claim", cid: kit.rid("clm", intent.params.name), ref: "things:" + intent.params.name, attr: "greeting", value: "hi " + intent.params.name, basis: "editorial", prov: { source: "test", lane: "local", observed_at: new Date().toISOString(), ttl_s: 60 } }]);
kit.done("ok");
`;

const FAST = { delayMs: 30, maxDelayMs: 200 };

function gitIn(space, args, { allowFail = false } = {}) {
  const env = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.com" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[key];
  const result = spawnSync("git", ["--git-dir", path.join(space, ".instafy", ".git"), "--work-tree", space, ...args], { cwd: space, env, encoding: "utf8" });
  if (!allowFail && result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

/** A space folder the way a runtime has it: the checkout's git in `.instafy/.git`, a bound site in hello/, all saved. */
function makeSpace({ site = "hello", extra = {} } = {}) {
  const space = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bind-space-")));
  const files = {
    ".gitignore": ".instafy/\n.bind/\nignored/\n",
    [`${site}/index.html`]: "<h1>hello</h1>",
    [`${site}/handlers/hello.mjs`]: HANDLER,
    [`${site}/bound.json`]: JSON.stringify({ version: 1, title: "Hello", intents: { hello: { label: "Hello", params: simpleParams(), handler: "handlers/hello.mjs", lanes: ["local"] } } }),
    ...extra,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(space, rel)), { recursive: true });
    fs.writeFileSync(path.join(space, rel), content);
  }
  spawnSync("git", ["init", "-q", "--bare", path.join(space, ".instafy", ".git")]);
  gitIn(space, ["config", "core.bare", "false"]);
  gitIn(space, ["config", "user.name", "Instafy Studio"]);
  gitIn(space, ["config", "user.email", "studio@instafy.dev"]);
  gitIn(space, ["add", "-A"]);
  gitIn(space, ["commit", "-q", "-m", "instafy: init"]);
  return { space, siteDir: path.join(space, site) };
}

const status = (space) => gitIn(space, ["status", "--porcelain", "--untracked-files=all"]).split("\n").filter(Boolean);
const subjects = (space) => gitIn(space, ["log", "--format=%s"]).split("\n").filter(Boolean);
const lastFiles = (space) => gitIn(space, ["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean).sort();

async function waitUntil(check, timeoutMs = 5000) {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) return value;
    await sleep(25);
  }
}

test("a click's records are committed in the space's checkout, so nothing the binder wrote is left unsaved", async () => {
  const { space, siteDir } = makeSpace();
  // Someone's own unsaved edit in the same space: never the binder's to save.
  fs.writeFileSync(path.join(space, "notes.md"), "a person's draft\n");
  const binder = await startBinder(siteDir, { noToken: true, saveOptions: FAST });
  const sse = openSse(eventsUrl(binder));
  try {
    await sse.opened;
    const msg = intentMessage("hello", { name: "ada" });
    assert.equal((await postIntent(binder, msg)).status, 202);
    await sse.waitFor((e) => e.event === "done" && e.data.id === msg.id);
    const saved = await waitUntil(() => subjects(space)[0] === "Save what the hello site recorded");
    assert.ok(saved, `the binder's writes were committed (log: ${subjects(space).join(" | ")})`);
    // markVersion and the apply step write version.json more than once: whatever the binder wrote last is saved.
    await waitUntil(() => !status(space).some((line) => line.includes("hello/data/")), 3000);
    assert.deepEqual(status(space), ["?? notes.md"], "only the person's own draft is left as a change");
    const body = gitIn(space, ["log", "-1", "--format=%B"]);
    assert.match(body, /Instafy-Saved-By: site backend/);
    const committed = gitIn(space, ["log", "--name-only", "--format=", "-n", "5"]).split("\n").filter(Boolean);
    assert.ok(committed.includes("hello/data/records/hello.json"));
    assert.ok(committed.includes("hello/data/version.json"));
    assert.ok(!committed.includes("notes.md"));
    const records = JSON.parse(gitIn(space, ["show", "HEAD:hello/data/records/hello.json"]));
    assert.equal(records.records[0].value, "hi ada");
  } finally {
    sse.close();
    await binder.close();
    cleanup(space);
  }
});

test("serve --no-save (save: false) leaves the writes as changed files", async () => {
  const { space, siteDir } = makeSpace();
  const binder = await startBinder(siteDir, { noToken: true, save: false, saveOptions: FAST });
  const sse = openSse(eventsUrl(binder));
  try {
    await sse.opened;
    const msg = intentMessage("hello", { name: "bo" });
    await postIntent(binder, msg);
    await sse.waitFor((e) => e.event === "done" && e.data.id === msg.id);
    await sleep(300);
    assert.deepEqual(subjects(space), ["instafy: init"]);
    assert.ok(status(space).some((line) => line.endsWith("hello/data/version.json")));
  } finally {
    sse.close();
    await binder.close();
    cleanup(space);
  }
});

test("a file someone changed after the binder wrote it is not the binder's to save", async () => {
  const { space, siteDir } = makeSpace();
  const owner = ownSiteWrites(siteDir, { ...FAST, delayMs: 60_000, maxDelayMs: 60_000 });
  try {
    writeRecords(siteDir, "data/records/hello.json", [claim()]);
    // A turn (or a person) edits the records file after the binder wrote it, before the binder saved.
    fs.appendFileSync(path.join(siteDir, "data", "records", "hello.json"), " ");
    const result = await owner.flush();
    assert.equal(result.committed, true);
    assert.deepEqual(lastFiles(space), ["hello/data/version.json"], "only the file still holding the binder's bytes");
    assert.deepEqual(status(space), ["?? hello/data/records/hello.json"]);
  } finally {
    releaseSiteWrites(siteDir);
    cleanup(space);
  }
});

test("ignored paths are never added, and a busy index is tried again", async () => {
  const { space, siteDir } = makeSpace();
  const owner = ownSiteWrites(siteDir, { delayMs: 60_000, maxDelayMs: 60_000 });
  try {
    fs.mkdirSync(path.join(space, "ignored"), { recursive: true });
    fs.writeFileSync(path.join(space, "ignored", "x.json"), "{}\n");
    owner.note(path.join(space, "ignored", "x.json"), "{}\n");
    assert.equal((await owner.flush()).reason, "ignored by the repository");
    assert.deepEqual(subjects(space), ["instafy: init"]);

    writeRecords(siteDir, "data/records/hello.json", [claim()]);
    const lock = path.join(space, ".instafy", ".git", "index.lock");
    fs.writeFileSync(lock, "");
    const busy = await owner.flush();
    assert.equal(busy.skipped, true);
    assert.match(busy.reason, /busy/);
    assert.deepEqual(subjects(space), ["instafy: init"]);
    fs.rmSync(lock);
    const saved = await owner.flush();
    assert.equal(saved.committed, true);
    assert.deepEqual(lastFiles(space), ["hello/data/records/hello.json", "hello/data/version.json"]);
  } finally {
    releaseSiteWrites(siteDir);
    cleanup(space);
  }
});

test("a stopping binder commits what is left at once", async () => {
  const { space, siteDir } = makeSpace();
  ownSiteWrites(siteDir, { delayMs: 60_000, maxDelayMs: 60_000 });
  writeRecords(siteDir, "data/records/hello.json", [claim()]);
  assert.deepEqual(subjects(space), ["instafy: init"]);
  const result = releaseSiteWrites(siteDir);
  try {
    assert.equal(result.committed, true);
    assert.deepEqual(status(space), []);
    // Released: later writes have no owner.
    writeRecords(siteDir, "data/records/hello.json", [claim({ value: "blue" })]);
    await sleep(100);
    assert.equal(subjects(space).length, 2);
  } finally {
    cleanup(space);
  }
});

test("outside a space nothing is committed: a plain folder, or a person's own repository", () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "bind-plain-"));
  const own = fs.mkdtempSync(path.join(os.tmpdir(), "bind-own-"));
  try {
    assert.equal(findSpaceCheckout(plain), null);
    assert.equal(ownSiteWrites(plain), null);
    spawnSync("git", ["init", "-q", own]);
    assert.equal(findSpaceCheckout(own), null, "a .git of the person's own is not a space checkout");
    assert.equal(ownSiteWrites(own), null);
    noteSiteWrite(path.join(own, "data", "version.json"), "{}"); // no owner: nothing happens
  } finally {
    cleanup(plain);
    cleanup(own);
  }
});

test("the owner never touches the checkout's git folder, and writes outside the work tree are ignored", () => {
  const { space } = makeSpace();
  try {
    const owner = new SaveOwner({ checkout: findSpaceCheckout(space), label: "x" });
    assert.equal(owner.relative(path.join(space, ".instafy", ".git", "config")), null);
    assert.equal(owner.relative(path.join(os.tmpdir(), "elsewhere.json")), null);
    assert.equal(owner.relative(path.join(space, "hello", "index.html")), "hello/index.html");
  } finally {
    cleanup(space);
  }
});

test("while the origin holds the workspace lock (a publish, refresh or stop), the save waits and is tried again", async () => {
  const { space, siteDir } = makeSpace();
  const owner = ownSiteWrites(siteDir, { delayMs: 60_000, maxDelayMs: 60_000 });
  // The origin's lock is an exclusive flock on .instafy/origin-apply.lock, held by another process.
  const holder = spawn("perl", ["-MFcntl=:flock", "-e", '$| = 1; open(my $f, ">>", $ARGV[0]) or die; flock($f, LOCK_EX) or die; print "held\\n"; <STDIN>;', path.join(space, ".instafy", "origin-apply.lock")], { stdio: ["pipe", "pipe", "inherit"] });
  try {
    await new Promise((resolve) => holder.stdout.once("data", resolve));
    writeRecords(siteDir, "data/records/hello.json", [claim()]);
    const busy = await owner.flush();
    assert.equal(busy.skipped, true);
    assert.match(busy.reason, /busy/);
    assert.deepEqual(subjects(space), ["instafy: init"], "nothing moved HEAD while the origin held the workspace");
    holder.stdin.end();
    await new Promise((resolve) => holder.once("exit", resolve));
    const saved = await owner.flush();
    assert.equal(saved.committed, true);
    assert.deepEqual(lastFiles(space), ["hello/data/records/hello.json", "hello/data/version.json"]);
    assert.deepEqual(status(space), []);
  } finally {
    holder.kill();
    releaseSiteWrites(siteDir);
    cleanup(space);
  }
});

test("the checkout's own git config runs nothing, and git gets none of the backend's credentials", async () => {
  const { space, siteDir } = makeSpace({ extra: { ".gitattributes": "*.json filter=exfil\n" } });
  const ran = path.join(space, "..", `${path.basename(space)}-filter-ran`);
  const seen = path.join(space, "..", `${path.basename(space)}-git-env`);
  gitIn(space, ["config", "filter.exfil.clean", `sh -c 'ps -o command= -p $PPID >> "${ran}"; cat'`]);
  // A git that writes down the environment it got, then runs the real one.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "bind-fake-git-"));
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\nenv >> "${seen}"\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  const saved = { PATH: process.env.PATH, token: process.env.INSTAFY_TEST_SITE_TOKEN };
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  process.env.INSTAFY_TEST_SITE_TOKEN = "not-for-git";
  const owner = ownSiteWrites(siteDir, { delayMs: 60_000, maxDelayMs: 60_000 });
  try {
    writeRecords(siteDir, "data/records/hello.json", [claim()]);
    const result = await owner.flush();
    assert.equal(result.committed, true, JSON.stringify(result));
    assert.equal(fs.existsSync(ran) ? fs.readFileSync(ran, "utf8") : false, false, "a clean filter from the checkout's config ran");
    const env = fs.readFileSync(seen, "utf8");
    assert.ok(!env.includes("not-for-git"), "the backend's environment reached git");
    assert.match(env, /GIT_CONFIG_GLOBAL=\/dev\/null/);
    assert.match(env, /GIT_CONFIG_NOSYSTEM=1/);
    const records = JSON.parse(gitIn(space, ["show", "HEAD:hello/data/records/hello.json"]));
    assert.equal(records.records.length, 1, "the bytes the binder wrote were committed as they are");
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.token === undefined) delete process.env.INSTAFY_TEST_SITE_TOKEN;
    else process.env.INSTAFY_TEST_SITE_TOKEN = saved.token;
    releaseSiteWrites(siteDir);
    cleanup(bin);
    fs.rmSync(ran, { force: true });
    fs.rmSync(seen, { force: true });
    cleanup(space);
  }
});

test("a save after a stop's durable answer clears it, so the checkout is kept for the next start to publish", async () => {
  const { space, siteDir } = makeSpace();
  const marker = path.join(space, ".instafy", ".git", "instafy-stopped-clean");
  const owner = ownSiteWrites(siteDir, { delayMs: 60_000, maxDelayMs: 60_000 });
  try {
    fs.writeFileSync(marker, "durable\n");
    assert.equal((await owner.flush()).reason, "nothing to save");
    assert.ok(fs.existsSync(marker), "nothing saved: the stop's answer still holds");
    writeRecords(siteDir, "data/records/hello.json", [claim()]);
    assert.equal((await owner.flush()).committed, true);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    releaseSiteWrites(siteDir);
    cleanup(space);
  }
});
