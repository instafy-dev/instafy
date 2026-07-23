import { once } from "node:events";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

function startMockController(projectId: string) {
  const captured: Array<{ method: string; url: string; auth: string | null }> = [];
  const server = http.createServer((req, res) => {
    captured.push({
      method: req.method ?? "",
      url: req.url ?? "",
      auth: typeof req.headers["authorization"] === "string" ? req.headers["authorization"] : null,
    });
    if (req.method === "POST" && req.url === `/projects/${projectId}/memory/bootstrap`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          seeded: true,
          fileCount: 3,
          rev: "git:test-rev",
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0);
  return { server, captured };
}

async function execCli(args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) {
  const entry = "dist/index.js";
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-home-"));
  try {
    const child = spawn("node", [entry, ...args], {
      env: { ...process.env, HOME: tmpHome, ...(opts?.env ?? {}) },
      cwd: new URL("../", import.meta.url).pathname,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutPromise = readAll(child.stdout);
    const stderrPromise = readAll(child.stderr);
    const [code] = (await once(child, "exit")) as [number | null];
    return {
      code,
      stdout: await stdoutPromise,
      stderr: await stderrPromise,
    };
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

describe("project defaults refresh", () => {
  it("refreshes pinned defaults for a linked project", async () => {
    const projectId = randomUUID();
    const { server, captured } = startMockController(projectId);
    await once(server, "listening");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-space-"));
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const controllerUrl = `http://127.0.0.1:${port}`;
      fs.mkdirSync(path.join(tmpDir, ".instafy"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".instafy", "space.json"),
        JSON.stringify(
          {
            spaceId: projectId,
            controllerUrl,
            profile: null,
          },
          null,
          2,
        ),
      );

      const result = await execCli(
        [
          "space",
          "defaults",
          "refresh",
          "--path",
          tmpDir,
          "--access-token",
          "controller-token",
          "--json",
        ],
        { cwd: tmpDir },
      );

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        projectId,
        ok: true,
        seeded: true,
        fileCount: 3,
        rev: "git:test-rev",
      });
      expect(captured).toEqual([
        {
          method: "POST",
          url: `/projects/${projectId}/memory/bootstrap`,
          auth: "Bearer controller-token",
        },
      ]);
    } finally {
      server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
