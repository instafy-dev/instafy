import { once } from "node:events";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

type MockConversation = {
  id: string;
  title?: string;
  preview?: string | null;
  updatedAt?: string;
  messages?: Array<{ role: string; content: string; createdAt?: string }>;
};

type CapturedRequest = {
  method: string;
  url: string;
  auth: string | null;
  body: string;
};

function startMockController(projectId: string, conversations: MockConversation[]) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === `/projects/${projectId}/conversations`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          conversations.map((conversation) => ({
            id: conversation.id,
            metadata: conversation.title ? { title: conversation.title } : {},
            lastMessagePreview: conversation.preview ?? null,
            updatedAt: conversation.updatedAt ?? "2026-03-13T10:00:00.000Z",
            createdAt: "2026-03-13T09:00:00.000Z",
            parentConversationId: null,
            rootConversationId: null,
            threadKind: null,
          })),
        ),
      );
      return;
    }

    const conversationMatch = url.pathname.match(/^\/conversations\/([^/]+)\/messages$/);
    if (req.method === "GET" && conversationMatch) {
      const conversationId = decodeURIComponent(conversationMatch[1] ?? "");
      const conversation = conversations.find((entry) => entry.id === conversationId);
      if (!conversation) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          messages: (conversation.messages ?? []).map((message, index) => ({
            id: `${conversationId}-${index}`,
            role: message.role,
            content: message.content,
            createdAt: message.createdAt ?? "2026-03-13T09:00:00.000Z",
          })),
          nextCursor: null,
          hasMore: false,
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });
  server.listen(0);
  return server;
}

function startCreateConversationMockController(
  handler: (req: CapturedRequest) => { status: number; body: unknown },
) {
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

async function execCli(args: string[], env?: NodeJS.ProcessEnv) {
  const entry = "bin/instafy.js";
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-home-"));
  try {
    const child = spawn("node", [entry, ...args], {
      env: { ...process.env, HOME: tmpHome, ...env },
      cwd: new URL("../", import.meta.url).pathname,
      stdio: ["ignore", "pipe", "pipe"],
    });

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

describe("conversation commands", () => {
  it("creates a linked child thread with title metadata and thread kind", async () => {
    const projectId = randomUUID();
    const parentConversationId = randomUUID();
    const childConversationId = randomUUID();
    const captured: CapturedRequest[] = [];
    const server = startCreateConversationMockController((req) => {
      captured.push(req);
      if (req.method === "POST" && req.url === `/projects/${projectId}/conversations/blank`) {
        return {
          status: 200,
          body: {
            conversationId: childConversationId,
          },
        };
      }
      return { status: 404, body: { error: "not found" } };
    });
    await once(server, "listening");
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const controllerUrl = `http://127.0.0.1:${port}`;

      const { code, stdout, stderr } = await execCli([
        "conversation",
        "create",
        "--space",
        projectId,
        "--parent",
        parentConversationId,
        "--thread-kind",
        "agent",
        "--title",
        "Octo coordination",
        "--server-url",
        controllerUrl,
        "--access-token",
        "controller-token",
        "--json",
      ]);

      if (code !== 0) {
        // eslint-disable-next-line no-console
        console.error("stdout:", stdout, "stderr:", stderr);
      }
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        conversationId: childConversationId,
        projectId,
        parentConversationId,
        threadKind: "agent",
        title: "Octo coordination",
      });
      expect(captured).toHaveLength(1);
      expect(captured[0]?.auth).toBe("Bearer controller-token");
      expect(captured[0]?.method).toBe("POST");
      expect(captured[0]?.url).toBe(`/projects/${projectId}/conversations/blank`);
      expect(JSON.parse(captured[0]?.body ?? "{}")).toMatchObject({
        metadata: { title: "Octo coordination" },
        parentConversationId,
        threadKind: "agent",
      });
    } finally {
      server.close();
    }
  });

  it("searches recent conversations using message content when title and preview do not match", async () => {
    const projectId = randomUUID();
    const conversations: MockConversation[] = [
      {
        id: randomUUID(),
        title: "General planning",
        preview: "Latest setup tasks",
        messages: [
          { role: "user", content: "We should sort out tunnels later." },
          { role: "assistant", content: "Okay." },
        ],
      },
      {
        id: randomUUID(),
        title: "Method notes",
        preview: "Latest follow-up",
        messages: [
          { role: "user", content: "In the fruit conversation we compared pears and apples." },
          { role: "assistant", content: "The fruit method emphasized grouping by texture." },
        ],
      },
    ];
    const server = startMockController(projectId, conversations);
    await once(server, "listening");
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const controllerUrl = `http://127.0.0.1:${port}`;

      const { code, stdout, stderr } = await execCli([
        "conversation",
        "search",
        "fruit",
        "--space",
        projectId,
        "--server-url",
        controllerUrl,
        "--access-token",
        "controller-token",
      ]);

      if (code !== 0) {
        // eslint-disable-next-line no-console
        console.error("stdout:", stdout, "stderr:", stderr);
      }
      expect(code).toBe(0);
      expect(stdout).toContain('Matches for "fruit"');
      expect(stdout).toContain("Method notes");
      expect(stdout).toContain("match: messages");
    } finally {
      server.close();
    }
  });

  it("shows conversation messages by title", async () => {
    const projectId = randomUUID();
    const conversationId = randomUUID();
    const conversations: MockConversation[] = [
      {
        id: conversationId,
        title: "Fruit planning",
        preview: "We discussed pears and apples",
        messages: [
          {
            role: "user",
            content: "Please summarize the fruit ideas.",
            createdAt: "2026-03-13T09:00:00.000Z",
          },
          {
            role: "assistant",
            content: "We grouped pears and apples by seasonality.",
            createdAt: "2026-03-13T09:01:00.000Z",
          },
        ],
      },
    ];
    const server = startMockController(projectId, conversations);
    await once(server, "listening");
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const controllerUrl = `http://127.0.0.1:${port}`;

      const { code, stdout, stderr } = await execCli([
        "conversation",
        "show",
        "Fruit planning",
        "--space",
        projectId,
        "--server-url",
        controllerUrl,
        "--access-token",
        "controller-token",
      ]);

      if (code !== 0) {
        // eslint-disable-next-line no-console
        console.error("stdout:", stdout, "stderr:", stderr);
      }
      expect(code).toBe(0);
      expect(stdout).toContain("Fruit planning");
      expect(stdout).toContain(`ID: ${conversationId}`);
      expect(stdout).toContain("[user · 2026-03-13T09:00:00.000Z]");
      expect(stdout).toContain("Please summarize the fruit ideas.");
      expect(stdout).toContain("We grouped pears and apples by seasonality.");
    } finally {
      server.close();
    }
  });
});
