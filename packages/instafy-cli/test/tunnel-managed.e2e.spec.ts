import { once } from "node:events";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

function startMockController(projectId: string) {
  let revokeCalled = false;

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      if (req.method === "POST" && req.url === `/projects/${projectId}/tunnels/request`) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            tunnelId: "tunnel-1",
            hostname: "test.rt.instafy.dev",
            url: "https://test.rt.instafy.dev",
            credentials: { server: "127.0.0.1:7000", token: "dev-token" },
          }),
        );
        return;
      }
      if (req.method === "POST" && req.url === `/projects/${projectId}/tunnels/tunnel-1/revoke`) {
        revokeCalled = true;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found", body }));
    });
  });
  server.listen(0);
  return {
    server,
    revokeCalled: () => revokeCalled,
  };
}

function makeStubRathole(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-stub-rathole-"));
  const file = path.join(dir, process.platform === "win32" ? "rathole.cmd" : "rathole");
  const script =
    process.platform === "win32"
      ? "@echo off\r\necho stub-rathole-started\r\nping 127.0.0.1 -n 30 >nul\r\n"
      : "#!/usr/bin/env bash\nset -euo pipefail\necho stub-rathole-started\nsleep 30\n";
  fs.writeFileSync(file, script, { mode: 0o755 });
  return file;
}

async function readAll(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function waitForLogLine(
  homeDir: string,
  needle: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const logs = await execCli(["tunnel", "logs", "tunnel-1", "--lines", "10"], undefined, homeDir);
    if (`${logs.stdout}\n${logs.stderr}`.includes(needle)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for tunnel logs to include: ${needle}`);
}

async function execCli(args: string[], env?: NodeJS.ProcessEnv, homeDir?: string) {
  const entry = "bin/instafy.js";
  const tmpHome = homeDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-home-"));
  const child = spawn("node", [entry, ...args], {
    env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, ...env },
    cwd: new URL("../", import.meta.url).pathname,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutPromise = readAll(child.stdout);
  const stderrPromise = readAll(child.stderr);
  const [code] = (await once(child, "exit")) as [number | null];
  const stdout = await stdoutPromise;
  const stderr = await stderrPromise;
  return { code, stdout, stderr, homeDir: tmpHome };
}

describe("tunnel (detached + manage commands)", () => {
  it("starts detached, lists, shows logs, and stops", async () => {
    const projectId = randomUUID();
    const { server, revokeCalled } = startMockController(projectId);
    await once(server, "listening");
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const controllerUrl = `http://127.0.0.1:${port}`;
    const stubRathole = makeStubRathole();

    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-home-"));
    try {
      const start = await execCli(
        [
          "tunnel",
          "start",
          "--space",
          projectId,
          "--server-url",
          controllerUrl,
          "--access-token",
          "test-token",
          "--rathole-bin",
          stubRathole,
          "--json",
        ],
        undefined,
        homeDir,
      );
      expect(start.code).toBe(0);
      const started = JSON.parse(start.stdout || "{}") as { tunnelId?: string; pid?: number; logFile?: string };
      expect(started.tunnelId).toBe("tunnel-1");
      expect(typeof started.pid).toBe("number");
      expect(typeof started.logFile).toBe("string");
      expect(fs.existsSync(started.logFile!)).toBe(true);

      const listed = await execCli(["tunnel", "list", "--json"], undefined, homeDir);
      expect(listed.code).toBe(0);
      const tunnels = JSON.parse(listed.stdout || "[]") as Array<{ tunnelId: string }>;
      expect(tunnels.some((t) => t.tunnelId === "tunnel-1")).toBe(true);

      await waitForLogLine(homeDir, "stub-rathole-started");

      const stopped = await execCli(
        ["tunnel", "stop", "tunnel-1", "--server-url", controllerUrl, "--access-token", "test-token"],
        undefined,
        homeDir,
      );
      expect(stopped.code).toBe(0);
      expect(revokeCalled()).toBe(true);

      const after = await execCli(["tunnel", "list", "--json"], undefined, homeDir);
      expect(after.code).toBe(0);
      const afterList = JSON.parse(after.stdout || "[]") as unknown[];
      expect(afterList.length).toBe(0);
    } finally {
      server.close();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  }, 30000);
  it("reports a rathole binary that cannot start and revokes the grant", async () => {
    const projectId = randomUUID();
    const { server, revokeCalled } = startMockController(projectId);
    await once(server, "listening");
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-home-"));
    try {
      const start = await execCli(
        [
          "tunnel",
          "start",
          "--space",
          projectId,
          "--server-url",
          `http://127.0.0.1:${port}`,
          "--access-token",
          "test-token",
          "--rathole-bin",
          path.join(homeDir, "missing", "rathole"),
          "--json",
        ],
        undefined,
        homeDir,
      );
      expect(start.code, start.stderr).toBe(1);
      expect(start.stderr).toContain("Tunnel process exited");
      expect(start.stderr).toContain("ENOENT");
      expect(revokeCalled()).toBe(true);
    } finally {
      server.close();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  }, 30000);

  it("stop never signals a recorded pid that is no longer its rathole client", async () => {
    if (process.platform === "win32") return;
    const projectId = randomUUID();
    const { server, revokeCalled } = startMockController(projectId);
    await once(server, "listening");
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const controllerUrl = `http://127.0.0.1:${port}`;
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-home-"));
    const stranger = spawn("sleep", ["60"], { stdio: "ignore" });
    let clientPid = -1;
    try {
      const start = await execCli(
        ["tunnel", "start", "--space", projectId, "--server-url", controllerUrl, "--access-token", "test-token", "--rathole-bin", makeStubRathole(), "--json"],
        undefined,
        homeDir,
      );
      expect(start.code, start.stderr).toBe(0);
      clientPid = (JSON.parse(start.stdout) as { pid: number }).pid;

      // After a restart the recorded pid belongs to something else.
      const stateFile = path.join(homeDir, ".instafy", "cli-tunnel-state.json");
      const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { tunnels: Array<{ pid: number }> };
      state.tunnels[0]!.pid = stranger.pid!;
      fs.writeFileSync(stateFile, JSON.stringify(state));

      const stopped = await execCli(
        ["tunnel", "stop", "tunnel-1", "--server-url", controllerUrl, "--access-token", "test-token"],
        undefined,
        homeDir,
      );
      expect(stopped.code, stopped.stderr).toBe(0);
      expect(revokeCalled()).toBe(true);
      expect(() => process.kill(stranger.pid!, 0)).not.toThrow();
    } finally {
      stranger.kill("SIGKILL");
      if (clientPid > 0) {
        try {
          process.kill(clientPid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      server.close();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  }, 30000);

  it("stop never signals a process that only mentions the tunnel's config path", async () => {
    if (process.platform === "win32") return;
    const projectId = randomUUID();
    const { server, revokeCalled } = startMockController(projectId);
    await once(server, "listening");
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const controllerUrl = `http://127.0.0.1:${port}`;
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-home-"));
    const viewerDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-viewer-"));
    const viewer = path.join(viewerDir, "viewer");
    fs.writeFileSync(viewer, "#!/usr/bin/env bash\nsleep 60\n", { mode: 0o755 });
    const children: ReturnType<typeof spawn>[] = [];
    const clientPids: number[] = [];
    try {
      for (const kind of ["argument", "dash-c"] as const) {
        const start = await execCli(
          ["tunnel", "start", "--space", projectId, "--server-url", controllerUrl, "--access-token", "test-token", "--rathole-bin", makeStubRathole(), "--json"],
          undefined,
          homeDir,
        );
        expect(start.code, start.stderr).toBe(0);
        const started = JSON.parse(start.stdout) as { pid: number; workdir: string };
        clientPids.push(started.pid);
        const configPath = path.join(started.workdir, "rathole.toml");
        // `node -e … <config>` names the path; `viewer -c <config>` has the client's arguments but is not rathole.
        const stranger =
          kind === "argument"
            ? spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", configPath], { stdio: "ignore", detached: true })
            : spawn(viewer, ["-c", configPath], { stdio: "ignore", detached: true });
        children.push(stranger);
        await new Promise((resolve) => setTimeout(resolve, 500));

        const stateFile = path.join(homeDir, ".instafy", "cli-tunnel-state.json");
        const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { tunnels: Array<{ pid: number }> };
        state.tunnels[0]!.pid = stranger.pid!;
        fs.writeFileSync(stateFile, JSON.stringify(state));

        const stopped = await execCli(
          ["tunnel", "stop", "tunnel-1", "--server-url", controllerUrl, "--access-token", "test-token"],
          undefined,
          homeDir,
        );
        expect(stopped.code, stopped.stderr).toBe(0);
        expect(revokeCalled()).toBe(true);
        expect(() => process.kill(stranger.pid!, 0), kind).not.toThrow();
      }
    } finally {
      for (const child of children) {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          // already gone
        }
      }
      for (const pid of clientPids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      server.close();
      fs.rmSync(homeDir, { recursive: true, force: true });
      fs.rmSync(viewerDir, { recursive: true, force: true });
    }
  }, 30000);
});
