import { once } from "node:events";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

type CapturedRequest = {
  method: string;
  url: string;
  auth: string | null;
};

function startMockController(handler: (req: CapturedRequest) => { status: number; body: unknown }) {
  const server = http.createServer((req, res) => {
    const response = handler({
      method: req.method ?? "",
      url: req.url ?? "",
      auth: req.headers["authorization"] ?? null,
    });
    res.writeHead(response.status, { "content-type": "application/json" });
    res.end(JSON.stringify(response.body));
  });
  server.listen(0);
  return server;
}

async function execCli(args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) {
  const packageRoot = new URL("../", import.meta.url).pathname;
  const entry = path.join(packageRoot, "bin", "instafy.js");
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-home-"));
  try {
    const child = spawn("node", [entry, ...args], {
      env: { ...process.env, HOME: tmpHome, ...(opts?.env ?? {}) },
      cwd: opts?.cwd ?? packageRoot,
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

describe("history command", () => {
  it("loads conversation messages with explicit ids", async () => {
    const conversationId = randomUUID();
    const cursor = randomUUID();
    const captured: CapturedRequest[] = [];
    const server = startMockController((req) => {
      captured.push(req);
      return {
        status: 200,
        body: {
          messages: [{ id: randomUUID(), role: "assistant", content: "hello" }],
          nextCursor: null,
          hasMore: false,
        },
      };
    });

    await once(server, "listening");
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const result = await execCli([
      "history",
      "messages",
      "--conversation",
      conversationId,
      "--limit",
      "17",
      "--cursor",
      cursor,
      "--server-url",
      `http://127.0.0.1:${port}`,
      "--access-token",
      "history-token",
    ]);

    server.close();

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("\"messages\"");
    expect(captured).toHaveLength(1);

    const req = captured[0];
    expect(req.method).toBe("GET");
    expect(req.auth).toBe("Bearer history-token");

    const url = new URL(`http://localhost${req.url}`);
    expect(url.pathname).toBe(`/conversations/${conversationId}/messages`);
    expect(url.searchParams.get("limit")).toBe("17");
    expect(url.searchParams.get("cursor")).toBe(cursor);
  });

  it("resolves project from manifest for conversation listing", async () => {
    const projectId = randomUUID();
    const captured: CapturedRequest[] = [];
    const server = startMockController((req) => {
      captured.push(req);
      return {
        status: 200,
        body: [{ id: randomUUID(), projectId }],
      };
    });

    await once(server, "listening");
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-history-space-"));
    fs.mkdirSync(path.join(tmpDir, ".instafy"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".instafy", "space.json"),
      JSON.stringify({ spaceId: projectId }, null, 2),
    );

    const result = await execCli(
      [
        "history",
        "conversations",
        "--limit",
        "9",
        "--server-url",
        `http://127.0.0.1:${port}`,
        "--access-token",
        "history-token",
      ],
      { cwd: tmpDir },
    );

    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });

    expect(result.code).toBe(0);
    expect(captured).toHaveLength(1);
    const req = captured[0];
    expect(req.method).toBe("GET");
    const url = new URL(`http://localhost${req.url}`);
    expect(url.pathname).toBe(`/projects/${projectId}/conversations`);
    expect(url.searchParams.get("limit")).toBe("9");
  });
});
