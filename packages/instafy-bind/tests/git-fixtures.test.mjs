// Developers run this suite from `git rebase --exec` and from hooks. git then exports GIT_DIR, an absolute path in a
// linked worktree, and for commit hooks GIT_INDEX_FILE, so a test whose own git inherited them would init, stage and
// commit in the developer's repository instead of its temp folder. A `git init` there even sets core.bare=true in the
// repository's shared config, after which its main checkout refuses to work. So the files whose tests run git are run
// here the way such a developer would run them, under a repository those two variables name, which must be left as it
// was.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureGitEnv } from "./helpers.mjs";

const FILES_THAT_RUN_GIT = ["tests/save-owner.test.mjs", "tests/tokens.test.mjs"];
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

test("tests that run git leave the repository GIT_DIR and GIT_INDEX_FILE name alone", { timeout: 180_000 }, (t) => {
  const named = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bind-named-repository-")));
  t.after(() => fs.rmSync(named, { recursive: true, force: true }));
  const main = path.join(named, "main");
  const linked = path.join(named, "linked");
  const git = (cwd, ...args) =>
    execFileSync("git", ["-c", "user.name=Named", "-c", "user.email=named@example.invalid", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      encoding: "utf8",
      env: fixtureGitEnv(named),
    }).trim();
  fs.mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(main, "README.md"), "not a fixture\n");
  git(main, "add", "README.md");
  git(main, "commit", "-q", "-m", "named");
  git(main, "worktree", "add", "-q", "-b", "linked", linked);
  const gitDir = git(linked, "rev-parse", "--absolute-git-dir");
  const config = () => fs.readFileSync(path.join(main, ".git", "config"), "utf8");
  const state = () => ({
    index: git(linked, "ls-files", "--stage"),
    refs: git(linked, "for-each-ref", "--format=%(refname) %(objectname)"),
    head: git(linked, "rev-parse", "HEAD"),
    status: git(linked, "status", "--porcelain", "--untracked-files=all"),
  });
  const configBefore = config();
  const before = state();

  // What a commit hook in a linked worktree gets; `git rebase --exec` sets GIT_DIR alone. The files run on their own,
  // not as children of this run.
  const env = { ...process.env, GIT_DIR: gitDir, GIT_INDEX_FILE: path.join(gitDir, "index") };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ["--test", ...FILES_THAT_RUN_GIT], { cwd: packageRoot, env, encoding: "utf8", timeout: 150_000 });

  assert.equal(config(), configBefore, "a test changed the config of the repository GIT_DIR names");
  assert.deepEqual(state(), before, "a test changed the index, refs or work tree of the repository GIT_DIR names");
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});
