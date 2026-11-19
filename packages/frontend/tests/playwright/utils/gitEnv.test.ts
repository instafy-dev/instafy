import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testGitEnv } from "./gitEnv.js";

const temporary: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temporary.push(dir);
  return dir;
}

// A repository with a linked worktree, built with no inherited or user git settings. Its linked worktree's GIT_DIR
// does not end in /.git, which is what makes a stray `git init` set core.bare=true in the shared config.
function namedRepository() {
  const named = tempDir("playwright-named-repository-");
  const main = path.join(named, "main");
  const linked = path.join(named, "linked");
  const env = { PATH: process.env.PATH, HOME: named, LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Named", "-c", "user.email=named@example.invalid", ...args], { cwd, env, encoding: "utf8" }).trim();
  fs.mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(main, "README.md"), "not a fixture\n");
  git(main, "add", "README.md");
  git(main, "commit", "-q", "-m", "named");
  git(main, "worktree", "add", "-q", "-b", "linked", linked);
  const gitDir = git(linked, "rev-parse", "--absolute-git-dir");
  return {
    gitDir,
    config: () => fs.readFileSync(path.join(main, ".git", "config"), "utf8"),
    state: () => ({
      index: git(linked, "ls-files", "--stage"),
      refs: git(linked, "for-each-ref", "--format=%(refname) %(objectname)"),
      head: git(linked, "rev-parse", "HEAD"),
      status: git(linked, "status", "--porcelain", "--untracked-files=all"),
    }),
  };
}

describe("testGitEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of temporary.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a test's git in its own folder when GIT_DIR and GIT_INDEX_FILE name another repository", () => {
    const named = namedRepository();
    const configBefore = named.config();
    const before = named.state();
    // What a commit hook in a linked worktree gets; `git rebase --exec` sets GIT_DIR alone.
    vi.stubEnv("GIT_DIR", named.gitDir);
    vi.stubEnv("GIT_INDEX_FILE", path.join(named.gitDir, "index"));

    const work = tempDir("playwright-test-git-");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: work, env: testGitEnv(), encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.name", "Instafy Playwright");
    git("config", "user.email", "playwright@instafy.dev");
    fs.writeFileSync(path.join(work, "kept.md"), "kept\n");
    git("add", "-A");
    git("-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "kept");

    expect(named.config()).toBe(configBefore);
    expect(named.state()).toEqual(before);
    expect(git("log", "--format=%s")).toBe("kept");
  });

  it("keeps the rest of the environment and turns off git's prompts", () => {
    vi.stubEnv("GIT_DIR", "/elsewhere/.git");
    vi.stubEnv("GIT_WORK_TREE", "/elsewhere");
    vi.stubEnv("HTTPS_PROXY", "http://proxy.example.invalid:3128");
    const env = testGitEnv();
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.HTTPS_PROXY).toBe("http://proxy.example.invalid:3128");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });
});
