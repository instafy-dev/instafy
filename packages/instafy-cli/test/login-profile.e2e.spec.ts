import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cliBin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "instafy.js");

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function tempDir(prefix: string): string {
  // Real paths, because the CLI reports the folder it walked from as the process sees it.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A server that records each request with the token it carried. It lists conversations, so a
 * command can show which session it used; logins themselves should send it nothing.
 */
async function sessionServer(): Promise<{ url: string; requests: string[] }> {
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url} ${request.headers.authorization ?? "no token"}`);
    if (request.method === "GET" && /^\/projects\/[^/]+\/conversations(?:\?|$)/.test(request.url ?? "")) {
      response.writeHead(200, { "content-type": "application/json" }).end("[]");
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

type Session = { controllerUrl: string; studioUrl: string; accessToken: string; refreshToken: string };

/**
 * A home with a default session and a `work` profile, each on its own servers. Every command reads
 * one of them, depending on --profile, INSTAFY_PROFILE and the folder's binding.
 */
async function homeWithTwoSessions() {
  const home = tempDir("instafy-login-home-");
  const servers = {
    defaultController: await sessionServer(),
    defaultStudio: await sessionServer(),
    workController: await sessionServer(),
    workStudio: await sessionServer(),
  };
  const defaultSession: Session = {
    controllerUrl: servers.defaultController.url,
    studioUrl: servers.defaultStudio.url,
    accessToken: "default-access-token",
    refreshToken: "default-refresh-token",
  };
  const workSession: Session = {
    controllerUrl: servers.workController.url,
    studioUrl: servers.workStudio.url,
    accessToken: "old-work-access-token",
    refreshToken: "old-work-refresh-token",
  };
  const configPath = path.join(home, ".instafy", "config.json");
  const workPath = path.join(home, ".instafy", "profiles", "work.json");
  fs.mkdirSync(path.dirname(workPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ ...defaultSession, updatedAt: "2026-01-01T00:00:00.000Z" }, null, 2));
  fs.writeFileSync(workPath, JSON.stringify({ ...workSession, updatedAt: "2026-01-01T00:00:00.000Z" }, null, 2));
  return {
    home,
    servers,
    configPath,
    workPath,
    profilePath: (name: string) => path.join(home, ".instafy", "profiles", `${name}.json`),
    defaultBefore: fs.readFileSync(configPath, "utf8"),
    workBefore: fs.readFileSync(workPath, "utf8"),
    defaultSession,
    workSession,
    requests: () => Object.values(servers).flatMap((server) => server.requests),
  };
}

/** A folder bound to a space and, by the binding's `profile` field, to a CLI profile. */
function boundFolder(profile: string): { cwd: string; manifestPath: string } {
  const repo = tempDir("instafy-login-repo-");
  const manifestPath = path.join(repo, ".instafy", "space.json");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({ spaceId: randomUUID(), profile }));
  // Run from a subfolder: the nearest binding up the tree applies, as it does for every command.
  const cwd = path.join(repo, "src", "app");
  fs.mkdirSync(cwd, { recursive: true });
  return { cwd, manifestPath };
}

async function runCli(
  args: string[],
  options: { home: string; cwd: string; env?: Record<string, string> },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  // Only what the test sets: an inherited token, server URL or profile would decide the outcome.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: options.home,
    USERPROFILE: options.home,
    XDG_CONFIG_HOME: path.join(options.home, ".config"),
    GIT_CONFIG_GLOBAL: path.join(options.home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    NO_COLOR: "1",
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    ...options.env,
  };
  const child = spawn(process.execPath, [cliBin, ...args], {
    cwd: options.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve) => child.on("close", (exitCode) => resolve(exitCode)));
  return { code, stdout, stderr };
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

/** Runs a command that reads the saved session, and returns what each controller received. */
async function listConversations(
  setup: Awaited<ReturnType<typeof homeWithTwoSessions>>,
  options: { cwd: string; env?: Record<string, string> },
): Promise<{ work: string[]; default: string[] }> {
  const spaceId = randomUUID();
  const before = { work: setup.servers.workController.requests.length, default: setup.servers.defaultController.requests.length };
  const result = await runCli(["conversation", "list", "--space", spaceId, "--json"], { home: setup.home, ...options });
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  return {
    work: setup.servers.workController.requests.slice(before.work).map((line) => line.replace(spaceId, "<space>")),
    default: setup.servers.defaultController.requests.slice(before.default).map((line) => line.replace(spaceId, "<space>")),
  };
}

const LISTED = "GET /projects/<space>/conversations?limit=50&rootsOnly=true";

describe("instafy login and logout save the session every other command reads", () => {
  it("saves the profile INSTAFY_PROFILE selects, on that profile's servers, and leaves the default session alone", async () => {
    const setup = await homeWithTwoSessions();
    const cwd = tempDir("instafy-login-cwd-");
    const env = { INSTAFY_PROFILE: "work" };
    const result = await runCli(["login", "--token", "new-work-access-token", "--no-git-setup"], {
      home: setup.home,
      cwd,
      env,
    });

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(fs.readFileSync(setup.configPath, "utf8")).toBe(setup.defaultBefore);
    const work = readJson(setup.workPath);
    expect(work.accessToken).toBe("new-work-access-token");
    expect(work.controllerUrl).toBe(setup.workSession.controllerUrl);
    expect(work.studioUrl).toBe(setup.workSession.studioUrl);
    // A pasted token cannot refresh, so the old refresh token must not be kept beside it.
    expect(work.refreshToken).toBeNull();
    expect(result.stdout).toContain('Profile "work", selected by INSTAFY_PROFILE.');
    expect(result.stdout).toContain(`Saved token to ${setup.workPath}`);
    expect(setup.requests()).toEqual([]);

    // A command in the same environment now runs on the session login saved.
    expect(await listConversations(setup, { cwd, env })).toEqual({
      work: [`${LISTED} Bearer new-work-access-token`],
      default: [],
    });
  });

  it("saves the profile the nearest .instafy/space.json selects, and names that file", async () => {
    const setup = await homeWithTwoSessions();
    const folder = boundFolder("work");
    const result = await runCli(["login", "--token", "new-work-access-token", "--no-git-setup"], {
      home: setup.home,
      cwd: folder.cwd,
    });

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(fs.readFileSync(setup.configPath, "utf8")).toBe(setup.defaultBefore);
    expect(readJson(setup.workPath)).toMatchObject({
      accessToken: "new-work-access-token",
      controllerUrl: setup.workSession.controllerUrl,
      studioUrl: setup.workSession.studioUrl,
    });
    expect(result.stdout).toContain(`Profile "work", selected by ${folder.manifestPath}.`);
    expect(result.stdout).toContain(`Saved token to ${setup.workPath}`);
    expect(setup.requests()).toEqual([]);

    expect(await listConversations(setup, { cwd: folder.cwd })).toEqual({
      work: [`${LISTED} Bearer new-work-access-token`],
      default: [],
    });
    // Outside the folder, commands still run on the untouched default session.
    expect(await listConversations(setup, { cwd: tempDir("instafy-login-elsewhere-") })).toEqual({
      work: [],
      default: [`${LISTED} Bearer default-access-token`],
    });
  });

  it("lets --profile choose over INSTAFY_PROFILE and the folder", async () => {
    const setup = await homeWithTwoSessions();
    const folder = boundFolder("work");
    const result = await runCli(
      ["login", "--profile", "personal", "--server-url", setup.workSession.controllerUrl, "--studio-url", setup.workSession.studioUrl, "--token", "personal-access-token", "--no-git-setup"],
      { home: setup.home, cwd: folder.cwd, env: { INSTAFY_PROFILE: "work" } },
    );

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(readJson(setup.profilePath("personal")).accessToken).toBe("personal-access-token");
    expect(fs.readFileSync(setup.workPath, "utf8")).toBe(setup.workBefore);
    expect(fs.readFileSync(setup.configPath, "utf8")).toBe(setup.defaultBefore);
    expect(result.stdout).not.toContain("selected by");
    expect(setup.requests()).toEqual([]);
  });

  it("still saves the default session when nothing selects a profile", async () => {
    const setup = await homeWithTwoSessions();
    const result = await runCli(["login", "--token", "new-default-access-token", "--no-git-setup"], {
      home: setup.home,
      cwd: tempDir("instafy-login-cwd-"),
    });

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(readJson(setup.configPath)).toMatchObject({
      accessToken: "new-default-access-token",
      controllerUrl: setup.defaultSession.controllerUrl,
    });
    expect(fs.readFileSync(setup.workPath, "utf8")).toBe(setup.workBefore);
    expect(result.stdout).toContain(`Saved token to ${setup.configPath}`);
    expect(result.stdout).not.toContain("selected by");
    expect(setup.requests()).toEqual([]);
  });

  it("reports the selected profile in --json output, before and after signing in", async () => {
    const setup = await homeWithTwoSessions();
    const cwd = tempDir("instafy-login-cwd-");
    const env = { INSTAFY_PROFILE: "work" };

    const start = await runCli(["login", "--json"], { home: setup.home, cwd, env });
    expect(start.code).toBe(0);
    const started = JSON.parse(start.stdout) as { url: string; profile: string; configPath: string };
    expect(started.profile).toBe("work");
    expect(started.configPath).toBe(setup.workPath);
    expect(new URL(started.url).origin).toBe(setup.workSession.studioUrl);
    expect(new URL(started.url).searchParams.get("serverUrl")).toBe(setup.workSession.controllerUrl);

    const done = await runCli(["login", "--json", "--token", "json-access-token", "--no-git-setup"], {
      home: setup.home,
      cwd,
      env,
    });
    expect(done.code).toBe(0);
    expect(JSON.parse(done.stdout)).toEqual({
      ok: true,
      profile: "work",
      configPath: setup.workPath,
      stored: true,
      method: "token",
    });
    expect(readJson(setup.workPath).accessToken).toBe("json-access-token");
    expect(fs.readFileSync(setup.configPath, "utf8")).toBe(setup.defaultBefore);
    expect(setup.requests()).toEqual([]);
  });

  it("logs out of the profile INSTAFY_PROFILE selects, and keeps the default session", async () => {
    const setup = await homeWithTwoSessions();
    const cwd = tempDir("instafy-logout-cwd-");
    const env = { INSTAFY_PROFILE: "work" };
    const result = await runCli(["logout", "--json"], { home: setup.home, cwd, env });

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, profile: "work", configPath: setup.workPath, cleared: true });
    expect(readJson(setup.workPath)).toMatchObject({
      accessToken: null,
      refreshToken: null,
      controllerUrl: setup.workSession.controllerUrl,
    });
    expect(fs.readFileSync(setup.configPath, "utf8")).toBe(setup.defaultBefore);

    // Commands here no longer have a session to send, and do not borrow the default one.
    expect(await listConversations(setup, { cwd, env })).toEqual({
      work: [`${LISTED} no token`],
      default: [],
    });
  });

  it("logs out of the profile the folder's binding selects, and says which", async () => {
    const setup = await homeWithTwoSessions();
    const folder = boundFolder("work");
    const result = await runCli(["logout"], { home: setup.home, cwd: folder.cwd });

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Logged out (cleared saved access token for profile "work").');
    expect(result.stdout).toContain(`Profile "work", selected by ${folder.manifestPath}.`);
    // The default session, which git's credential helper may use, stays signed in, and it says so.
    expect(result.stdout).toContain(`The default session in ${setup.configPath} is still signed in`);
    expect(readJson(setup.workPath).accessToken).toBeNull();
    expect(fs.readFileSync(setup.configPath, "utf8")).toBe(setup.defaultBefore);
    expect(await listConversations(setup, { cwd: folder.cwd })).toEqual({
      work: [`${LISTED} no token`],
      default: [],
    });
  });

  it("clears nothing, and creates no profile, when the selected profile was never saved", async () => {
    const setup = await homeWithTwoSessions();
    const folder = boundFolder("acme");

    const result = await runCli(["logout"], { home: setup.home, cwd: folder.cwd });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No session is saved for profile "acme"; nothing was cleared.');
    expect(result.stdout).toContain(`Profile "acme", selected by ${folder.manifestPath}.`);
    expect(result.stdout).toContain(`The default session in ${setup.configPath} is still signed in`);

    const json = await runCli(["logout", "--json"], { home: setup.home, cwd: folder.cwd });
    expect(JSON.parse(json.stdout)).toEqual({
      ok: true,
      profile: "acme",
      configPath: setup.profilePath("acme"),
      cleared: false,
    });
    expect(fs.existsSync(setup.profilePath("acme"))).toBe(false);
    expect(fs.readFileSync(setup.configPath, "utf8")).toBe(setup.defaultBefore);
    expect(fs.readFileSync(setup.workPath, "utf8")).toBe(setup.workBefore);
  });

  it("clears nothing, and creates no file, when the default session was never saved", async () => {
    const home = tempDir("instafy-logout-home-");
    const configPath = path.join(home, ".instafy", "config.json");

    const text = await runCli(["logout"], { home, cwd: tempDir("instafy-logout-cwd-") });
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(`No session is saved in ${configPath}; nothing was cleared.`);
    const json = await runCli(["logout", "--json"], { home, cwd: tempDir("instafy-logout-cwd-") });
    expect(JSON.parse(json.stdout)).toEqual({ ok: true, profile: null, configPath, cleared: false });
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)("stops with the error when it cannot check for the profile's file", async () => {
    const setup = await homeWithTwoSessions();
    const profiles = path.dirname(setup.workPath);
    // The folder can be listed but not searched, so whether work.json is there cannot be checked.
    fs.chmodSync(profiles, 0o600);
    try {
      const result = await runCli(["logout", "--profile", "work"], { home: setup.home, cwd: tempDir("instafy-logout-cwd-") });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("EACCES");
      expect(result.stdout).not.toContain("No session is saved");
    } finally {
      fs.chmodSync(profiles, 0o700);
    }
    expect(readJson(setup.workPath).accessToken).toBe("old-work-access-token");
  });

  it("clears a profile file it cannot read, which may still hold a token", async () => {
    const setup = await homeWithTwoSessions();
    // A hand edit left a trailing comma: no command can use this session, but its token is on disk.
    fs.writeFileSync(setup.workPath, `{"controllerUrl":"${setup.workSession.controllerUrl}","accessToken":"unreadable-secret",}`);
    const result = await runCli(["logout", "--json"], {
      home: setup.home,
      cwd: tempDir("instafy-logout-cwd-"),
      env: { INSTAFY_PROFILE: "work" },
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, profile: "work", configPath: setup.workPath, cleared: true });
    expect(fs.readFileSync(setup.workPath, "utf8")).not.toContain("unreadable-secret");
    expect(readJson(setup.workPath).accessToken).toBeNull();
    expect(fs.readFileSync(setup.configPath, "utf8")).toBe(setup.defaultBefore);
  });

  it("escapes what a cloned repository put in the binding's path and profile", async () => {
    const setup = await homeWithTwoSessions();
    const repo = tempDir("instafy-login-repo-");
    // A folder name that would erase the line above and print a success message in its place.
    const trapped = path.join(repo, "app\r\u001b[2K\u001b[1ALogged out.\u001b[8m\u202e");
    fs.mkdirSync(path.join(trapped, ".instafy"), { recursive: true });
    const manifestPath = path.join(trapped, ".instafy", "space.json");
    fs.writeFileSync(manifestPath, JSON.stringify({ spaceId: randomUUID(), profile: "work" }));
    const shown = `${repo}/app\\u000d\\u001b[2K\\u001b[1ALogged out.\\u001b[8m\\u202e/.instafy/space.json`;

    const login = await runCli(["login", "--token", "new-work-access-token", "--no-git-setup"], { home: setup.home, cwd: trapped });
    expect(login.code).toBe(0);
    expect(login.stdout).toContain(`Profile "work", selected by ${shown}.`);
    const logout = await runCli(["logout"], { home: setup.home, cwd: trapped });
    expect(logout.code).toBe(0);
    expect(logout.stdout).toContain(`Profile "work", selected by ${shown}.`);
    for (const output of [login.stdout, logout.stdout]) {
      expect(output).not.toMatch(/[\r\u001b\u202e]/);
    }

    // A profile name the binding sets is shown escaped too when it is refused.
    fs.writeFileSync(manifestPath, JSON.stringify({ spaceId: randomUUID(), profile: "\r\u001b[2KLogged out.\u001b[8m" }));
    const refused = await runCli(["logout"], { home: setup.home, cwd: trapped });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('Invalid profile name "\\u001b[2KLogged out.\\u001b[8m".');
    expect(refused.stderr).not.toMatch(/[\r\u001b]/);
    expect(fs.readFileSync(setup.configPath, "utf8")).toBe(setup.defaultBefore);
  });

  it("refuses an invalid INSTAFY_PROFILE without saving anything", async () => {
    const setup = await homeWithTwoSessions();
    const result = await runCli(["login", "--token", "never-saved", "--no-git-setup"], {
      home: setup.home,
      cwd: tempDir("instafy-login-cwd-"),
      env: { INSTAFY_PROFILE: "../work" },
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Invalid profile name");
    expect(fs.readFileSync(setup.configPath, "utf8")).toBe(setup.defaultBefore);
    expect(fs.readFileSync(setup.workPath, "utf8")).toBe(setup.workBefore);
    expect(fs.readdirSync(path.dirname(setup.workPath))).toEqual(["work.json"]);
  });
});
