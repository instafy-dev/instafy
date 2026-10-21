import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { parsePreviewPath, parsePreviewTitle, parseStudioOrigin, parseViewerHostSuffix } from "../src/preview.js";
import { commandLineIsRatholeClient } from "../src/tunnel.js";

type RequestCapture = {
  method: string;
  path: string;
  body: string;
  authorization?: string;
  // preview clients the CLI had recorded as running when the request arrived
  liveClients: number[];
};

const RUNTIME_ENV_KEYS = [
  "INSTAFY_ACCESS_TOKEN",
  "SUPABASE_ACCESS_TOKEN",
  "CONTROLLER_ACCESS_TOKEN",
  "RUNTIME_ACCESS_TOKEN",
  "RUNTIME_ID",
  "RUNTIME_LEASE_ID",
  "INSTAFY_CONVERSATION_ID",
  "CONVERSATION_ID",
  "CONTROLLER_BASE_URL",
  "INSTAFY_SERVER_URL",
  "INSTAFY_URL",
  "SPACE_ID",
  "CONTROLLER_SPACE_ID",
  "RATHOLE_BIN",
  "INSTAFY_PREVIEW_DENY_PORTS",
] as const;

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A rathole stand-in that records its pid in `markerDir` and stays up. No `exec`, so its command
// line keeps `-c <config>` the way a real client's does.
function makeStubRathole() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-stub-rathole-"));
  const markerDir = path.join(dir, "pids");
  fs.mkdirSync(markerDir);
  const file = path.join(dir, "rathole");
  const body = `echo $$ > "${markerDir}/$$"\necho stub-rathole-started\nsleep 30\n`;
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}`, { mode: 0o755 });
  const pids = () => fs.readdirSync(markerDir).map(Number).filter((pid) => pid > 0);
  cleanups.push(() => {
    for (const pid of pids()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { file, pids };
}

async function listen(server: http.Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("failed to bind test server");
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return address.port;
}

async function startSite(status = 200, seen: string[] = []): Promise<number> {
  return listen(
    http.createServer((req, res) => {
      seen.push(req.url ?? "");
      res.statusCode = status;
      res.end("<h1 id=pv>ok</h1>");
    }),
  );
}

// An unrelated long-lived process, standing in for whatever reuses a recorded pid after a restart.
function startStranger(): number {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  cleanups.push(() => {
    try {
      process.kill(child.pid!, "SIGKILL");
    } catch {
      // already gone
    }
  });
  return child.pid!;
}

// Unrelated processes whose command lines mention a preview's config path: one names it as a plain argument, one runs
// a program that is not rathole with `-c <path>` (like `less -c`). Neither may ever be signalled or reused.
async function startPathMentioners(configPath: string): Promise<number[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-viewer-"));
  const viewer = path.join(dir, "viewer");
  fs.writeFileSync(viewer, "#!/usr/bin/env bash\nsleep 60\n", { mode: 0o755 });
  const children = [
    spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", configPath], { stdio: "ignore", detached: true }),
    spawn(viewer, ["-c", configPath], { stdio: "ignore", detached: true }),
  ];
  cleanups.push(() => {
    for (const child of children) {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // already gone
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // Let both finish exec, so their command lines are their own when the CLI reads them.
  await new Promise((resolve) => setTimeout(resolve, 500));
  return children.map((child) => child.pid!);
}

function workdirOf(home: string, previewId: string): string {
  return path.join(home, ".instafy", "cli-preview-workdirs", previewId);
}

async function unusedPort(): Promise<number> {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function startMockController(options: {
  projectId: string;
  livePids?: () => number[];
  previewIds?: string[];
  createStatus?: number;
  createBody?: unknown;
  listStatus?: number;
  listBody?: unknown;
  readyStatus?: number;
  readyBody?: unknown;
  viewerHostSuffix?: string;
  studioOrigin?: string;
  // Replaces the credentials in the create response (null leaves them out).
  credentials?: Record<string, unknown> | null;
}) {
  const captures: RequestCapture[] = [];
  let created = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      captures.push({
        method: req.method ?? "",
        path: req.url ?? "",
        body,
        authorization: req.headers.authorization,
        liveClients: options.livePids?.() ?? [],
      });
      const base = `/projects/${options.projectId}/previews`;
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.method === "POST" && req.url === base) {
        if (options.createStatus) {
          json(options.createStatus, options.createBody ?? {});
          return;
        }
        const ids = options.previewIds ?? ["preview-1"];
        const previewId = ids[Math.min(created, ids.length - 1)];
        created += 1;
        const credentials =
          options.credentials === undefined
            ? { server: "127.0.0.1:7000", token: "dev-token", service: `svc_${previewId}` }
            : options.credentials;
        json(201, {
          previewId,
          status: "active",
          ...(credentials ? { credentials } : {}),
          ...(options.viewerHostSuffix !== undefined ? { viewerHostSuffix: options.viewerHostSuffix } : {}),
          ...(options.studioOrigin !== undefined ? { studioOrigin: options.studioOrigin } : {}),
        });
        return;
      }
      if (req.method === "GET" && req.url === base) {
        if (options.listStatus) {
          json(options.listStatus, options.listBody ?? {});
          return;
        }
        json(200, [
          {
            previewId: "preview-1",
            title: "Site preview",
            port: 4173,
            path: "/",
            runtimeId: "runtime-1",
            status: "active",
            messageId: "message-1",
            createdAt: new Date().toISOString(),
          },
        ]);
        return;
      }
      const match = req.url?.match(/\/previews\/([^/]+)\/(ready|close)$/);
      if (req.method === "POST" && match && req.url?.startsWith(base)) {
        if (match[2] === "ready" && options.readyStatus) {
          json(options.readyStatus, options.readyBody ?? {});
        } else if (match[2] === "ready") {
          json(200, { messageId: `message-${match[1]}`, health: { listening: true, status: 200 } });
        } else {
          res.writeHead(204);
          res.end();
        }
        return;
      }
      // Like the controller for a route it does not have: 404 with an empty body.
      res.writeHead(404);
      res.end();
    });
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, captures };
}

async function readAll(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-home-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

async function execCli(args: string[], home: string, env: Record<string, string> = {}) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of RUNTIME_ENV_KEYS) delete childEnv[key];
  Object.assign(childEnv, env);
  const child = spawn("node", ["bin/instafy.js", ...args], {
    env: childEnv,
    cwd: new URL("../", import.meta.url).pathname,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = readAll(child.stdout);
  const stderr = readAll(child.stderr);
  const [code] = (await once(child, "exit")) as [number | null];
  return { code, stdout: await stdout, stderr: await stderr };
}

function openArgs(params: { projectId: string; controllerUrl?: string; port: number; rathole?: string; path?: string }) {
  return [
    "preview",
    "open",
    "--space",
    params.projectId,
    ...(params.controllerUrl ? ["--server-url", params.controllerUrl, "--access-token", "test-token"] : []),
    "--port",
    String(params.port),
    "--title",
    "Site preview",
    ...(params.rathole ? ["--rathole-bin", params.rathole] : []),
    ...(params.path ? ["--path", params.path] : []),
    "--json",
  ];
}

function writeState(home: string, previews: unknown[]) {
  fs.mkdirSync(path.join(home, ".instafy"), { recursive: true });
  fs.writeFileSync(path.join(home, ".instafy", "cli-preview-state.json"), JSON.stringify({ version: 1, previews }));
}

function readState(home: string): {
  previews: Array<{ previewId: string; pid: number; localPort: number; workdir: string; hostSuffix?: string; studioOrigin?: string }>;
} {
  return JSON.parse(fs.readFileSync(path.join(home, ".instafy", "cli-preview-state.json"), "utf8"));
}

function liveRecordedClients(home: string): () => number[] {
  return () => {
    try {
      return readState(home).previews.map((entry) => entry.pid).filter(isAlive);
    } catch {
      return [];
    }
  };
}

describe("instafy preview", () => {
  it("keeps only a plain host[:port] as the viewer host suffix", () => {
    expect(parseViewerHostSuffix("preview.instafy.dev")).toBe("preview.instafy.dev");
    expect(parseViewerHostSuffix(" Preview.Localhost:8083 ")).toBe("preview.localhost:8083");
    for (const bad of [undefined, 42, "", "evil.example/path", "a..b", "*.preview.dev", "x:abc", "a b"]) {
      expect(parseViewerHostSuffix(bad), String(bad)).toBeUndefined();
    }
  });

  it("keeps only a bare http(s) origin as the Studio origin", () => {
    expect(parseStudioOrigin("https://instafy.dev")).toBe("https://instafy.dev");
    expect(parseStudioOrigin("http://localhost:5174/")).toBe("http://localhost:5174");
    for (const bad of [undefined, 42, "", "instafy.dev", "https://instafy.dev/studio", "https://a@instafy.dev", "javascript:alert(1)", "https://instafy.dev/?x=1"]) {
      expect(parseStudioOrigin(bad), String(bad)).toBeUndefined();
    }
  });

  it("accepts the same paths and titles as the server", () => {
    expect(parsePreviewPath("/app?x=1")).toBe("/app?x=1");
    expect(parsePreviewPath(" /site/ ")).toBe("/site/");
    expect(parsePreviewPath(undefined)).toBe("/");
    for (const bad of ["app", "//evil.example/", "/a b", "/a\\b", "/a#b", "/caf\u00e9", "/a\u0001", `/${"a".repeat(512)}`]) {
      expect(() => parsePreviewPath(bad), bad).toThrow(/Path must start with \//);
    }
    expect(parsePreviewTitle("  Site \t preview \n")).toBe("Site preview");
    expect(parsePreviewTitle("Caf\u00e9 \u{1F600}")).toBe("Caf\u00e9 \u{1F600}");
    for (const bad of ["Site\u0007", "Site\u007f", "Site\u0085"]) {
      expect(() => parsePreviewTitle(bad), JSON.stringify(bad)).toThrow(/control characters/);
    }
  });

  it("treats only `<rathole> -c <config>` as the preview's client", () => {
    const config = "/home/me/.instafy/cli-preview-workdirs/p 1/rathole.toml";
    expect(commandLineIsRatholeClient(`/usr/local/bin/rathole -c ${config}`, config)).toBe(true);
    expect(commandLineIsRatholeClient(`rathole -c ${config}`, config)).toBe(true);
    expect(commandLineIsRatholeClient(`"C:\\Tools\\rathole.exe" -c "${config}"`, config)).toBe(true);
    expect(commandLineIsRatholeClient(`bash /tmp/stub/rathole -c ${config}`, config)).toBe(true);
    // A binary under another name counts only when it is the one recorded as spawned.
    expect(commandLineIsRatholeClient(`/opt/rh -c ${config}`, config)).toBe(false);
    expect(commandLineIsRatholeClient(`/opt/rh -c ${config}`, config, "/opt/rh")).toBe(true);
    expect(commandLineIsRatholeClient(`/opt/xrh -c ${config}`, config, "rh")).toBe(false);
    for (const stranger of [
      `tail -f ${config}`,
      `less -c ${config}`,
      `vim ${config}`,
      `grep token ${config}`,
      `/usr/local/bin/rathole -c ${config}.bak`,
      `/usr/local/bin/rathole -c ${config} --extra`,
      `/usr/local/bin/rathole ${config}`,
      `-c ${config}`,
    ]) {
      expect(commandLineIsRatholeClient(stranger, config), stranger).toBe(false);
    }
    expect(commandLineIsRatholeClient(`rathole -c `, "")).toBe(false);
  });

  it("refuses a path or title the server would refuse before any request", async () => {
    const projectId = randomUUID();
    const controller = await startMockController({ projectId });
    const sitePort = await startSite();
    const home = makeHome();

    const badPath = await execCli(
      openArgs({ projectId, controllerUrl: controller.url, port: sitePort, rathole: "/usr/bin/false", path: "/caf\u00e9" }),
      home,
    );
    expect(badPath.code).toBe(1);
    expect(badPath.stderr).toContain("printable ASCII");

    const args = openArgs({ projectId, controllerUrl: controller.url, port: sitePort, rathole: "/usr/bin/false" });
    args[args.indexOf("--title") + 1] = "Site\u0007";
    const badTitle = await execCli(args, home);
    expect(badTitle.code).toBe(1);
    expect(badTitle.stderr).toContain("control characters");
    expect(controller.captures).toHaveLength(0);
  }, 30000);

  it("opens a path with a query string", async () => {
    const projectId = randomUUID();
    const rathole = makeStubRathole();
    const controller = await startMockController({ projectId });
    const seen: string[] = [];
    const sitePort = await startSite(200, seen);

    const result = await execCli(
      openArgs({ projectId, controllerUrl: controller.url, port: sitePort, rathole: rathole.file, path: "/app?x=1" }),
      makeHome(),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(seen).toEqual(["/app?x=1"]);
    expect(JSON.parse(controller.captures[0]!.body)).toMatchObject({ path: "/app?x=1" });
  }, 30000);

  it("says a site that answers only on [::1] is running and must bind 127.0.0.1", async () => {
    const projectId = randomUUID();
    const controller = await startMockController({ projectId });
    const site = http.createServer((_req, res) => res.end("ok"));
    try {
      site.listen({ port: 0, host: "::1", ipv6Only: true });
      await once(site, "listening");
    } catch {
      // No IPv6 loopback here: nothing to test.
      return;
    }
    cleanups.push(() => new Promise<void>((resolve) => site.close(() => resolve())));
    const sitePort = (site.address() as { port: number }).port;

    const result = await execCli(
      openArgs({ projectId, controllerUrl: controller.url, port: sitePort, rathole: "/usr/bin/false" }),
      makeHome(),
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(`answers only on [::1]:${sitePort}`);
    expect(result.stderr).toContain("do not start it again");
    expect(result.stderr).not.toContain("Start the site first");
    expect(controller.captures).toHaveLength(0);
  }, 30000);

  it("starts one client when two opens for the same port run at once", async () => {
    const projectId = randomUUID();
    const rathole = makeStubRathole();
    const controller = await startMockController({ projectId, previewIds: ["preview-1", "preview-1"] });
    const sitePort = await startSite();
    const home = makeHome();
    const args = openArgs({ projectId, controllerUrl: controller.url, port: sitePort, rathole: rathole.file });

    const [first, second] = await Promise.all([execCli(args, home), execCli(args, home)]);
    expect(first.code, first.stderr).toBe(0);
    expect(second.code, second.stderr).toBe(0);
    const live = rathole.pids().filter(isAlive);
    expect(live).toHaveLength(1);
    expect(readState(home).previews.map((entry) => entry.pid)).toEqual(live);
    expect(fs.existsSync(path.join(home, ".instafy", "cli-preview-state.lock"))).toBe(false);
  }, 30000);

  it("exits 2 without calling the controller when nothing listens on the port", async () => {
    const projectId = randomUUID();
    const controller = await startMockController({ projectId });
    const rathole = makeStubRathole();
    const port = await unusedPort();

    const result = await execCli(openArgs({ projectId, controllerUrl: controller.url, port, rathole: rathole.file }), makeHome());

    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain(`127.0.0.1:${port}`);
    expect(controller.captures).toHaveLength(0);
    expect(rathole.pids()).toHaveLength(0);
  }, 30000);

  it("exits 2 without telling the agent to start the site when a server takes the connection but has not answered", async () => {
    const projectId = randomUUID();
    const controller = await startMockController({ projectId });
    const rathole = makeStubRathole();
    // a dev server still compiling its first request: it accepts and answers nothing within the probe's 5 s
    const hung = http.createServer(() => {});
    hung.listen(0, "127.0.0.1");
    await once(hung, "listening");
    cleanups.push(() => {
      hung.closeAllConnections();
      return new Promise<void>((resolve) => hung.close(() => resolve()));
    });
    const port = (hung.address() as { port: number }).port;

    const result = await execCli(openArgs({ projectId, controllerUrl: controller.url, port, rathole: rathole.file }), makeHome());

    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain(`A server accepted the connection on port ${port}`);
    expect(result.stderr).toContain("still be starting or compiling");
    expect(result.stderr).not.toContain("Start the site first");
    expect(controller.captures).toHaveLength(0);
    expect(rathole.pids()).toHaveLength(0);
  }, 30000);

  it("exits 3 for a denied port, locally and from the server", async () => {
    const projectId = randomUUID();
    const controller = await startMockController({ projectId });
    const rathole = makeStubRathole();
    const home = makeHome();
    const sitePort = await startSite();

    // The same local rules as `preview check`: out of range, Instafy's own, or listed in INSTAFY_PREVIEW_DENY_PORTS.
    for (const port of [80, 70000, 9222]) {
      const refused = await execCli(openArgs({ projectId, controllerUrl: controller.url, port, rathole: rathole.file }), home);
      expect(refused.code, refused.stderr).toBe(3);
    }
    const fromEnv = await execCli(
      openArgs({ projectId, controllerUrl: controller.url, port: sitePort, rathole: rathole.file }),
      home,
      { INSTAFY_PREVIEW_DENY_PORTS: `1234, ${sitePort}` },
    );
    expect(fromEnv.code, fromEnv.stderr).toBe(3);
    expect(controller.captures).toHaveLength(0);

    // The server decides as well.
    const strict = await startMockController({
      projectId,
      createStatus: 400,
      createBody: { message: "Port is not allowed", code: "port_not_allowed" },
    });
    const fromServer = await execCli(openArgs({ projectId, controllerUrl: strict.url, port: sitePort, rathole: rathole.file }), home);
    expect(fromServer.code, fromServer.stderr).toBe(3);
    expect(strict.captures.map((capture) => `${capture.method} ${capture.path}`)).toEqual([
      `POST /projects/${projectId}/previews`,
    ]);
    expect(rathole.pids()).toHaveLength(0);
  }, 30000);

  it("exits 2 and says so when the site answers with a server error", async () => {
    const projectId = randomUUID();
    const controller = await startMockController({ projectId });
    const sitePort = await startSite(502);

    const result = await execCli(openArgs({ projectId, controllerUrl: controller.url, port: sitePort, rathole: "/usr/bin/false" }), makeHome());
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain("answered HTTP 502");
    expect(result.stderr).not.toContain("Nothing is answering");
    expect(controller.captures).toHaveLength(0);
  }, 30000);

  it("exits 5 with no client and no card when the server has previews off or no previews API", async () => {
    const projectId = randomUUID();
    const rathole = makeStubRathole();
    const sitePort = await startSite();
    const home = makeHome();
    const off = await startMockController({
      projectId,
      createStatus: 503,
      createBody: { message: "previews are not configured", code: "previews_unavailable" },
    });
    // An older server: the previews routes do not exist (the mock answers 404 for any other route).
    const older = await startMockController({ projectId: randomUUID() });

    // No --rathole-bin and none on PATH: if rathole were resolved before the server is asked, the
    // CLI would start downloading it.
    const noRathole = {
      PATH: path.dirname(process.execPath),
      RATHOLE_CACHE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "instafy-rathole-cache-")),
      HTTPS_PROXY: "http://127.0.0.1:9",
      https_proxy: "http://127.0.0.1:9",
    };
    cleanups.push(() => fs.rmSync(noRathole.RATHOLE_CACHE_DIR, { recursive: true, force: true }));
    for (const controller of [off, older]) {
      const result = await execCli(openArgs({ projectId, controllerUrl: controller.url, port: sitePort }), home, noRathole);
      expect(result.code, result.stderr).toBe(5);
      expect(result.stderr).not.toMatch(/rathole/i);
      expect(result.stderr).toContain("Previews are not available on this server");
      expect(controller.captures.map((capture) => `${capture.method} ${capture.path}`)).toEqual([
        `POST /projects/${projectId}/previews`,
      ]);
    }
    expect(rathole.pids()).toHaveLength(0);
    expect(fs.existsSync(path.join(home, ".instafy", "cli-preview-state.json"))).toBe(false);

    const listed = await execCli(
      ["preview", "list", "--space", projectId, "--server-url", older.url, "--access-token", "test-token", "--json"],
      home,
    );
    expect(listed.code, listed.stderr).toBe(5);
  }, 30000);

  it("keeps a 404 that carries the server's own error an ordinary failure", async () => {
    const projectId = randomUUID();
    const rathole = makeStubRathole();
    const sitePort = await startSite();
    const home = makeHome();
    for (const createBody of [{ message: "runtime not found for project" }, { message: "Not found", code: "runtime_not_found" }]) {
      const missing = await startMockController({ projectId, createStatus: 404, createBody });
      const result = await execCli(openArgs({ projectId, controllerUrl: missing.url, port: sitePort, rathole: rathole.file }), home);
      expect(result.code, result.stderr).toBe(1);
      expect(result.stderr).not.toContain("Previews are not available");
      expect(result.stderr).toContain(createBody.message);
    }
    expect(rathole.pids()).toHaveLength(0);
  }, 30000);

  it("closes the preview on the server when its credentials are unusable", async () => {
    const projectId = randomUUID();
    const rathole = makeStubRathole();
    const controller = await startMockController({ projectId, credentials: null });
    const sitePort = await startSite();
    const home = makeHome();

    const result = await execCli(openArgs({ projectId, controllerUrl: controller.url, port: sitePort, rathole: rathole.file }), home);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain("The preview was closed");
    expect(controller.captures.map((capture) => `${capture.method} ${capture.path}`)).toEqual([
      `POST /projects/${projectId}/previews`,
      `POST /projects/${projectId}/previews/preview-1/close`,
    ]);
    expect(rathole.pids()).toHaveLength(0);
  }, 30000);

  it("keeps a 503 that is not previews_unavailable an ordinary failure", async () => {
    const projectId = randomUUID();
    const rathole = makeStubRathole();
    const sitePort = await startSite();
    const busy = await startMockController({
      projectId,
      createStatus: 503,
      createBody: { message: "Instafy is temporarily unavailable. Please retry." },
    });

    const result = await execCli(openArgs({ projectId, controllerUrl: busy.url, port: sitePort, rathole: rathole.file }), makeHome());
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain("temporarily unavailable");
    expect(rathole.pids()).toHaveLength(0);
  }, 30000);

  it("stops the client and exits 5 when the server turns previews off before the card", async () => {
    const projectId = randomUUID();
    const rathole = makeStubRathole();
    const home = makeHome();
    const controller = await startMockController({
      projectId,
      livePids: liveRecordedClients(home),
      readyStatus: 503,
      readyBody: { message: "previews are not configured", code: "previews_unavailable" },
    });
    const sitePort = await startSite();

    const result = await execCli(openArgs({ projectId, controllerUrl: controller.url, port: sitePort, rathole: rathole.file }), home);
    expect(result.code, result.stderr).toBe(5);
    // The client was up when the card was asked for, and is gone now.
    const ready = controller.captures.find((capture) => capture.path.endsWith("/ready"));
    expect(ready?.liveClients).toHaveLength(1);
    expect(isAlive(ready!.liveClients[0]!)).toBe(false);
    expect(readState(home).previews).toEqual([]);
    // Its config, which holds the service token, is gone with it.
    expect(fs.existsSync(workdirOf(home, "preview-1"))).toBe(false);
  }, 30000);

  it("opens a preview, calls ready once the client is up, and prints no URL", async () => {
    const projectId = randomUUID();
    const rathole = makeStubRathole();
    const home = makeHome();
    const controller = await startMockController({
      projectId,
      livePids: liveRecordedClients(home),
      viewerHostSuffix: "Preview.Localhost:8083",
      studioOrigin: "http://localhost:5174",
    });
    const sitePort = await startSite();

    const result = await execCli(openArgs({ projectId, controllerUrl: controller.url, port: sitePort, rathole: rathole.file }), home);

    expect(result.code, result.stderr).toBe(0);
    // A tokenless local site (`instafy bind serve --preview`) accepts the capability host only on this exact domain,
    // which it reads from the state file: the preview id alone is not a secret.
    expect(readState(home).previews[0]!.hostSuffix).toBe("preview.localhost:8083");
    // ...and takes frame messages only from the Studio that frames it.
    expect(readState(home).previews[0]!.studioOrigin).toBe("http://localhost:5174");
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(output).toEqual({
      previewId: "preview-1",
      title: "Site preview",
      port: sitePort,
      path: "/",
      status: "live",
      httpStatus: 200,
      messageId: "message-preview-1",
      viewerHostSuffix: "preview.localhost:8083",
    });
    expect(output).not.toHaveProperty("url");
    expect(result.stdout).not.toMatch(/https?:|"url"/i);
    expect(result.stderr).not.toMatch(/https?:\/\//);

    const paths = controller.captures.map((capture) => `${capture.method} ${capture.path}`);
    expect(paths).toEqual([
      `POST /projects/${projectId}/previews`,
      `POST /projects/${projectId}/previews/preview-1/ready`,
    ]);
    const create = JSON.parse(controller.captures[0]!.body) as Record<string, unknown>;
    expect(create).toMatchObject({ port: sitePort, path: "/", title: "Site preview", metadata: { source: "instafy-cli" } });
    expect(create).not.toHaveProperty("_instafyActiveJob");
    expect(controller.captures[0]!.liveClients).toHaveLength(0);
    expect(controller.captures[1]!.liveClients).toEqual([readState(home).previews[0]!.pid]);

    const config = fs.readFileSync(path.join(home, ".instafy", "cli-preview-workdirs", "preview-1", "rathole.toml"), "utf8");
    expect(config).toContain(`local_addr = "127.0.0.1:${sitePort}"`);
    expect(config).toContain("[client.services.svc_preview-1]");
  }, 30000);

  it("closes the preview and exits 1 when the client dies at once", async () => {
    const projectId = randomUUID();
    const controller = await startMockController({ projectId });
    const sitePort = await startSite();
    // An existing binary that exits 1 at once; a fresh stub script can take longer than 250 ms to
    // start while macOS scans it.
    const home = makeHome();
    const result = await execCli(openArgs({ projectId, controllerUrl: controller.url, port: sitePort, rathole: "/usr/bin/false" }), home);

    expect(result.code, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("Preview tunnel exited (code 1). The preview was closed.");
    expect(fs.existsSync(workdirOf(home, "preview-1"))).toBe(false);
    const paths = controller.captures.map((capture) => `${capture.method} ${capture.path}`);
    expect(paths).toEqual([
      `POST /projects/${projectId}/previews`,
      `POST /projects/${projectId}/previews/preview-1/close`,
    ]);
  }, 30000);

  it("reuses the running client for the same preview and replaces a stale one on the port", async () => {
    const projectId = randomUUID();
    const rathole = makeStubRathole();
    const controller = await startMockController({
      projectId,
      previewIds: ["preview-1", "preview-1", "preview-2"],
    });
    const sitePort = await startSite();
    const home = makeHome();
    const args = openArgs({ projectId, controllerUrl: controller.url, port: sitePort, rathole: rathole.file });

    const first = await execCli(args, home);
    expect(first.code, first.stderr).toBe(0);
    const firstPid = readState(home).previews[0]!.pid;
    expect(isAlive(firstPid)).toBe(true);

    const second = await execCli(args, home);
    expect(second.code, second.stderr).toBe(0);
    expect(readState(home).previews.map((entry) => entry.pid)).toEqual([firstPid]);

    const third = await execCli(args, home);
    expect(third.code, third.stderr).toBe(0);
    const state = readState(home).previews;
    expect(state.map((entry) => entry.previewId)).toEqual(["preview-2"]);
    expect(state[0]!.pid).not.toBe(firstPid);
    expect(isAlive(firstPid)).toBe(false);
    expect(isAlive(state[0]!.pid)).toBe(true);
    expect(fs.existsSync(workdirOf(home, "preview-1"))).toBe(false);
    expect(fs.existsSync(workdirOf(home, "preview-2"))).toBe(true);
    // The replaced preview is closed on the server, so its card does not outlive its tunnel.
    expect(controller.captures.map((capture) => `${capture.method} ${capture.path}`)).toContain(
      `POST /projects/${projectId}/previews/preview-1/close`,
    );
  }, 30000);

  it("never signals or reuses a recorded pid that is no longer its rathole client", async () => {
    const projectId = randomUUID();
    const rathole = makeStubRathole();
    const controller = await startMockController({ projectId, previewIds: ["preview-1", "preview-1"] });
    const sitePort = await startSite();
    const home = makeHome();
    const args = openArgs({ projectId, controllerUrl: controller.url, port: sitePort, rathole: rathole.file });

    // An older preview on the same port whose pid now belongs to an unrelated process.
    const stranger = startStranger();
    writeState(home, [
      {
        previewId: "preview-old",
        projectId,
        title: "Old",
        localPort: sitePort,
        path: "/",
        controllerUrl: controller.url,
        pid: stranger,
        logFile: path.join(home, "old.log"),
        workdir: path.join(home, ".instafy", "cli-preview-workdirs", "preview-old"),
        startedAt: new Date().toISOString(),
      },
    ]);
    const first = await execCli(args, home);
    expect(first.code, first.stderr).toBe(0);
    expect(isAlive(stranger)).toBe(true);
    expect(readState(home).previews.map((entry) => entry.previewId)).toEqual(["preview-1"]);
    expect(controller.captures.map((capture) => `${capture.method} ${capture.path}`)).toContain(
      `POST /projects/${projectId}/previews/preview-old/close`,
    );

    // This preview's own client is gone and its pid now belongs to an unrelated process, with
    // the config unchanged: a new client must start, and the stranger must live.
    const recorded = readState(home).previews[0]!;
    process.kill(recorded.pid, "SIGKILL");
    const stranger2 = startStranger();
    writeState(home, [{ ...recorded, pid: stranger2 }]);
    const second = await execCli(args, home);
    expect(second.code, second.stderr).toBe(0);
    expect(second.stderr).not.toContain("Reusing");
    const after = readState(home).previews[0]!;
    expect(after.pid).not.toBe(stranger2);
    expect(isAlive(after.pid)).toBe(true);
    expect(isAlive(stranger2)).toBe(true);

    // close leaves an unrelated process alone too.
    writeState(home, [{ ...after, pid: stranger2 }]);
    const closed = await execCli(
      ["preview", "close", "preview-1", "--server-url", controller.url, "--access-token", "test-token", "--json"],
      home,
    );
    expect(closed.code, closed.stderr).toBe(0);
    expect(isAlive(stranger2)).toBe(true);
    process.kill(after.pid, "SIGKILL");
  }, 30000);

  it("opens a sub-path: probes it and sends it to the server", async () => {
    const projectId = randomUUID();
    const rathole = makeStubRathole();
    const controller = await startMockController({ projectId });
    const seen: string[] = [];
    const sitePort = await startSite(200, seen);

    const result = await execCli(
      openArgs({ projectId, controllerUrl: controller.url, port: sitePort, rathole: rathole.file, path: "/app/" }),
      makeHome(),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(seen).toEqual(["/app/"]);
    expect(JSON.parse(controller.captures[0]!.body)).toMatchObject({ path: "/app/" });
    expect(JSON.parse(result.stdout)).toMatchObject({ path: "/app/" });
  }, 30000);

  it("reports unknown status when the server does not report the site's health", async () => {
    const projectId = randomUUID();
    const rathole = makeStubRathole();
    const controller = await startMockController({ projectId, readyStatus: 200, readyBody: { messageId: "m-1" } });
    const sitePort = await startSite();

    const result = await execCli(openArgs({ projectId, controllerUrl: controller.url, port: sitePort, rathole: rathole.file }), makeHome());
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "unknown", httpStatus: null, messageId: "m-1" });
  }, 30000);

  it("reports the HTTP status the server's check got through the preview", async () => {
    const projectId = randomUUID();
    const rathole = makeStubRathole();
    const controller = await startMockController({
      projectId,
      readyStatus: 200,
      readyBody: { messageId: "m-1", health: { listening: true, status: 403 } },
    });
    const sitePort = await startSite();

    const result = await execCli(openArgs({ projectId, controllerUrl: controller.url, port: sitePort, rathole: rathole.file }), makeHome());
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "live", httpStatus: 403 });
  }, 30000);

  it("never signals a process that only mentions a preview's config path", async () => {
    const projectId = randomUUID();
    const rathole = makeStubRathole();
    const controller = await startMockController({ projectId, previewIds: ["preview-1"] });
    const sitePort = await startSite();
    const home = makeHome();
    const oldEntry = (previewId: string, pid: number) => ({
      previewId,
      projectId,
      title: "Old",
      localPort: sitePort,
      path: "/",
      controllerUrl: controller.url,
      pid,
      logFile: path.join(home, `${previewId}.log`),
      workdir: workdirOf(home, previewId),
      startedAt: new Date().toISOString(),
    });
    const [mentionA] = await startPathMentioners(path.join(workdirOf(home, "preview-a"), "rathole.toml"));
    const [, mentionB] = await startPathMentioners(path.join(workdirOf(home, "preview-b"), "rathole.toml"));
    writeState(home, [oldEntry("preview-a", mentionA!), oldEntry("preview-b", mentionB!)]);

    const opened = await execCli(openArgs({ projectId, controllerUrl: controller.url, port: sitePort, rathole: rathole.file }), home);
    expect(opened.code, opened.stderr).toBe(0);
    expect(isAlive(mentionA!)).toBe(true);
    expect(isAlive(mentionB!)).toBe(true);

    const recorded = readState(home).previews[0]!;
    const mentioners = await startPathMentioners(path.join(recorded.workdir, "rathole.toml"));
    for (const pid of mentioners) {
      writeState(home, [{ ...recorded, pid }]);
      const closed = await execCli(
        ["preview", "close", "preview-1", "--server-url", controller.url, "--access-token", "test-token", "--json"],
        home,
      );
      expect(closed.code, closed.stderr).toBe(0);
      expect(isAlive(pid)).toBe(true);
    }
    process.kill(recorded.pid, "SIGKILL");
  }, 30000);

  it("quotes the title in the retry command it suggests", async () => {
    const projectId = randomUUID();
    const controller = await startMockController({ projectId, createStatus: 401, createBody: { message: "expired" } });
    const sitePort = await startSite();
    const args = openArgs({ projectId, controllerUrl: controller.url, port: sitePort, rathole: "/usr/bin/false" });
    args[args.indexOf("--title") + 1] = `It's "new"`;

    const result = await execCli(args, makeHome());
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`--title 'It'\\''s "new"'`);
  }, 30000);

  it("sends the job token only to CONTROLLER_BASE_URL", async () => {
    const projectId = randomUUID();
    const runtimeId = randomUUID();
    const rathole = makeStubRathole();
    const controller = await startMockController({ projectId });
    const other = await startMockController({ projectId });
    const sitePort = await startSite();
    const home = makeHome();
    const jobEnv = {
      RUNTIME_ID: runtimeId,
      RUNTIME_LEASE_ID: "lease-1",
      INSTAFY_CONVERSATION_ID: randomUUID(),
      CONTROLLER_ACCESS_TOKEN: "active-job-token",
      RUNTIME_ACCESS_TOKEN: "runtime-machine-token",
      CONTROLLER_BASE_URL: controller.url,
    };

    const refused = await execCli(
      ["preview", "open", "--space", projectId, "--server-url", other.url, "--port", String(sitePort), "--title", "T", "--rathole-bin", rathole.file],
      home,
      jobEnv,
    );
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("CONTROLLER_BASE_URL");
    expect(other.captures).toHaveLength(0);
    expect(controller.captures).toHaveLength(0);

    const opened = await execCli(openArgs({ projectId, port: sitePort, rathole: rathole.file }), home, jobEnv);
    expect(opened.code, opened.stderr).toBe(0);
    expect(controller.captures.length).toBeGreaterThan(0);
    for (const capture of controller.captures) {
      expect(capture.authorization).toBe("Bearer active-job-token");
    }
    const create = JSON.parse(controller.captures[0]!.body) as Record<string, unknown>;
    expect(create).toMatchObject({ runtimeId, runtimeLeaseId: "lease-1" });
    expect(create.conversationId).toBeUndefined();
    expect(other.captures).toHaveLength(0);
  }, 30000);

  it("lists previews from the server and closes one", async () => {
    const projectId = randomUUID();
    const rathole = makeStubRathole();
    const controller = await startMockController({ projectId });
    const sitePort = await startSite();
    const home = makeHome();

    const opened = await execCli(openArgs({ projectId, controllerUrl: controller.url, port: sitePort, rathole: rathole.file }), home);
    expect(opened.code, opened.stderr).toBe(0);
    const pid = readState(home).previews[0]!.pid;

    const listed = await execCli(
      ["preview", "list", "--space", projectId, "--server-url", controller.url, "--access-token", "test-token", "--json"],
      home,
    );
    expect(listed.code, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual([
      { previewId: "preview-1", title: "Site preview", port: 4173, path: "/", status: "active" },
    ]);

    const closed = await execCli(
      ["preview", "close", "preview-1", "--server-url", controller.url, "--access-token", "test-token", "--json"],
      home,
    );
    expect(closed.code, closed.stderr).toBe(0);
    expect(JSON.parse(closed.stdout)).toEqual({ ok: true, previewId: "preview-1" });
    expect(isAlive(pid)).toBe(false);
    expect(controller.captures.at(-1)).toMatchObject({
      method: "POST",
      path: `/projects/${projectId}/previews/preview-1/close`,
    });
    expect(readState(home).previews).toHaveLength(0);
  }, 30000);
});
