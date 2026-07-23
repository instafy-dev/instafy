import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  buildInstafyGitCredentialHelperValue,
  isInstafyGitCredentialHelper,
} from "../src/git-helper.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliBin = path.resolve(__dirname, "..", "bin", "instafy.js");

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runCli(args: string[], options?: { cwd?: string; homeDir?: string }) {
  const homeDir = options?.homeDir ?? makeTempDir("instafy-cli-home-");
  const env = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    INSTAFY_ACCESS_TOKEN: "",
    SUPABASE_ACCESS_TOKEN: "",
    CONTROLLER_ACCESS_TOKEN: "",
    INSTAFY_SERVICE_TOKEN: "",
  };
  return spawnSync(process.execPath, [cliBin, ...args], {
    cwd: options?.cwd,
    env,
    encoding: "utf8",
  });
}

describe("@instafy/cli UX", () => {
  it("builds a self-contained git credential helper command", () => {
    const helper = buildInstafyGitCredentialHelperValue({
      argv: [process.execPath, cliBin],
      execPath: process.execPath,
    });

    expect(helper).toContain("INSTAFY_GIT_HELPER=1");
    expect(helper).toContain("git credential");
    expect(helper).toContain("instafy.js");
    expect(isInstafyGitCredentialHelper(helper)).toBe(true);
    expect(isInstafyGitCredentialHelper("!instafy git credential")).toBe(true);
  });

  it("exposes `instafy login` (prints JSON)", () => {
    const homeDir = makeTempDir("instafy-cli-home-");
    const result = runCli(["login", "--json"], { homeDir });
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout || "{}") as { url?: string; configPath?: string };
    expect(payload.url).toContain("/cli/login");
    expect(payload.configPath).toContain("config.json");
  });

  it("suggests `instafy login` when running space init unauthenticated", () => {
    const homeDir = makeTempDir("instafy-cli-home-");
    const cwd = makeTempDir("instafy-cli-cwd-");
    const result = runCli(["space", "init"], { cwd, homeDir });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Sign in to Instafy");
    expect(result.stderr).toContain("Run: instafy login");
    expect(result.stderr).toContain("Then retry: instafy space init");
  });

  it("suggests `instafy space init` when running tunnel without a space", () => {
    const homeDir = makeTempDir("instafy-cli-home-");
    const cwd = makeTempDir("instafy-cli-cwd-");
    const result = runCli(["tunnel", "start"], { cwd, homeDir });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("instafy space init");
  });

  it("installs git credential helper on login (so git can auth without manual tokens)", () => {
    const gitCheck = spawnSync("git", ["--version"], { encoding: "utf8" });
    if (gitCheck.status !== 0) {
      return;
    }

    const homeDir = makeTempDir("instafy-cli-home-");
    const gitConfigGlobal = path.join(homeDir, "gitconfig");
    const env = {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      GIT_CONFIG_GLOBAL: gitConfigGlobal,
    };

    const loginResult = spawnSync(
      process.execPath,
      [
        cliBin,
        "login",
        "--token",
        "test-token",
        "--studio-url",
        "http://localhost:5173",
        "--server-url",
        "http://127.0.0.1:8788",
      ],
      { env, encoding: "utf8" },
    );
    expect(loginResult.status).toBe(0);

    const gitResult = spawnSync(
      "git",
      ["config", "--global", "--get-all", "credential.helper"],
      { env, encoding: "utf8" },
    );
    expect(gitResult.stdout).toContain("INSTAFY_GIT_HELPER=1");
    expect(gitResult.stdout).toContain("git credential");
  });

  it("upgrades old bare git credential helpers on login", () => {
    const gitCheck = spawnSync("git", ["--version"], { encoding: "utf8" });
    if (gitCheck.status !== 0) {
      return;
    }

    const homeDir = makeTempDir("instafy-cli-home-");
    const gitConfigGlobal = path.join(homeDir, "gitconfig");
    const env = {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      GIT_CONFIG_GLOBAL: gitConfigGlobal,
    };

    const seedResult = spawnSync(
      "git",
      ["config", "--global", "--add", "credential.helper", "!instafy git credential"],
      { env, encoding: "utf8" },
    );
    expect(seedResult.status).toBe(0);

    const loginResult = spawnSync(
      process.execPath,
      [
        cliBin,
        "login",
        "--token",
        "test-token",
        "--studio-url",
        "http://localhost:5173",
        "--server-url",
        "http://127.0.0.1:8788",
      ],
      { env, encoding: "utf8" },
    );
    expect(loginResult.status).toBe(0);

    const gitResult = spawnSync(
      "git",
      ["config", "--global", "--get-all", "credential.helper"],
      { env, encoding: "utf8" },
    );
    expect(gitResult.stdout).toContain("INSTAFY_GIT_HELPER=1");
    expect(gitResult.stdout).toContain("git credential");
    expect(gitResult.stdout).not.toContain("!instafy git credential");
  });
});
