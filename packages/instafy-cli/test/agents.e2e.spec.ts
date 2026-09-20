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
  body: unknown;
};

function startMockController(handler: (req: CapturedRequest) => { status: number; body: unknown }) {
  const captured: CapturedRequest[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const request = {
      method: req.method ?? "",
      url: req.url ?? "",
      auth: typeof req.headers.authorization === "string" ? req.headers.authorization : null,
      body: rawBody ? JSON.parse(rawBody) : null,
    };
    captured.push(request);
    const response = handler(request);
    res.writeHead(response.status, { "content-type": "application/json" });
    res.end(JSON.stringify(response.body));
  });
  server.listen(0);
  return { server, captured };
}

async function execCli(args: string[], opts?: { env?: NodeJS.ProcessEnv }) {
  const packageRoot = new URL("../", import.meta.url).pathname;
  const entry = path.join(packageRoot, "bin", "instafy.js");
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-home-"));
  try {
    const child = spawn("node", [entry, ...args], {
      env: { ...process.env, HOME: tmpHome, ...(opts?.env ?? {}) },
      cwd: packageRoot,
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

describe("agents command", () => {
  it("lists scoped agent context cards with filters", async () => {
    const projectId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    const { server, captured } = startMockController(() => ({
      status: 200,
      body: [
        {
          id: randomUUID(),
          agentId,
          agent: { id: agentId, handle: "octo", displayName: "Octo" },
          scopeKind: "conversation",
          scopeId: conversationId,
          title: "Family note",
          context: "The user said their uncle is named Tom.",
          updatedAt: "2026-04-28T10:00:00.000Z",
        },
      ],
    }));

    await once(server, "listening");
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const result = await execCli([
      "agents",
      "context",
      "list",
      "--space",
      projectId,
      "--agent",
      "@octo",
      "--scope-kind",
      "conversation",
      "--query",
      "uncle",
      "--server-url",
      `http://127.0.0.1:${port}`,
      "--access-token",
      "agent-token",
    ]);

    server.close();

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Agent context");
    expect(result.stdout).toContain("@octo");
    expect(result.stdout).toContain("conversation:");
    expect(result.stdout).toContain("uncle is named Tom");

    expect(captured).toHaveLength(1);
    expect(captured[0].auth).toBe("Bearer agent-token");
    const url = new URL(`http://localhost${captured[0].url}`);
    expect(url.pathname).toBe(`/projects/${projectId}/agent-contexts`);
    expect(url.searchParams.get("agent")).toBe("@octo");
    expect(url.searchParams.get("scopeKind")).toBe("conversation");
    expect(url.searchParams.get("q")).toBe("uncle");
  });

  it("puts a scoped context card using runtime env defaults", async () => {
    const projectId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    const { server, captured } = startMockController((req) => ({
      status: 200,
      body: {
        id: randomUUID(),
        agentId,
        agent: { id: agentId, handle: "octo", displayName: "Octo" },
        scopeKind: "conversation",
        scopeId: (req.body as { scopeId?: string }).scopeId,
        context: (req.body as { context?: string }).context,
        updatedAt: "2026-04-28T10:00:00.000Z",
      },
    }));

    await once(server, "listening");
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const result = await execCli(
      [
        "agents",
        "context",
        "put",
        "--agent",
        "@octo",
        "--server-url",
        `http://127.0.0.1:${port}`,
        "--access-token",
        "agent-token",
        "The user said their uncle is named Tom.",
      ],
      {
        env: {
          SPACE_ID: projectId,
          INSTAFY_CONVERSATION_ID: conversationId,
        },
      },
    );

    server.close();

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Saved");
    expect(result.stdout).toContain("@octo");

    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe("POST");
    expect(captured[0].auth).toBe("Bearer agent-token");
    expect(captured[0].url).toBe(`/projects/${projectId}/agent-contexts`);
    expect(captured[0].body).toMatchObject({
      agent: "@octo",
      scopeKind: "conversation",
      scopeId: conversationId,
      context: "The user said their uncle is named Tom.",
    });
  });

  it("shows live plan-group status per worker lane", async () => {
    const groupId = randomUUID();
    const conversationId = randomUUID();
    const { server, captured } = startMockController(() => ({
      status: 200,
      body: {
        groupId,
        conversationId,
        hasLeadContinuation: false,
        hasEarlyCheckpoint: true,
        allTerminal: false,
        workers: [
          {
            jobId: randomUUID(),
            handle: "codec",
            status: "leased",
            outcome: null,
            summary: null,
            errorMessage: null,
            scopeSummary: "Serialization implementation",
            lastMessage: "Reviewing encoder edge cases.",
            terminal: false,
          },
          {
            jobId: randomUUID(),
            handle: "tests",
            status: "failed",
            outcome: "error",
            summary: "Lane failed before reporting.",
            errorMessage: "runtime exited",
            scopeSummary: "Test coverage",
            lastMessage: null,
            terminal: true,
          },
        ],
      },
    }));

    await once(server, "listening");
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const result = await execCli([
      "agents",
      "status",
      groupId,
      "--server-url",
      `http://127.0.0.1:${port}`,
      "--access-token",
      "agent-token",
    ]);

    server.close();

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Plan group ${groupId}`);
    expect(result.stdout).toContain("hasEarlyCheckpoint: true");
    expect(result.stdout).toContain("@codec");
    expect(result.stdout).toContain("running");
    expect(result.stdout).toContain("@tests");
    expect(result.stdout).toContain("error: runtime exited");

    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe("GET");
    expect(captured[0].auth).toBe("Bearer agent-token");
    expect(captured[0].url).toBe(`/agent/plan-groups/${groupId}/status`);
  });

  it("cancels a plan group with a reason", async () => {
    const groupId = randomUUID();
    const { server, captured } = startMockController(() => ({
      status: 200,
      body: {
        ok: true,
        canceledRunIds: [randomUUID()],
        canceledJobIds: [randomUUID(), randomUUID()],
      },
    }));

    await once(server, "listening");
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const result = await execCli([
      "agents",
      "cancel",
      "--group",
      groupId,
      "--reason",
      "plan invalidated",
      "--server-url",
      `http://127.0.0.1:${port}`,
      "--access-token",
      "agent-token",
    ]);

    server.close();

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Canceled 2 job(s) and 1 run(s)");
    expect(result.stdout).toContain(groupId);

    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe("POST");
    expect(captured[0].auth).toBe("Bearer agent-token");
    expect(captured[0].url).toBe(`/jobs/plan-groups/${groupId}/cancel`);
    expect(captured[0].body).toMatchObject({ reason: "plan invalidated" });
  });

  it("rejects cancel without exactly one of --group or --job", async () => {
    const result = await execCli(["agents", "cancel", "--reason", "noop"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("exactly one of --group <groupId> or --job <jobId>");
  });

  it("explains missing sign-in without leaking controller auth internals", async () => {
    const projectId = randomUUID();
    const { server } = startMockController(() => ({
      status: 401,
      body: { message: "user session required" },
    }));

    await once(server, "listening");
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const result = await execCli([
      "agents",
      "context",
      "list",
      "--space",
      projectId,
      "--agent",
      "@octo",
      "--scope-kind",
      "project",
      "--scope-id",
      projectId,
      "--server-url",
      `http://127.0.0.1:${port}`,
    ]);

    server.close();

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Sign in to Instafy");
    expect(result.stderr).toContain("Run: instafy login");
    expect(result.stderr).toContain("For automation:");
    expect(result.stderr).not.toContain("user session required");
    expect(result.stderr).not.toContain("Server:");
  });
});
