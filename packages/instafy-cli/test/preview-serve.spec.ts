import { execFileSync } from "node:child_process";
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

  it("starts nothing when the port already answers", async () => {
    const sitePort = await listenOn(http.createServer((_req, res) => res.end("already up")));
    const { result, ws } = await openWithStart({
      sitePort,
      serveCmd: (_ws, port) => `'${process.execPath}' server.mjs ${port} started-anyway.json`,
    });
    expect(result.startedPid).toBeNull();
    expect(result.logFile).toBeNull();
    expect(fs.existsSync(path.join(ws.root, "site", "started-anyway.json"))).toBe(false);
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
