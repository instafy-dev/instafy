import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { refuseDotSegments } from "../src/controller-fetch.js";

const cliBin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "instafy.js");

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function tempDir(prefix: string): string {
  // Real paths, because the CLI names the binding by the path the process sees.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A controller that records every request as it arrived, before any URL handling of its own. */
async function recordingController(spaceId: string): Promise<{ url: string; requests: string[] }> {
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const pathname = (request.url ?? "").split("?")[0];
    if (request.method === "GET" && pathname === `/projects/${spaceId}/conversations`) {
      response.writeHead(200, { "content-type": "application/json" }).end("[]");
      return;
    }
    response.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

/** A home whose saved session points at the recording controller, so every command gets that far. */
function homeSignedInTo(controllerUrl: string): string {
  const home = tempDir("instafy-space-home-");
  fs.mkdirSync(path.join(home, ".instafy"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".instafy", "config.json"),
    JSON.stringify({ controllerUrl, accessToken: "saved-user-token" }),
  );
  return home;
}

/** A folder whose `.instafy/space.json` binds it to `spaceId`, as a cloned repository can. */
function folderBoundTo(spaceId: string): { cwd: string; manifestPath: string } {
  const cwd = tempDir("instafy-space-repo-");
  const manifestPath = path.join(cwd, ".instafy", "space.json");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({ spaceId }));
  return { cwd, manifestPath };
}

async function runCli(
  args: string[],
  options: { home: string; cwd: string; env?: Record<string, string> },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  // Only what the test sets: an inherited SPACE_ID, token or runtime job would decide the outcome.
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

// The commands whose space must be a UUID, with the exit code each gives for a refusal.
// `conversation grep` keeps its usage-error code, 2, apart from its no-match code, 1.
const SPACE_COMMANDS: Array<{ args: string[]; code: number }> = [
  { args: ["conversation", "list"], code: 1 },
  { args: ["conversation", "search", "deploy"], code: 1 },
  { args: ["conversation", "show", randomUUID()], code: 1 },
  { args: ["conversation", "create", "--title", "Plan"], code: 1 },
  { args: ["conversation", "grep", "deploy"], code: 2 },
  { args: ["chat", "hello", "--no-wait"], code: 1 },
  { args: ["history", "conversations"], code: 1 },
  { args: ["automations", "list"], code: 1 },
  { args: ["agents", "settings", "--json"], code: 1 },
  { args: ["agents", "context", "list"], code: 1 },
  { args: ["diagnostics", "runtime-events"], code: 1 },
  { args: ["recommendations", "list"], code: 1 },
];

describe("a space id cannot move a request to another route", () => {
  it("refuses a folder binding that is not a space id, naming the file, before sending anything", async () => {
    const controller = await recordingController(randomUUID());
    const home = homeSignedInTo(controller.url);
    const bound = folderBoundTo(`../agent/plan-groups/${randomUUID()}/status?x=`);

    for (const { args, code } of SPACE_COMMANDS) {
      const result = await runCli(args, { home, cwd: bound.cwd });
      expect(result.code, args.join(" ")).toBe(code);
      if (args[0] === "recommendations") {
        // It already refused anything but a UUID, with its own message.
        expect(result.stderr, args.join(" ")).toContain("Space ID must be a UUID.");
      } else {
        expect(result.stderr, args.join(" ")).toContain(
          `${bound.manifestPath} binds this folder to the space "../agent/plan-groups/`,
        );
        expect(result.stderr, args.join(" ")).toContain('which is not a space id. Correct its "spaceId"');
      }
    }
    expect(controller.requests).toEqual([]);
  });

  it("refuses the binding in runtime start before it looks for a session or a runtime", async () => {
    // No saved session: should the check go missing, the command stops at "Login required"
    // rather than starting anything.
    const home = tempDir("instafy-space-home-");
    const bound = folderBoundTo("../projects/x");

    const result = await runCli(["runtime", "start"], { home, cwd: bound.cwd });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${bound.manifestPath} binds this folder to the space "../projects/x"`);
    expect(fs.existsSync(path.join(home, ".instafy", "cli-runtime-state.json"))).toBe(false);
  });

  it("names the environment variable or the flag that held the bad value", async () => {
    const controller = await recordingController(randomUUID());
    const home = homeSignedInTo(controller.url);
    const cwd = tempDir("instafy-space-cwd-");

    const fromEnvironment = await runCli(["conversation", "list"], {
      home,
      cwd,
      env: { INSTAFY_SPACE_ID: "../me/agents?x=" },
    });
    expect(fromEnvironment.code).toBe(1);
    expect(fromEnvironment.stderr).toContain(
      'INSTAFY_SPACE_ID is "../me/agents?x=", which is not a space id. Set it to the space\'s UUID, or unset it.',
    );

    const fromFlag = await runCli(["history", "conversations", "--space", ".."], { home, cwd });
    expect(fromFlag.code).toBe(1);
    expect(fromFlag.stderr).toContain('--space ".." is not a space id.');

    // A control character from a repository's file is shown escaped, not sent to the terminal.
    const escaped = await runCli(["conversation", "list"], {
      home,
      cwd: folderBoundTo("\u001b[31mred").cwd,
    });
    expect(escaped.code).toBe(1);
    expect(escaped.stderr).toContain('"\\u001b[31mred"');
    expect(escaped.stderr).not.toContain("\u001b[31m");

    // So are the escape sequences and text-reversing marks a repository can put in a folder name.
    const repo = tempDir("instafy-space-repo-");
    const trapped = path.join(repo, "docs\u001b]0;owned\u0007\u202eexe.txt");
    fs.mkdirSync(path.join(trapped, ".instafy"), { recursive: true });
    fs.writeFileSync(path.join(trapped, ".instafy", "space.json"), JSON.stringify({ spaceId: "../me/agents?x=" }));
    const fromFolder = await runCli(["conversation", "list"], { home, cwd: trapped });
    expect(fromFolder.code).toBe(1);
    expect(fromFolder.stderr).toContain(
      `${repo}/docs\\u001b]0;owned\\u0007\\u202eexe.txt/.instafy/space.json binds this folder`,
    );
    expect(fromFolder.stderr).not.toMatch(/[\u001b\u0007\u202e]/);

    expect(controller.requests).toEqual([]);
  });

  it("keeps an id from a flag in one path segment", async () => {
    const controller = await recordingController(randomUUID());
    const home = homeSignedInTo(controller.url);
    const cwd = tempDir("instafy-space-cwd-");
    const target = randomUUID();

    await runCli(["history", "messages", "--conversation", `../projects/${target}/conversations?x=`], { home, cwd });
    await runCli(["chat", "hello", "--no-wait", "--conversation", `../projects/${target}/conversations`], { home, cwd });

    expect(controller.requests).toEqual([
      `GET /conversations/..%2Fprojects%2F${target}%2Fconversations%3Fx%3D/messages?limit=50`,
      `POST /conversations/..%2Fprojects%2F${target}%2Fconversations/messages`,
    ]);
  });

  it("refuses an id that is a dot segment, which encoding leaves as it is", async () => {
    const controller = await recordingController(randomUUID());
    const home = homeSignedInTo(controller.url);
    const cwd = tempDir("instafy-space-cwd-");

    // One command through each request path the guard sits on: the api client, the customer
    // controller client, and the authenticated fetch that `secrets` and most others use.
    for (const [command, folder] of [
      [["history", "messages", "--conversation", ".."], cwd],
      [["history", "runs", "--conversation", "."], cwd],
      [["diagnostics", "run-result", ".."], cwd],
      [["secrets", "list", "--json"], folderBoundTo("..").cwd],
      [["secrets", "list", "--json"], folderBoundTo(".").cwd],
    ] as const) {
      const result = await runCli([...command], { home, cwd: folder });
      expect(result.code, command.join(" ")).toBe(1);
      expect(result.stderr, command.join(" ")).toContain(
        'Refusing a controller request whose path has a "." or ".." segment',
      );
    }
    expect(controller.requests).toEqual([]);
  });

  it("sends no offline beat for a runtime whose saved space is a dot segment", async () => {
    const controller = await recordingController(randomUUID());
    const home = homeSignedInTo(controller.url);
    const statePath = path.join(home, ".instafy", "cli-runtime-state.json");

    for (const projectId of ["..", "."]) {
      // As `runtime start` saved it before space ids were checked: a docker runtime already gone.
      fs.writeFileSync(
        statePath,
        JSON.stringify({ runner: "docker", containerId: null, pid: 0, projectId, originId: randomUUID(), controllerUrl: controller.url, startedAt: "2026-01-01T00:00:00.000Z" }),
      );
      const result = await runCli(["runtime", "stop", "--json"], {
        home,
        cwd: tempDir("instafy-space-cwd-"),
        env: { RUNTIME_ACCESS_TOKEN: "runtime-token-from-env" },
      });
      expect(result.code, projectId).toBe(0);
      expect(JSON.parse(result.stdout), projectId).toEqual({ stopped: false, containerId: null });
    }
    expect(controller.requests).toEqual([]);
  });

  it("refuses every spelling of a dot segment that resolving the URL would act on", () => {
    const base = "http://127.0.0.1:8080";
    const climbs = [
      "/projects/../agents",
      "/projects/./agents",
      "/projects/%2e%2E/agents",
      "/projects/.%2e/agents",
      "/projects/%2E./agents",
      "/projects/%2e/agents",
      "/projects/.\t./agents",
      "/projects/%2e\n%2e/agents",
      "/projects\\..\\agents",
      "/projects/..",
      `${base}/projects/../agents?limit=1`,
      `${base}\\..\\agents`,
      "http:\\\\127.0.0.1:8080\\projects\\..\\agents",
      // The parser drops leading and trailing controls and spaces before anything else.
      "/projects/..\u0000",
      "/projects/.. ",
      "/projects/..\u001f",
      "\u001f../agents",
      // A scheme with no "//" is a path relative to the base.
      "http:../agents",
    ];
    for (const target of climbs) {
      // The guard is right only if the URL really would have moved: up a level, or with the
      // segment that held the id gone.
      const resolved = new URL(target, `${base}/`).pathname;
      expect(["/agents", "/projects/agents", "/"], JSON.stringify(target)).toContain(resolved);
      expect(() => refuseDotSegments(target), JSON.stringify(target)).toThrow(/"\." or "\.\." segment/);
    }
    // Each request builder checks exactly the string it hands the parser: the customer controller
    // client drops the leading slash first, and the api client adds one to a path without it.
    for (const [checked, against, resolved] of [
      [" ../agents", "/projects/x/", "/projects/agents"],
      ["\u0001../agents", "/projects/x/", "/projects/agents"],
      ["/\u0001x://../agents", "/", "/%01x:/agents"],
    ] as const) {
      expect(new URL(checked, `${base}${against}`).pathname, JSON.stringify(checked)).toBe(resolved);
      expect(() => refuseDotSegments(checked), JSON.stringify(checked)).toThrow(/"\." or "\.\." segment/);
    }
    const stays = [
      "/projects/..%2Fagents/conversations",
      "/projects/%252e%252e/conversations",
      "/projects/.../conversations",
      "/projects/.hidden/conversations",
      "/projects/a.b/conversations?path=/../x#/../y",
      "/projects/..%01/conversations",
      "/projects/a%20../conversations",
      `${base}/projects/${randomUUID()}/conversations`,
    ];
    for (const target of stays) {
      expect(() => refuseDotSegments(target), JSON.stringify(target)).not.toThrow();
    }
  });

  it("still reads the space a folder is bound to", async () => {
    const spaceId = randomUUID();
    const controller = await recordingController(spaceId);
    const home = homeSignedInTo(controller.url);
    const bound = folderBoundTo(spaceId);

    const result = await runCli(["conversation", "list", "--json"], { home, cwd: bound.cwd });

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ conversations: [] });
    expect(controller.requests).toEqual([`GET /projects/${spaceId}/conversations?limit=50&rootsOnly=true`]);
  });
});
