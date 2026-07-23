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
  body: string;
};

function startMockController(handler: (req: CapturedRequest) => { status: number; body: unknown }) {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const response = handler({
      method: req.method ?? "",
      url: req.url ?? "",
      auth: req.headers["authorization"] ?? null,
      body: Buffer.concat(chunks).toString("utf8"),
    });
    res.writeHead(response.status, { "content-type": "application/json" });
    res.end(JSON.stringify(response.body));
  });
  server.listen(0);
  return server;
}

async function execCli(args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) {
  const packageRoot = new URL("../", import.meta.url).pathname;
  const entry = path.join(packageRoot, "dist", "index.js");
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

describe("chat command", () => {
  it("creates a conversation, waits for the assistant, and prints the reply", async () => {
    const projectId = randomUUID();
    const conversationId = randomUUID();
    const runId = randomUUID();
    const promptId = randomUUID();
    const captured: CapturedRequest[] = [];
    let runsPolls = 0;
    let messagesPolls = 0;

    const server = startMockController((req) => {
      captured.push(req);
      if (req.method === "POST" && req.url === `/projects/${projectId}/conversations`) {
        return {
          status: 200,
          body: {
            conversationId,
            runId,
            promptId,
            status: "queued",
          },
        };
      }

      if (req.method === "GET" && req.url === `/conversations/${conversationId}/runs?limit=100`) {
        runsPolls += 1;
        return {
          status: 200,
          body: [{ id: runId, status: runsPolls >= 2 ? "completed" : "running" }],
        };
      }

      if (req.method === "GET" && req.url === `/conversations/${conversationId}/messages?limit=200`) {
        messagesPolls += 1;
        const body =
          messagesPolls >= 2
            ? {
                messages: [
                  {
                    id: randomUUID(),
                    conversationId,
                    runId,
                    role: "assistant",
                    content: "Example Domain",
                    metadata: {},
                  },
                  {
                    id: randomUUID(),
                    conversationId,
                    runId,
                    role: "assistant",
                    content: "",
                    metadata: { messageType: "token_usage" },
                  },
                ],
              }
            : { messages: [] };
        return { status: 200, body };
      }

      return { status: 404, body: { error: "not found" } };
    });

    await once(server, "listening");
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const result = await execCli([
      "chat",
      "Read",
      "the",
      "title",
      "--space",
      projectId,
      "--controller-url",
      `http://127.0.0.1:${port}`,
      "--access-token",
      "chat-token",
      "--timeout-ms",
      "5000",
      "--poll-ms",
      "10",
    ]);

    server.close();

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("Example Domain");
    expect(captured[0]?.auth).toBe("Bearer chat-token");
    expect(captured[0]?.method).toBe("POST");
    expect(captured[0]?.url).toBe(`/projects/${projectId}/conversations`);
    expect(JSON.parse(captured[0]?.body ?? "{}")).toMatchObject({
      promptText: "Read the title",
      intent: "feature",
    });
    expect(runsPolls).toBeGreaterThan(0);
    expect(messagesPolls).toBeGreaterThan(0);
  });

  it("uses an existing conversation without waiting when requested", async () => {
    const conversationId = randomUUID();
    const runId = randomUUID();
    const promptId = randomUUID();
    const captured: CapturedRequest[] = [];

    const server = startMockController((req) => {
      captured.push(req);
      if (req.method === "POST" && req.url === `/conversations/${conversationId}/messages`) {
        return {
          status: 200,
          body: {
            conversationId,
            runId,
            promptId,
            status: "queued",
          },
        };
      }
      return { status: 404, body: { error: "not found" } };
    });

    await once(server, "listening");
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const result = await execCli([
      "chat",
      "follow",
      "up",
      "--conversation",
      conversationId,
      "--controller-url",
      `http://127.0.0.1:${port}`,
      "--access-token",
      "chat-token",
      "--no-wait",
      "--json",
    ]);

    server.close();

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      conversationId,
      runId,
      promptId,
      status: "queued",
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.method).toBe("POST");
    expect(captured[0]?.url).toBe(`/conversations/${conversationId}/messages`);
    expect(JSON.parse(captured[0]?.body ?? "{}")).toMatchObject({
      promptText: "follow up",
      intent: "feature",
    });
  });

  it("sends explicit @agent mention metadata for controller routing", async () => {
    const conversationId = randomUUID();
    const runId = randomUUID();
    const promptId = randomUUID();
    const captured: CapturedRequest[] = [];

    const server = startMockController((req) => {
      captured.push(req);
      if (req.method === "POST" && req.url === `/conversations/${conversationId}/messages`) {
        return {
          status: 200,
          body: {
            conversationId,
            runId,
            promptId,
            status: "queued",
          },
        };
      }
      return { status: 404, body: { error: "not found" } };
    });

    await once(server, "listening");
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const result = await execCli([
      "chat",
      "@ben",
      "what",
      "is",
      "3+4?",
      "@octo",
      "double-check",
      "--conversation",
      conversationId,
      "--controller-url",
      `http://127.0.0.1:${port}`,
      "--access-token",
      "chat-token",
      "--no-wait",
      "--json",
    ]);

    server.close();

    expect(result.code).toBe(0);
    expect(captured).toHaveLength(1);
    expect(JSON.parse(captured[0]?.body ?? "{}")).toMatchObject({
      promptText: "@ben what is 3+4? @octo double-check",
      intent: "feature",
      metadata: {
        agentSelection: {
          active: ["ben", "octo"],
          mentions: ["ben", "octo"],
        },
      },
    });
  });

  it("does not wait by default inside an active runtime job", async () => {
    const conversationId = randomUUID();
    const runId = randomUUID();
    const promptId = randomUUID();
    const captured: CapturedRequest[] = [];

    const server = startMockController((req) => {
      captured.push(req);
      if (req.method === "POST" && req.url === `/conversations/${conversationId}/messages`) {
        return {
          status: 200,
          body: {
            conversationId,
            runId,
            promptId,
            status: "queued",
          },
        };
      }
      return { status: 404, body: { error: "not found" } };
    });

    await once(server, "listening");
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const result = await execCli(
      [
        "chat",
        "@ben",
        "what",
        "is",
        "8+1?",
        "--conversation",
        conversationId,
        "--controller-url",
        `http://127.0.0.1:${port}`,
        "--access-token",
        "chat-token",
        "--json",
      ],
      {
        env: {
          RUNTIME_ID: randomUUID(),
          CONTROLLER_ACCESS_TOKEN: "runtime-token",
          INSTAFY_CONVERSATION_ID: randomUUID(),
        },
      },
    );

    server.close();

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      conversationId,
      runId,
      promptId,
      status: "queued",
    });
    expect(captured).toHaveLength(1);
  });
});
