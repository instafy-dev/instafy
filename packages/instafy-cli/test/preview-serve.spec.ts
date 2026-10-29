import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectListeningProcess,
  parseServeCommand,
  portIsFree,
  preferredSitePort,
  previewClose,
  previewOpen,
  resolvePreviewServe,
  parseExplicitServeCommand,
  secretInServeCommand,
  resolveWorkspaceRoot,
  workspaceRelativeDir,
} from "../src/preview.js";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A space's workspace at <WORKSPACE_DIR>/<space id> with a `site` folder. */
function workspace() {
  const base = tempDir("instafy-ws-");
  const projectId = randomUUID();
  const root = path.join(base, projectId);
  fs.mkdirSync(path.join(root, "site", "www"), { recursive: true });
  return { base, projectId, root, env: { WORKSPACE_DIR: base } as NodeJS.ProcessEnv };
}

/**
 * A fake /proc: `net/tcp` lists a listening socket on `port` (inode 4242) and an established one; pid 300 holds the
 * listening socket, pid 200 an unrelated one.
 */
function fakeProc(port: number, argv: string[], cwd: string) {
  const proc = tempDir("instafy-proc-");
  fs.mkdirSync(path.join(proc, "net"));
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
  fs.writeFileSync(
    path.join(proc, "net", "tcp"),
    [
      header,
      `   0: 0100007F:${hexPort} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1 0000000000000000 100 0 0 10 0`,
      `   1: 0100007F:${hexPort} 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 5151 1 0000000000000000 20 4 30 10 -1`,
    ].join("\n"),
  );
  fs.writeFileSync(path.join(proc, "net", "tcp6"), `${header}\n`);
  const addPid = (pid: number, socket: string, args: string[]) => {
    const dir = path.join(proc, String(pid));
    fs.mkdirSync(path.join(dir, "fd"), { recursive: true });
    fs.symlinkSync("/dev/null", path.join(dir, "fd", "0"));
    fs.symlinkSync(socket, path.join(dir, "fd", "3"));
    fs.writeFileSync(path.join(dir, "cmdline"), `${args.join("\0")}\0`);
    fs.symlinkSync(cwd, path.join(dir, "cwd"));
  };
  addPid(200, "socket:[5151]", ["node", "other.js"]);
  addPid(300, "socket:[4242]", argv);
  addPid(301, "socket:[4242]", ["worker"]);
  return proc;
}

describe("preview start command", () => {
  it("splits one command like a shell would, without running a shell", () => {
    expect(parseServeCommand("python3 -m http.server 8000")).toEqual(["python3", "-m", "http.server", "8000"]);
    expect(parseServeCommand(`node "my site/server.mjs" start --title 'Site preview' a\\ b`)).toEqual([
      "node",
      "my site/server.mjs",
      "start",
      "--title",
      "Site preview",
      "a b",
    ]);
    expect(parseServeCommand(`echo "say \\"hi\\"" '' x*`)).toEqual(["echo", 'say "hi"', "", "x*"]);
    for (const bad of [
      "",
      "   ",
      "npm run dev | tee log",
      "a && b",
      "a; b",
      "serve > out.log",
      "serve $PORT",
      'serve "$PORT"',
      "serve `id`",
      "serve $(id)",
      "a\nb",
      "'open",
      "trailing\\",
    ]) {
      expect(() => parseServeCommand(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("finds the workspace and keeps directories inside it", () => {
    const ws = workspace();
    expect(resolveWorkspaceRoot(ws.env, ws.projectId)).toBe(ws.root);
    expect(resolveWorkspaceRoot({ WORKSPACE_PROJECT_DIR: path.join(ws.root, "site") }, null)).toBe(
      path.join(ws.root, "site"),
    );
    expect(resolveWorkspaceRoot({}, ws.projectId)).toBeNull();
    expect(resolveWorkspaceRoot(ws.env, randomUUID())).toBeNull();
    expect(workspaceRelativeDir(ws.root, ws.root)).toBe(".");
    expect(workspaceRelativeDir(ws.root, path.join(ws.root, "site", "www"))).toBe("site/www");
    expect(workspaceRelativeDir(ws.root, ws.base)).toBeNull();
    fs.symlinkSync(ws.base, path.join(ws.root, "escape"));
    expect(workspaceRelativeDir(ws.root, path.join(ws.root, "escape"))).toBeNull();
  });

  it("reads the listening process's argv and directory from /proc", () => {
    const ws = workspace();
    const site = path.join(ws.root, "site");
    const proc = fakeProc(8000, ["python3", "-m", "http.server", "8000"], site);
    expect(detectListeningProcess(8000, proc)).toEqual({
      pid: 300,
      argv: ["python3", "-m", "http.server", "8000"],
      cwd: site,
    });
    expect(detectListeningProcess(8001, proc)).toBeNull();
    expect(detectListeningProcess(8000, path.join(proc, "missing"))).toBeNull();

    expect(resolvePreviewServe({ port: 8000, projectId: ws.projectId, env: ws.env, procRoot: proc })).toEqual({
      serve: { argv: ["python3", "-m", "http.server", "8000"], cwd: "site" },
    });
  });

  it("says why a site is not restartable instead of recording something that would not survive a sleep", () => {
    const ws = workspace();
    const outside = tempDir("instafy-outside-");
    const fromOutside = fakeProc(8000, ["python3", "-m", "http.server"], outside);
    expect(resolvePreviewServe({ port: 8000, projectId: ws.projectId, env: ws.env, procRoot: fromOutside }).serve).toBeNull();
    const tmpScript = fakeProc(8000, ["node", "/tmp/server.js"], path.join(ws.root, "site"));
    const result = resolvePreviewServe({ port: 8000, projectId: ws.projectId, env: ws.env, procRoot: tmpScript });
    expect(result.serve).toBeNull();
    expect(result.note).toContain("/tmp/server.js");
    expect(resolvePreviewServe({ port: 8001, projectId: ws.projectId, env: ws.env, procRoot: tmpScript }).note).toContain(
      "--serve-cmd",
    );
    expect(resolvePreviewServe({ port: 8000, projectId: ws.projectId, env: {}, procRoot: tmpScript }).serve).toBeNull();
    const mac = resolvePreviewServe({ port: 8000, projectId: ws.projectId, env: ws.env, platform: "darwin" });
    expect(mac.serve).toBeNull();
    expect(mac.note).toContain("--serve-cmd");
  });

  it("never records a start command that carries a secret: members could read it", () => {
    const ws = workspace();
    const site = path.join(ws.root, "site");
    for (const argv of [
      ["node", "server.js", "--api-key", "sk-live-aaaaaaaaaaaaaaaa"],
      ["node", "server.js", "--token=abc123"],
      ["env", "OPENAI_API_KEY=sk-x", "node", "server.js"],
      ["node", "server.js", "--db", "postgres://app:hunter2@db.internal:5432/app"],
      ["node", "server.js", ["gh", "p_abcdefghijklmnopqrstuvwxyz0123"].join("")],
      ["python3", "app.py", "--password", "hunter2"],
    ]) {
      const result = resolvePreviewServe({ port: 8000, projectId: ws.projectId, env: ws.env, procRoot: fakeProc(8000, argv, site) });
      expect(result.serve, argv.join(" ")).toBeNull();
      expect(result.note).toMatch(/looks like a secret .*--serve-cmd/);
      expect(result.note).not.toMatch(/hunter2|sk-live|abc123|gh[p]_/);
    }
    // ordinary commands, and flags that only switch something off, are recorded
    for (const argv of [
      ["node", "server.mjs", "--no-token", "site/"],
      ["python3", "-m", "http.server", "4174", "--directory", "sites/x"],
      ["npx", "vite", "--host", "127.0.0.1", "--port", "5173"],
      ["node", "server.js", "--session-dir", "/data"],
      ["node", "server.js", "--author", "kim"],
    ]) {
      const result = resolvePreviewServe({ port: 8000, projectId: ws.projectId, env: ws.env, procRoot: fakeProc(8000, argv, site) });
      expect(result.serve, argv.join(" ")).toEqual({ argv, cwd: "site" });
    }
    expect(secretInServeCommand(["node", "server.mjs", "x", "--detach"])).toBeNull();
  });

  it("takes --serve-cmd from a directory inside the workspace", () => {
    const ws = workspace();
    expect(
      resolvePreviewServe({
        port: 8000,
        projectId: ws.projectId,
        env: ws.env,
        serveCmd: "node server.mjs --port 8000",
        cwd: path.join(ws.root, "site", "www"),
        platform: "darwin",
      }),
    ).toEqual({ serve: { argv: ["node", "server.mjs", "--port", "8000"], cwd: "site/www" } });
    expect(() =>
      resolvePreviewServe({ port: 8000, projectId: ws.projectId, env: ws.env, serveCmd: "serve", cwd: tempDir("x-") }),
    ).toThrow(/inside the space's workspace/);
    expect(() => resolvePreviewServe({ port: 8000, projectId: ws.projectId, env: {}, serveCmd: "serve" })).toThrow(
      /WORKSPACE_DIR/,
    );
  });

  it("refuses a --serve-cmd that carries a secret, as it refuses one read from the process", () => {
    const ws = workspace();
    for (const serveCmd of [
      "node server.js --api-key sk-live-aaaaaaaaaaaaaaaa",
      "node server.js --token x",
      "env API_KEY=hunter2 node server.js",
      "node server.js --db postgres://app:hunter2@db.internal:5432/app",
    ]) {
      let message = "";
      try {
        resolvePreviewServe({ port: 8000, projectId: ws.projectId, env: ws.env, serveCmd, cwd: ws.root, platform: "darwin" });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, serveCmd).toMatch(/looks like a secret .*env file/);
      expect(message).not.toMatch(/hunter2|sk-live/);
      expect(() => parseExplicitServeCommand(serveCmd)).toThrow(/looks like a secret/);
    }
    expect(parseExplicitServeCommand("node server.js --no-token")).toEqual(["node", "server.js", "--no-token"]);
  });
});

describe("instafy preview open records how to start the site", () => {
  async function listen(server: http.Server): Promise<number> {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return (server.address() as { port: number }).port;
  }

  function stubRathole(): string {
    const dir = tempDir("instafy-stub-rathole-");
    const file = path.join(dir, "rathole");
    const pids = path.join(dir, "pids");
    fs.writeFileSync(file, `#!/bin/sh\necho $$ >> "${pids}"\nexec sleep 30\n`, { mode: 0o755 });
    cleanups.push(() => {
      for (const pid of (fs.existsSync(pids) ? fs.readFileSync(pids, "utf8") : "").split("\n").filter(Boolean)) {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {
          // gone
        }
      }
    });
    return file;
  }

  async function open(params: { serverRecords: boolean }) {
    const ws = workspace();
    const projectId = ws.projectId;
    const bodies: Array<Record<string, unknown>> = [];
    const controller = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.writeHead(req.url?.endsWith("/ready") ? 200 : 201, { "content-type": "application/json" });
        if (req.url === `/projects/${projectId}/previews`) {
          bodies.push(JSON.parse(body) as Record<string, unknown>);
          res.end(
            JSON.stringify({
              previewId: "preview-1",
              status: "active",
              credentials: { server: "127.0.0.1:7000", token: "t", service: "svc_preview-1" },
              ...(params.serverRecords ? { restartable: true } : {}),
            }),
          );
        } else {
          res.end(JSON.stringify({ messageId: "message-1", health: { listening: true, status: 200 } }));
        }
      });
    });
    const controllerPort = await listen(controller);
    const sitePort = await listen(http.createServer((_req, res) => res.end("ok")));
    const home = tempDir("instafy-home-");
    const saved = { HOME: process.env.HOME, WORKSPACE_DIR: process.env.WORKSPACE_DIR };
    process.env.HOME = home;
    process.env.WORKSPACE_DIR = ws.base;
    try {
      const result = await previewOpen({
        project: projectId,
        controllerUrl: `http://127.0.0.1:${controllerPort}`,
        controllerToken: "test-token",
        port: sitePort,
        title: "Site preview",
        ratholeBin: stubRathole(),
        serveCmd: `python3 -m http.server ${sitePort}`,
        cwd: path.join(ws.root, "site"),
      });
      return { result, bodies, sitePort };
    } finally {
      process.env.HOME = saved.HOME;
      if (saved.WORKSPACE_DIR === undefined) delete process.env.WORKSPACE_DIR;
      else process.env.WORKSPACE_DIR = saved.WORKSPACE_DIR;
    }
  }

  it("sends the start command and reports a restartable preview", async () => {
    const { result, bodies, sitePort } = await open({ serverRecords: true });
    expect(bodies[0]!["serve"]).toEqual({ argv: ["python3", "-m", "http.server", String(sitePort)], cwd: "site" });
    expect(result.restartable).toBe(true);
    expect(result.restartNote).toBeUndefined();
  }, 30000);

  it("does not claim restartable when the server did not record it", async () => {
    const { result } = await open({ serverRecords: false });
    expect(result.restartable).toBe(false);
    expect(result.restartNote).toBeTruthy();
  }, 30000);
});

describe("instafy preview open --start", () => {
  async function listenOn(server: http.Server, port = 0): Promise<number> {
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return (server.address() as { port: number }).port;
  }

  async function freePort(): Promise<number> {
    const server = http.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }

  function stubRathole(): string {
    const dir = tempDir("instafy-stub-rathole-");
    const file = path.join(dir, "rathole");
    const pids = path.join(dir, "pids");
    fs.writeFileSync(file, `#!/bin/sh\necho $$ >> "${pids}"\nexec sleep 30\n`, { mode: 0o755 });
    cleanups.push(() => {
      for (const pid of (fs.existsSync(pids) ? fs.readFileSync(pids, "utf8") : "").split("\n").filter(Boolean)) {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {
          // gone
        }
      }
    });
    return file;
  }

  /** Stops a site a test started, by its own process group (it runs in its own session). */
  function stopLater(pid: number | null | undefined) {
    if (!pid) return;
    cleanups.push(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // gone
      }
    });
  }

  // A site script: records its environment's names (never values) and process group, then serves `port`.
  const SITE_SCRIPT = [
    'import fs from "node:fs";',
    'import http from "node:http";',
    "const [port, keysFile] = process.argv.slice(2);",
    "fs.writeFileSync(keysFile, JSON.stringify(Object.keys(process.env)));",
    'console.log("site starting");',
    'http.createServer((_req, res) => res.end("hello")).listen(Number(port), "127.0.0.1");',
  ].join("\n");

  const INJECTED_ENV = {
    CONTROLLER_ACCESS_TOKEN: "injected-job-token-for-test",
    SUPABASE_ACCESS_TOKEN: "injected-login-for-test",
    CONTROLLER_BASE_URL: "http://127.0.0.1:1",
    SITE_PLAIN_SETTING: "kept",
  };

  async function openWithStart(params: {
    serveCmd?: (ws: ReturnType<typeof workspace>, sitePort: number) => string;
    sitePort?: number;
    cwd?: (ws: ReturnType<typeof workspace>) => string;
    startTimeoutMs?: number;
  }) {
    const ws = workspace();
    const projectId = ws.projectId;
    const site = path.join(ws.root, "site");
    fs.writeFileSync(path.join(site, "server.mjs"), SITE_SCRIPT);
    fs.writeFileSync(path.join(site, "exits.mjs"), 'console.log("boom: missing config"); process.exit(3);\n');
    fs.writeFileSync(path.join(site, "hangs.mjs"), "setInterval(() => {}, 1000);\n");
    const requests: string[] = [];
    const controller = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requests.push(`${req.method} ${req.url}`);
        res.writeHead(req.url?.endsWith("/ready") ? 200 : 201, { "content-type": "application/json" });
        if (req.url === `/projects/${projectId}/previews`) {
          res.end(
            JSON.stringify({
              previewId: "preview-1",
              status: "active",
              credentials: { server: "127.0.0.1:7000", token: "t", service: "svc_preview-1" },
              restartable: true,
            }),
          );
        } else {
          res.end(JSON.stringify({ messageId: "message-1", health: { listening: true, status: 200 } }));
        }
      });
    });
    const controllerPort = await listenOn(controller);
    const sitePort = params.sitePort ?? (await freePort());
    const keysFile = path.join(ws.root, "env-keys.json");
    const home = tempDir("instafy-home-");
    const saved: Record<string, string | undefined> = { HOME: process.env.HOME, WORKSPACE_DIR: process.env.WORKSPACE_DIR };
    for (const name of Object.keys(INJECTED_ENV)) saved[name] = process.env[name];
    process.env.HOME = home;
    process.env.WORKSPACE_DIR = ws.base;
    Object.assign(process.env, INJECTED_ENV);
    const serveCmd = params.serveCmd
      ? params.serveCmd(ws, sitePort)
      : `'${process.execPath}' server.mjs ${sitePort} '${keysFile}'`;
    try {
      const result = await previewOpen({
        project: projectId,
        controllerUrl: `http://127.0.0.1:${controllerPort}`,
        controllerToken: "test-token",
        port: sitePort,
        title: "Site preview",
        ratholeBin: stubRathole(),
        serveCmd,
        cwd: params.cwd ? params.cwd(ws) : site,
        start: true,
        startTimeoutMs: params.startTimeoutMs ?? 15_000,
      });
      stopLater(result.startedPid);
      return { result, ws, keysFile, sitePort, requests };
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  async function failure(promise: Promise<unknown>): Promise<{ message: string; exitCode?: number }> {
    try {
      await promise;
    } catch (error) {
      return { message: (error as Error).message, exitCode: (error as { exitCode?: number }).exitCode };
    }
    throw new Error("expected a failure");
  }

  it("starts the site in its own session without Instafy credentials, waits for it and reports its pid and log", async () => {
    const { result, ws, keysFile, sitePort, requests } = await openWithStart({});
    expect(result.status).toBe("live");
    expect(result.restartable).toBe(true);
    expect(typeof result.startedPid).toBe("number");
    expect(result.logFile).toBe(path.join(ws.root, ".instafy", "agent", "logs", `preview-${sitePort}.log`));
    expect(fs.readFileSync(result.logFile!, "utf8")).toContain("site starting");
    // Key names only: the values are never read or printed.
    const keys = JSON.parse(fs.readFileSync(keysFile, "utf8")) as string[];
    expect(keys).not.toContain("CONTROLLER_ACCESS_TOKEN");
    expect(keys).not.toContain("SUPABASE_ACCESS_TOKEN");
    expect(keys).toContain("CONTROLLER_BASE_URL");
    expect(keys).toContain("SITE_PLAIN_SETTING");
    // Its own session: it leads its own process group, so a terminal's process-group kill does not reach it.
    const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(result.startedPid)], { encoding: "utf8" }).trim());
    expect(pgid).toBe(result.startedPid);
    expect(requests.some((line) => line.endsWith("/ready"))).toBe(true);
  }, 30000);

  it("refuses a port where another server answers, and starts nothing there: it is never this site 'already running'", async () => {
    const sitePort = await listenOn(http.createServer((_req, res) => res.end("another site")));
    let root = "";
    const { message, exitCode } = await failure(
      openWithStart({
        sitePort,
        serveCmd: (ws, port) => {
          root = ws.root;
          return `'${process.execPath}' server.mjs ${port} started-anyway.json`;
        },
      }),
    );
    expect(exitCode).toBe(3);
    expect(message).toBe(`Port ${sitePort} is in use by another server. Leave out --port: --start picks a free port for this site.`);
    expect(message).not.toMatch(/already running/);
    expect(fs.existsSync(path.join(root, "site", "started-anyway.json"))).toBe(false);
  }, 30000);

  it("fails with exit 2 and the log's path when the command exits before the port answers", async () => {
    let logFile = "";
    const { message, exitCode } = await failure(
      openWithStart({
        serveCmd: (ws, port) => {
          logFile = path.join(ws.root, ".instafy", "agent", "logs", `preview-${port}.log`);
          return `'${process.execPath}' exits.mjs`;
        },
      }),
    );
    expect(exitCode).toBe(2);
    expect(message).toMatch(/exited \(exit status 3\) and did not answer on 127\.0\.0\.1:\d+; log: /);
    expect(message).toContain(`preview-`);
    expect(fs.readFileSync(logFile, "utf8")).toContain("boom: missing config");
  }, 30000);

  it("stops the command and fails with exit 2 when the port does not answer in time", async () => {
    const { message, exitCode } = await failure(
      openWithStart({ serveCmd: () => `'${process.execPath}' hangs.mjs`, startTimeoutMs: 1200 }),
    );
    expect(exitCode).toBe(2);
    expect(message).toMatch(/was stopped after 1 s and did not answer on 127\.0\.0\.1:\d+; log: .*preview-\d+\.log/);
  }, 30000);

  it("applies the --serve-cmd refusals before starting anything", async () => {
    for (const [serveCmd, expected] of [
      ["node server.mjs && echo hi", /not shell syntax/],
      ["node server.mjs --token hunter2", /looks like a secret/],
    ] as const) {
      const { message } = await failure(openWithStart({ serveCmd: () => serveCmd }));
      expect(message).toMatch(expected);
      expect(message).not.toContain("hunter2");
    }
    const outside = await failure(openWithStart({ cwd: () => tempDir("instafy-outside-") }));
    expect(outside.message).toMatch(/inside the space's workspace/);
    const noCommand = await failure(openWithStart({ serveCmd: () => "" }));
    expect(noCommand.exitCode).toBe(2);
    expect(noCommand.message).toMatch(/--start needs --serve-cmd/);
  }, 30000);
});

describe("instafy preview open --start picks the site's port, and close stops the site", () => {
  async function listenOn(server: http.Server): Promise<number> {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return (server.address() as { port: number }).port;
  }

  function stubRathole(): string {
    const dir = tempDir("instafy-stub-rathole-");
    const file = path.join(dir, "rathole");
    const pids = path.join(dir, "pids");
    fs.writeFileSync(file, `#!/bin/sh\necho $$ >> "${pids}"\nexec sleep 30\n`, { mode: 0o755 });
    cleanups.push(() => {
      for (const pid of (fs.existsSync(pids) ? fs.readFileSync(pids, "utf8") : "").split("\n").filter(Boolean)) {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {
          // gone
        }
      }
    });
    return file;
  }

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** Stops a site a test started, by its own process group (it runs in its own session). */
  function stopLater(pid: number | null | undefined) {
    if (!pid) return;
    cleanups.push(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // gone
      }
    });
  }

  async function answers(port: number): Promise<boolean> {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      return false;
    }
  }

  async function until(what: string, check: () => boolean | Promise<boolean>, ms = 8000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  // A site: serves its port and names itself, so a test can tell which site answers on a port.
  const SITE = [
    'import http from "node:http";',
    "const [port, name] = process.argv.slice(2);",
    'http.createServer((_req, res) => res.end(name)).listen(Number(port), "127.0.0.1");',
  ].join("\n");

  /** A space with a `site` folder holding SITE, a controller that keeps a preview per port, and a HOME for the CLI. */
  async function space() {
    const ws = workspace();
    fs.writeFileSync(path.join(ws.root, "site", "site.mjs"), SITE);
    const bodies: Array<Record<string, unknown>> = [];
    const requests: string[] = [];
    let refuse: { status: number; body: unknown } | null = null;
    const controller = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requests.push(`${req.method} ${req.url}`);
        const json = (status: number, payload: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        const base = `/projects/${ws.projectId}/previews`;
        if (req.method === "POST" && req.url === base) {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          bodies.push(parsed);
          if (refuse) return json(refuse.status, refuse.body);
          // As the server does: one preview per machine and port.
          const previewId = `preview-${parsed["port"]}`;
          return json(201, {
            previewId,
            status: "active",
            credentials: { server: "127.0.0.1:7000", token: "t", service: `svc_${previewId}` },
            restartable: true,
          });
        }
        if (req.method === "GET" && req.url === base) return json(200, []);
        if (req.url?.endsWith("/close")) {
          res.writeHead(204);
          return res.end();
        }
        return json(200, { messageId: "message-1", health: { listening: true, status: 200 } });
      });
    });
    const controllerUrl = `http://127.0.0.1:${await listenOn(controller)}`;
    const home = tempDir("instafy-home-");
    const rathole = stubRathole();
    const withEnv = async <T>(run: () => Promise<T>): Promise<T> => {
      const saved = { HOME: process.env.HOME, WORKSPACE_DIR: process.env.WORKSPACE_DIR };
      process.env.HOME = home;
      process.env.WORKSPACE_DIR = ws.base;
      try {
        return await run();
      } finally {
        for (const [name, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    };
    const open = (params: { serveCmd: string; title?: string; port?: number; replace?: boolean }) =>
      withEnv(async () => {
        const result = await previewOpen({
          project: ws.projectId,
          controllerUrl,
          controllerToken: "test-token",
          ...(params.port ? { port: params.port } : {}),
          title: params.title ?? "Site preview",
          ratholeBin: rathole,
          serveCmd: params.serveCmd,
          cwd: path.join(ws.root, "site"),
          start: true,
          startTimeoutMs: 15_000,
          thumbnail: false,
          ...(params.replace ? { replace: true } : {}),
        });
        stopLater(result.startedPid);
        return result;
      });
    const close = (previewId: string) =>
      withEnv(() => previewClose({ previewId, project: ws.projectId, controllerUrl, controllerToken: "test-token" }));
    const state = () =>
      JSON.parse(fs.readFileSync(path.join(home, ".instafy", "cli-preview-state.json"), "utf8")) as {
        previews: Array<Record<string, unknown>>;
      };
    return { ws, home, bodies, requests, open, close, state, refuseWith: (status: number, body: unknown) => (refuse = { status, body }) };
  }

  async function failure(promise: Promise<unknown>): Promise<{ message: string; exitCode?: number }> {
    try {
      await promise;
    } catch (error) {
      return { message: (error as Error).message, exitCode: (error as { exitCode?: number }).exitCode };
    }
    throw new Error("expected a failure");
  }

  const node = `'${process.execPath}'`;

  it("picks a free port for a site, puts it in {port}, and gives the same site the same port next time", async () => {
    const s = await space();
    const serveCmd = `${node} site.mjs {port} lisbon`;
    const first = await s.open({ serveCmd, title: "Lisbon in 3 days" });
    expect(first.port).toBeGreaterThanOrEqual(20_000);
    expect(first.port).toBeLessThan(30_000);
    expect(first.startedPid).toEqual(expect.any(Number));
    expect(await (await fetch(`http://127.0.0.1:${first.port}/`)).text()).toBe("lisbon");
    // The recorded start command has the port in it, so a wake starts the site on the same port.
    expect(s.bodies[0]!["port"]).toBe(first.port);
    expect(s.bodies[0]!["serve"]).toEqual({ argv: [process.execPath, "site.mjs", String(first.port), "lisbon"], cwd: "site" });
    const [entry] = s.state().previews;
    expect(entry).toMatchObject({
      previewId: `preview-${first.port}`,
      localPort: first.port,
      start: { argv: [process.execPath, "site.mjs", "{port}", "lisbon"], cwd: "site" },
      startedPid: first.startedPid,
    });
    expect(String(entry!["startedCommand"])).toContain("site.mjs");

    // The same command from the same folder is the same site: its port and its preview again, nothing started.
    const again = await s.open({ serveCmd, title: "Lisbon in 3 days" });
    expect(again.port).toBe(first.port);
    expect(again.previewId).toBe(first.previewId);
    expect(again.startedPid).toBeNull();
    expect(s.state().previews[0]).toMatchObject({ startedPid: first.startedPid, startedCommand: entry!["startedCommand"] });
  }, 60000);

  it("gives every site its own port, and never shows one site on another's port", async () => {
    const s = await space();
    const map = await s.open({ serveCmd: `${node} site.mjs {port} map`, title: "Lisbon in 3 days" });
    // Another site gets a port of its own.
    const compare = await s.open({ serveCmd: `${node} site.mjs {port} compare`, title: "Roborock comparison" });
    expect(compare.port).not.toBe(map.port);
    expect(await (await fetch(`http://127.0.0.1:${map.port}/`)).text()).toBe("map");
    expect(await (await fetch(`http://127.0.0.1:${compare.port}/`)).text()).toBe("compare");
    expect(compare.previewId).not.toBe(map.previewId);

    // Asked for the map's port, the comparison is refused, with the map named; nothing reaches the server.
    const before = s.bodies.length;
    const refused = await failure(
      s.open({ serveCmd: `${node} site.mjs {port} compare`, title: "Roborock comparison", port: map.port }),
    );
    expect(refused.exitCode).toBe(3);
    expect(refused.message).toBe(
      `Port ${map.port} already shows 'Lisbon in 3 days'. Leave out --port: --start picks a free port for this site.`,
    );
    expect(s.bodies.length).toBe(before);
    expect(await (await fetch(`http://127.0.0.1:${map.port}/`)).text()).toBe("map");
  }, 60000);

  it("moves on from a port another server took, even when it is the site's own first port", async () => {
    const s = await space();
    const serveCmd = `${node} site.mjs {port} hello`;
    // Whatever runs on this site's first port, it is not this site.
    const first = preferredSitePort({ argv: [process.execPath, "site.mjs", "{port}", "hello"], cwd: "site" });
    const squatter = http.createServer((_req, res) => res.end("squatter"));
    squatter.listen(first, "127.0.0.1");
    await once(squatter, "listening");
    cleanups.push(() => new Promise<void>((resolve) => squatter.close(() => resolve())));
    const opened = await s.open({ serveCmd, title: "Hello page" });
    expect(opened.port).not.toBe(first);
    expect(await (await fetch(`http://127.0.0.1:${opened.port}/`)).text()).toBe("hello");
    expect(await (await fetch(`http://127.0.0.1:${first}/`)).text()).toBe("squatter");
  }, 60000);

  it("needs {port} in --serve-cmd when it picks the port, and starts nothing without it", async () => {
    const s = await space();
    const { message } = await failure(s.open({ serveCmd: `${node} site.mjs 4173 fixed` }));
    expect(message).toMatch(/--serve-cmd needs \{port\} where the site's port goes/);
    expect(s.requests).toEqual([]);
  }, 30000);

  it("asks the server to show the site in place of another one only with --replace", async () => {
    const s = await space();
    await s.open({ serveCmd: `${node} site.mjs {port} a`, title: "A" });
    expect(s.bodies[0]).not.toHaveProperty("replace");
    await s.open({ serveCmd: `${node} site.mjs {port} b`, title: "B", replace: true });
    expect(s.bodies[1]!["replace"]).toBe(true);
  }, 60000);

  it("says what the server says when another site's preview holds the port, and stops the site it started for it", async () => {
    const s = await space();
    s.refuseWith(409, { message: "Port 24242 already shows 'Lisbon in 3 days'.", code: "port_in_use" });
    const { message, exitCode } = await failure(s.open({ serveCmd: `${node} site.mjs {port} late`, title: "Roborock comparison" }));
    expect(exitCode).toBe(3);
    expect(message).toMatch(/^Port 24242 already shows 'Lisbon in 3 days'\. .*--replace/);
    const port = Number(s.bodies[0]!["port"]);
    // No card shows it, so it does not keep the port.
    await until("the started site to stop", async () => !(await answers(port)));
    expect(await portIsFree(port)).toBe(true);
  }, 60000);

  async function freePort(): Promise<number> {
    const server = http.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }

  it("close stops the site --start started, its whole process group, and says so", async () => {
    const s = await space();
    // On a port given by hand, too.
    const port = await freePort();
    const opened = await s.open({ serveCmd: `${node} site.mjs ${port} hello`, title: "Hello page", port });
    const pid = opened.startedPid!;
    expect(isAlive(pid)).toBe(true);
    const closed = await s.close(opened.previewId);
    expect(closed).toEqual({ ok: true, previewId: opened.previewId, siteStopped: true });
    await until("the site to stop", () => !isAlive(pid));
    expect(await answers(opened.port)).toBe(false);
    expect(s.requests).toContain(`POST /projects/${s.ws.projectId}/previews/${opened.previewId}/close`);
    expect(s.state().previews).toEqual([]);
  }, 60000);

  it("close never signals a recorded pid that now runs something else", async () => {
    const s = await space();
    const port = await freePort();
    const opened = await s.open({ serveCmd: `${node} site.mjs ${port} hello`, title: "Hello page", port });
    // The site exited and its pid went to an unrelated process.
    process.kill(-opened.startedPid!, "SIGKILL");
    const stranger = spawn("sleep", ["60"], { stdio: "ignore" });
    cleanups.push(() => {
      try {
        process.kill(stranger.pid!, "SIGKILL");
      } catch {
        // gone
      }
    });
    const file = path.join(s.home, ".instafy", "cli-preview-state.json");
    const state = s.state();
    state.previews[0]!["startedPid"] = stranger.pid;
    fs.writeFileSync(file, JSON.stringify(state));
    const closed = await s.close(opened.previewId);
    expect(closed.siteStopped).toBe(false);
    expect(isAlive(stranger.pid!)).toBe(true);
  }, 60000);
});
