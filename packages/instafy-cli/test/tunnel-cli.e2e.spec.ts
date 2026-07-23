import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildRatholeEnvironment,
  runTunnelCommand,
  startTunnelSession,
} from "../dist/tunnel.js";

type RequestCapture = {
  path: string;
  body: string;
  authorization?: string;
};

function makeStubRathole(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-stub-rathole-"));
  const file = path.join(dir, "rathole");
  const script = process.platform === "win32"
    ? "@echo off\nping 127.0.0.1 -n 2 >nul\n"
    : "#!/usr/bin/env bash\nsleep 0.2\n";
  fs.writeFileSync(file, script, { mode: 0o755 });
  return file;
}

describe("instafy tunnel CLI", () => {
  it("starts persistent tunnel helpers with a credential-free environment", () => {
    const environment = buildRatholeEnvironment({
      PATH: process.env.PATH ?? "",
      HOME: "/safe/home",
      USER: "safe-user",
      LANG: "sv_SE.UTF-8",
      TMPDIR: os.tmpdir(),
      CONTROLLER_ACCESS_TOKEN: "poisoned-controller-token",
      PROXY_BASE_URL: "https://proxy-with-credentials.invalid",
      CODEX_HOME: "/poisoned/codex-home",
      OPENAI_API_KEY: "poisoned-openai-key",
      PROJECT_DEPLOY_SECRET: "poisoned-project-secret",
    });
    const child = spawnSync(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify(process.env))"],
      { env: environment, encoding: "utf8" },
    );

    expect(child.status, child.stderr).toBe(0);
    const childEnvironment = JSON.parse(child.stdout || "{}") as Record<string, string>;
    expect(childEnvironment).toMatchObject({
      HOME: "/safe/home",
      USER: "safe-user",
      LANG: "sv_SE.UTF-8",
      TMPDIR: os.tmpdir(),
    });
    expect(childEnvironment).not.toHaveProperty("CONTROLLER_ACCESS_TOKEN");
    expect(childEnvironment).not.toHaveProperty("PROXY_BASE_URL");
    expect(childEnvironment).not.toHaveProperty("CODEX_HOME");
    expect(childEnvironment).not.toHaveProperty("OPENAI_API_KEY");
    expect(childEnvironment).not.toHaveProperty("PROJECT_DEPLOY_SECRET");
  });

  it("requests and revokes a tunnel", async () => {
    const spaceId = randomUUID();
    const captures: RequestCapture[] = [];
    let revokeCalled = false;
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        captures.push({
          path: req.url ?? "",
          body,
          authorization: req.headers.authorization,
        });
        if (req.url?.endsWith("/tunnels/request")) {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              tunnelId: "tunnel-1",
              hostname: "test.rt.instafy.dev",
              url: "https://test.rt.instafy.dev",
              credentials: { server: "127.0.0.1:7000", token: "dev-token" },
              status: "active",
              expires_at: new Date().toISOString(),
            }),
          );
        } else if (req.url?.includes("/revoke")) {
          revokeCalled = true;
          res.statusCode = 200;
          res.end("{}");
        } else {
          res.statusCode = 404;
          res.end();
        }
      });
    });
    server.listen(0);
    const addr = server.address();
    if (!addr || typeof addr !== "object") throw new Error("failed to bind test server");

    const stubRathole = makeStubRathole();

    await runTunnelCommand(
      {
        project: spaceId,
        controllerUrl: `http://127.0.0.1:${addr.port}`,
        controllerToken: "test-token",
        port: 4000,
        ratholeBin: stubRathole,
      },
      { timeoutMs: 8000 },
    );

    server.close();
    const requestCapture = captures.find((c) => c.path.endsWith("/tunnels/request"));
    if (!requestCapture) {
      throw new Error(`expected tunnel request, got paths=${captures.map((c) => c.path).join(", ")}`);
    }
    const parsed = requestCapture ? JSON.parse(requestCapture.body || "{}") : {};
    expect(parsed.purpose).toBe("web");
    expect(parsed.localPort).toBe(4000);
    expect(parsed.metadata?.localPort).toBe(4000);
    const revokeCapture = captures.find((c) => c.path.includes("/revoke"));
    if (!revokeCapture) {
      throw new Error(`expected revoke request, got paths=${captures.map((c) => c.path).join(", ")}`);
    }
    expect(revokeCalled).toBe(true);
  }, 30000);

  it("persists and reuses a sticky tunnel purpose via .instafy/space.json", async () => {
    const spaceId = randomUUID();
    const captures: RequestCapture[] = [];
    let revokeCalled = false;
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        captures.push({
          path: req.url ?? "",
          body,
          authorization: req.headers.authorization,
        });
        if (req.url?.endsWith("/tunnels/request")) {
          const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
          const purpose = typeof parsed.purpose === "string" ? parsed.purpose : "missing";
          const hostname = `${purpose}.rt.instafy.dev`;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              tunnelId: `tunnel-${captures.length}`,
              hostname,
              url: `https://${hostname}`,
              credentials: { server: "127.0.0.1:7000", token: "dev-token" },
              status: "active",
              expires_at: new Date().toISOString(),
            }),
          );
        } else if (req.url?.includes("/revoke")) {
          revokeCalled = true;
          res.statusCode = 200;
          res.end("{}");
        } else {
          res.statusCode = 404;
          res.end();
        }
      });
    });
    server.listen(0);
    const addr = server.address();
    if (!addr || typeof addr !== "object") throw new Error("failed to bind test server");

    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-tunnel-sticky-"));
    const instafyDir = path.join(rootDir, ".instafy");
    fs.mkdirSync(instafyDir, { recursive: true });
    const manifestPath = path.join(instafyDir, "space.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          spaceId,
          controllerUrl: `http://127.0.0.1:${addr.port}`,
          profile: null,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );

    const stubRathole = makeStubRathole();
    try {
      const first = await startTunnelSession({
        controllerToken: "test-token",
        port: 4100,
        cwd: rootDir,
        ratholeBin: stubRathole,
      });
      await first.close();

      const manifestAfterFirst = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, any>;
      const firstPurpose = manifestAfterFirst?.tunnels?.web?.purpose;
      expect(typeof firstPurpose).toBe("string");
      expect(firstPurpose).toMatch(/^web_/);
      expect(manifestAfterFirst?.tunnels?.web?.hostname).toBe(`${firstPurpose}.rt.instafy.dev`);
      expect(manifestAfterFirst?.tunnels?.web?.url).toBe(`https://${firstPurpose}.rt.instafy.dev`);

      const firstRequest = captures.find((c) => c.path.endsWith("/tunnels/request"));
      expect(firstRequest).toBeTruthy();
      const firstBody = firstRequest ? (JSON.parse(firstRequest.body || "{}") as Record<string, unknown>) : {};
      expect(firstBody.purpose).toBe(firstPurpose);
      expect(firstBody.localPort).toBe(4100);

      const second = await startTunnelSession({
        controllerToken: "test-token",
        port: 4101,
        cwd: rootDir,
        ratholeBin: stubRathole,
      });
      await second.close();

      const requests = captures.filter((c) => c.path.endsWith("/tunnels/request"));
      expect(requests.length).toBeGreaterThanOrEqual(2);
      const secondBody = JSON.parse(requests[1]!.body || "{}") as Record<string, unknown>;
      expect(secondBody.purpose).toBe(firstPurpose);

      const third = await startTunnelSession({
        controllerToken: "test-token",
        port: 4102,
        cwd: rootDir,
        rotate: true,
        ratholeBin: stubRathole,
      });
      await third.close();

      const manifestAfterRotate = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, any>;
      const rotatedPurpose = manifestAfterRotate?.tunnels?.web?.purpose;
      expect(typeof rotatedPurpose).toBe("string");
      expect(rotatedPurpose).toMatch(/^web_/);
      expect(rotatedPurpose).not.toBe(firstPurpose);

      const rotatedRequests = captures.filter((c) => c.path.endsWith("/tunnels/request"));
      const last = JSON.parse(rotatedRequests[rotatedRequests.length - 1]!.body || "{}") as Record<
        string,
        unknown
      >;
      expect(last.purpose).toBe(rotatedPurpose);
      expect(last.localPort).toBe(4102);
      expect(revokeCalled).toBe(true);
    } finally {
      server.close();
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  }, 30000);

  it("uses the active-job token and sends its exact runtime lease binding", async () => {
    const projectId = randomUUID();
    const runtimeId = randomUUID();
    const runtimeLeaseId = randomUUID();
    const captures: RequestCapture[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        captures.push({
          path: req.url ?? "",
          body,
          authorization: req.headers.authorization,
        });
        if (req.url?.endsWith("/tunnels/request")) {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              tunnelId: "tunnel-job-bound",
              hostname: "job-bound.rt.instafy.dev",
              url: "https://job-bound.rt.instafy.dev",
              credentials: { server: "127.0.0.1:7000", token: "dev-token" },
            }),
          );
        } else if (req.url?.includes("/revoke")) {
          res.setHeader("content-type", "application/json");
          res.end("{}");
        } else {
          res.statusCode = 404;
          res.end();
        }
      });
    });
    server.listen(0);
    const addr = server.address();
    if (!addr || typeof addr !== "object") throw new Error("failed to bind test server");

    const envKeys = [
      "INSTAFY_ACCESS_TOKEN",
      "CONTROLLER_ACCESS_TOKEN",
      "RUNTIME_ACCESS_TOKEN",
      "RUNTIME_ID",
      "RUNTIME_LEASE_ID",
    ] as const;
    const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
    delete process.env.INSTAFY_ACCESS_TOKEN;
    process.env.CONTROLLER_ACCESS_TOKEN = "active-job-token";
    process.env.RUNTIME_ACCESS_TOKEN = "runtime-machine-token";
    process.env.RUNTIME_ID = runtimeId;
    process.env.RUNTIME_LEASE_ID = runtimeLeaseId;

    const stubRathole = makeStubRathole();
    try {
      const session = await startTunnelSession({
        project: projectId,
        controllerUrl: `http://127.0.0.1:${addr.port}`,
        port: 4173,
        ratholeBin: stubRathole,
      });
      await session.close();

      const requested = captures.find((capture) => capture.path.endsWith("/tunnels/request"));
      expect(requested?.authorization).toBe("Bearer active-job-token");
      const body = JSON.parse(requested?.body || "{}") as Record<string, unknown>;
      expect(body.runtimeId).toBe(runtimeId);
      expect(body.runtimeLeaseId).toBe(runtimeLeaseId);
      expect(body.purpose).toBe("web");
      expect(body.localPort).toBe(4173);
      expect(body.metadata).toMatchObject({ source: "instafy-cli", localPort: 4173 });

      const revoked = captures.find((capture) => capture.path.includes("/revoke"));
      expect(revoked?.authorization).toBe("Bearer active-job-token");
    } finally {
      server.close();
      for (const [key, value] of previous) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  }, 30000);
});
