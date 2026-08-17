import { once } from "node:events";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mintPrivateRuntimeIdentity } from "../dist/runtime.js";

function startMockController(token: string) {
  const projectId = randomUUID();
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === `/projects/${projectId}/runtime/token`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ token, expires_at: new Date().toISOString(), expires_in: 600 }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0);
  return { server, projectId };
}

async function execCli(args: string[], env?: NodeJS.ProcessEnv) {
  const entry = "dist/index.js";
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-home-"));
  try {
    const child = spawn(
      "node",
      [entry, ...args],
      {
        env: { ...process.env, HOME: tmpHome, ...env },
        cwd: new URL("../", import.meta.url).pathname,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const stdoutPromise = readAll(child.stdout);
    const stderrPromise = readAll(child.stderr);
    const [code] = (await once(child, "exit")) as [number | null];
    const stdout = await stdoutPromise;
    const stderr = await stderrPromise;
    return { code, stdout, stderr };
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

async function readAll(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

describe("runtime token", () => {
  it("prepares a private runtime identity without entering the hosted allocator", async () => {
    const projectId = randomUUID();
    const runtimeId = randomUUID();
    const token = [
      "header",
      Buffer.from(JSON.stringify({ runtime_id: runtimeId })).toString("base64url"),
      "signature",
    ].join(".");
    const requestedPaths: string[] = [];
    const server = http.createServer((req, res) => {
      requestedPaths.push(req.url ?? "");
      if (req.method === "POST" && req.url === `/projects/${projectId}/runtime/token`) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token, runtimeId }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0);
    await once(server, "listening");

    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const identity = await mintPrivateRuntimeIdentity({
        controllerUrl: `http://127.0.0.1:${port}`,
        controllerAccessToken: "controller-token",
        projectId,
      });

      expect(identity).toEqual({ token, runtimeId });
      expect(requestedPaths).toEqual([`/projects/${projectId}/runtime/token`]);
      expect(requestedPaths.some((value) => value.endsWith("/runtime/request"))).toBe(false);
    } finally {
      server.close();
    }
  });

  it("prints minted token from controller", async () => {
    const expectedToken = "cli-runtime-token";
    const { server, projectId } = startMockController(expectedToken);
    await once(server, "listening");
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const controllerUrl = `http://127.0.0.1:${port}`;

      const { code, stdout, stderr } = await execCli([
        "runtime",
        "token",
        "--space",
        projectId,
        "--server-url",
        controllerUrl,
        "--access-token",
        "controller-token",
      ]);

      expect(code).toBe(0);
      if (!stdout.includes(expectedToken)) {
        // eslint-disable-next-line no-console
        console.error("stdout:", stdout, "stderr:", stderr);
      }
      expect(stdout).toContain(expectedToken);
    } finally {
      server.close();
    }
  });

  it("fails without controller access token", async () => {
    const { code, stdout, stderr } = await execCli([
      "runtime",
      "token",
      "--space",
      randomUUID(),
    ]);

    expect(code).not.toBe(0);
    expect(
      stderr.includes("Login required") ||
        stdout.includes("Login required"),
    ).toBe(true);
  });
});
