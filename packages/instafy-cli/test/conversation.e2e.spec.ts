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

function startMockController(
  projectId: string,
  conversations: MockConversation[],
  requests: string[] = [],
) {
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? "");
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
  async function withTranscriptController(
    getPage: (cursor: string | null, limit: number) => unknown,
    run: (args: string[], requests: CapturedRequest[]) => Promise<void>,
  ) {
    const projectId = randomUUID();
    const conversationId = randomUUID();
    const requests: CapturedRequest[] = [];
    const server = startCreateConversationMockController((req) => {
      requests.push(req);
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === `/projects/${projectId}/conversations`) {
        return { status: 200, body: [{ id: conversationId, metadata: { title: "Pilot planning" } }] };
      }
      if (url.pathname === `/conversations/${conversationId}/messages`) {
        return { status: 200, body: getPage(url.searchParams.get("cursor"), Number(url.searchParams.get("limit"))) };
      }
      return { status: 404, body: { error: "not found" } };
    });
    await once(server, "listening");
    try {
      const address = server.address() as { port: number };
      await run([
        "conversation", "show", conversationId, "--space", projectId,
        "--server-url", `http://127.0.0.1:${address.port}`, "--access-token", "transcript-test-token", "--json",
      ], requests);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  const transcriptRow = (role: string, content: string, metadata: Record<string, unknown> = {}) => ({
    id: randomUUID(), role, content, createdAt: "2026-10-07T10:00:00.000Z", metadata,
  });

  it("pages beyond event-only rows, counts transcript messages, and resumes within a raw page without skipping facts", async () => {
    const events = Array.from({ length: 200 }, () => transcriptRow("assistant", "tool output", {
      source: "agent", kind: "update", messageType: "command_execution", details: { output: "runtime telemetry".repeat(100) },
    }));
    const answer = transcriptRow("assistant", "Keep the pilot asynchronous.\n[Source](instafy://conversation/source)", { outcome: "succeeded" });
    const user = transcriptRow("user", "Harbor is waiting for an FAQ. No meetings or pricing promise.\n" + "Exact source text. ".repeat(300));
    const older = transcriptRow("user", "Original pilot goal");
    const all = [...events, answer, user, older];
    await withTranscriptController((cursor, limit) => {
      const start = cursor ? all.findIndex((row) => row.id === cursor) + 1 : 0;
      const messages = all.slice(start, start + limit);
      const hasMore = start + limit < all.length;
      return { messages, hasMore, nextCursor: hasMore ? messages.at(-1)?.id : null };
    }, async (args, requests) => {
      const first = await execCli([...args, "--transcript", "--limit", "2"]);
      expect(first.code, first.stderr).toBe(0);
      const page = JSON.parse(first.stdout);
      expect(page.messages).toEqual([answer, user].map(({ metadata, ...row }) => row));
      expect(page).toMatchObject({ hasMore: true, nextCursor: user.id });
      expect(first.stdout).not.toContain("runtime telemetry");
      expect(requests.filter((req) => req.url.includes("/messages"))).toHaveLength(2);
      expect(requests.every((req) => req.auth === "Bearer transcript-test-token")).toBe(true);
      const next = await execCli([...args, "--transcript", "--cursor", page.nextCursor]);
      expect(next.code, next.stderr).toBe(0);
      expect(JSON.parse(next.stdout)).toMatchObject({
        messages: [{ id: older.id, role: "user", content: older.content, createdAt: older.createdAt }],
        hasMore: false, nextCursor: null,
      });
    });
  });

  it("recognizes assistant runtime wrappers and hidden rows while preserving user text, final replies and request cards", async () => {
    const user = transcriptRow("user", "A message mentioning command_execution is still user text.", { messageType: "command_execution" });
    const final = transcriptRow("assistant", "Final reply", { outcome: "succeeded", artifacts: [{ large: "omitted" }] });
    const requests = [
      transcriptRow("assistant", "Please provide the API key.", { kind: "update", messageType: "secret_request" }),
      transcriptRow("assistant", "Please connect your calendar.", { kind: "update", messageType: "integration_request" }),
      transcriptRow("assistant", "Please approve the calendar event.", { kind: "update", messageType: "action_request" }),
    ];
    const messages = [
      transcriptRow("assistant", "usage", { message_type: " token_usage " }),
      transcriptRow("assistant", "reasoning", { details: { runtimeId: "runtime", details: { messageType: "reasoning" } } }),
      transcriptRow("assistant", "command", { details: { kind: "codex_command_execution" } }),
      transcriptRow("assistant", "search", { details: { type: "web_search" } }),
      transcriptRow("assistant", "progress", { source: "agent", kind: "update", outcome: "in_progress" }),
      transcriptRow("assistant", "commit", { details: { kind: "workspace_commit" } }),
      transcriptRow("assistant", "hidden", { details: { presentation: { hidden: true } } }),
      transcriptRow("tool", "tool response"), transcriptRow("system", "system instructions"),
      user, final, ...requests,
    ];
    await withTranscriptController(() => ({ messages, hasMore: false, nextCursor: null }), async (args) => {
      const compact = await execCli([...args, "--transcript"]);
      expect(compact.code, compact.stderr).toBe(0);
      expect(JSON.parse(compact.stdout).messages).toEqual([user, final, ...requests].map(({ metadata, ...row }) => row));
      const raw = await execCli(args);
      expect(raw.code, raw.stderr).toBe(0);
      expect(JSON.parse(raw.stdout).messages).toEqual(messages);
      expect(JSON.parse(raw.stdout)).not.toHaveProperty("hasMore");
      expect(JSON.parse(raw.stdout)).not.toHaveProperty("nextCursor");
    });
  });

  it("bounds event-only scans and gives the last scanned event cursor for continuation", async () => {
    const events = Array.from({ length: 2_000 }, () => transcriptRow("assistant", "tool", { kind: "update" }));
    const fact = transcriptRow("user", "Harbor source fact beyond the event budget");
    const all = [...events, fact];
    await withTranscriptController((cursor, limit) => {
      const start = cursor ? all.findIndex((row) => row.id === cursor) + 1 : 0;
      const messages = all.slice(start, start + limit);
      const hasMore = start + limit < all.length;
      return { messages, hasMore, nextCursor: hasMore ? messages.at(-1)?.id : null };
    }, async (args, requests) => {
      const first = await execCli([...args, "--transcript"]);
      expect(first.code, first.stderr).toBe(0);
      const page = JSON.parse(first.stdout);
      expect(page).toMatchObject({ messages: [], hasMore: true, nextCursor: events.at(-1)?.id });
      expect(requests.filter((req) => req.url.includes("/messages"))).toHaveLength(10);
      const next = await execCli([...args, "--transcript", "--cursor", page.nextCursor]);
      expect(next.code, next.stderr).toBe(0);
      expect(JSON.parse(next.stdout)).toMatchObject({ messages: [{ id: fact.id }], hasMore: false, nextCursor: null });
    });
  });

  it("rejects repeated server cursors without looping or printing a partial transcript", async () => {
    const event = transcriptRow("assistant", "tool", { kind: "update" });
    await withTranscriptController(() => ({ messages: [event], hasMore: true, nextCursor: event.id }), async (args, requests) => {
      const result = await execCli([...args, "--transcript"]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("invalid or repeated transcript cursor");
      expect(requests.filter((req) => req.url.includes("/messages"))).toHaveLength(2);
    });
  });

  it.each([
    { messages: [] },
    { messages: [], hasMore: true, nextCursor: randomUUID() },
    { messages: [transcriptRow("user", "fact")], hasMore: true, nextCursor: "invalid" },
  ])("rejects missing or invalid transcript pagination instead of claiming a complete read: %j", async (page) => {
    await withTranscriptController(() => page, async (args) => {
      const result = await execCli([...args, "--transcript"]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/transcript (pagination metadata|cursor)/);
    });
  });

  it("validates transcript cursors before making requests", async () => {
    await withTranscriptController(() => ({}), async (args, requests) => {
      for (const flags of [["--cursor", randomUUID()], ["--transcript", "--cursor", "not-a-message-id"]]) {
        const result = await execCli([...args, ...flags]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("--cursor requires --transcript");
      }
      expect(requests).toHaveLength(0);
    });
  });

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

  function twoConversations(): { current: MockConversation; other: MockConversation } {
    return {
      current: {
        id: randomUUID(),
        title: "Bookkeeping setup",
        messages: [{ role: "user", content: "What's next in the setup?" }],
      },
      other: {
        id: randomUUID(),
        title: "Fruit planning",
        messages: [{ role: "user", content: "Please summarize the fruit ideas." }],
      },
    };
  }

  async function showWithEnv(
    projectId: string,
    conversations: MockConversation[],
    target: string[],
    env: NodeJS.ProcessEnv,
    requests: string[] = [],
  ) {
    const server = startMockController(projectId, conversations, requests);
    await once(server, "listening");
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      return await execCli(
        [
          "conversation",
          "show",
          ...target,
          "--include-threads",
          "--space",
          projectId,
          "--server-url",
          `http://127.0.0.1:${port}`,
          "--access-token",
          "controller-token",
          "--json",
        ],
        env,
      );
    } finally {
      server.close();
    }
  }

  it("shows the current conversation from INSTAFY_CONVERSATION_ID when no target is given", async () => {
    const projectId = randomUUID();
    const { current, other } = twoConversations();

    const { code, stdout, stderr } = await showWithEnv(projectId, [other, current], [], {
      INSTAFY_CONVERSATION_ID: current.id,
      CONVERSATION_ID: other.id,
    });

    if (code !== 0) {
      // eslint-disable-next-line no-console
      console.error("stdout:", stdout, "stderr:", stderr);
    }
    expect(code).toBe(0);
    const output = JSON.parse(stdout);
    expect(output.conversation).toMatchObject({ id: current.id, title: "Bookkeeping setup" });
    expect(output.messages.map((message: { content: string }) => message.content)).toEqual([
      "What's next in the setup?",
    ]);
  });

  it("falls back to CONVERSATION_ID and still lets an explicit target win", async () => {
    const projectId = randomUUID();
    const { current, other } = twoConversations();

    const fallback = await showWithEnv(projectId, [other, current], [], {
      INSTAFY_CONVERSATION_ID: "",
      CONVERSATION_ID: current.id,
    });
    expect(fallback.code).toBe(0);
    expect(JSON.parse(fallback.stdout).conversation.id).toBe(current.id);

    const explicit = await showWithEnv(projectId, [other, current], [other.id], {
      INSTAFY_CONVERSATION_ID: current.id,
    });
    expect(explicit.code).toBe(0);
    expect(JSON.parse(explicit.stdout).conversation.id).toBe(other.id);
  });

  it("fails clearly when no target is given and no conversation is in the environment", async () => {
    const projectId = randomUUID();
    const { current, other } = twoConversations();

    const { code, stdout, stderr } = await showWithEnv(projectId, [other, current], [], {
      INSTAFY_CONVERSATION_ID: "",
      CONVERSATION_ID: "",
    });

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain(
      "No conversation given. Pass an id or title, or set INSTAFY_CONVERSATION_ID.",
    );
  });

  it("rejects an environment conversation that is not an id before any request", async () => {
    const projectId = randomUUID();
    const { current, other } = twoConversations();

    // The value goes into /conversations/<id>/messages, so a path or query in it would ask the
    // controller for something else, and a stray word would only come back as a bare 404.
    for (const value of ["../../projects/x", "abc?limit=1&x=", "not-a-uuid"]) {
      for (const [name, env] of [
        ["INSTAFY_CONVERSATION_ID", { INSTAFY_CONVERSATION_ID: value, CONVERSATION_ID: current.id }],
        ["CONVERSATION_ID", { INSTAFY_CONVERSATION_ID: "", CONVERSATION_ID: value }],
      ] as const) {
        const label = `${name}=${value}`;
        const requests: string[] = [];
        const { code, stdout, stderr } = await showWithEnv(
          projectId,
          [other, current],
          [],
          env,
          requests,
        );

        expect(code, label).toBe(1);
        expect(stdout, label).toBe("");
        expect(stderr, label).toContain(`${name} is not a conversation id.`);
        expect(requests, label).toEqual([]);
      }
    }

    // A named conversation never reads the environment, so a bad value there does not matter.
    const explicit = await showWithEnv(projectId, [other, current], ["Fruit planning"], {
      INSTAFY_CONVERSATION_ID: "../../projects/x",
    });
    expect(explicit.code).toBe(0);
    expect(JSON.parse(explicit.stdout).conversation.id).toBe(other.id);
  });

  it("rejects an explicit empty target instead of showing the current conversation", async () => {
    const projectId = randomUUID();
    const { current, other } = twoConversations();

    // `instafy conversation show "$ID"` after a search that found nothing passes an empty
    // word. Answering with the current conversation would pass it off as the other chat.
    for (const target of ["", "   "]) {
      const { code, stdout, stderr } = await showWithEnv(projectId, [other, current], [target], {
        INSTAFY_CONVERSATION_ID: current.id,
      });

      expect(code, JSON.stringify(target)).toBe(1);
      expect(stdout, JSON.stringify(target)).toBe("");
      expect(stderr, JSON.stringify(target)).toContain("Conversation target cannot be empty.");
    }
  });
});
