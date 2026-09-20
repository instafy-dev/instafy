import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type CapturedRequest = {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
};

type MockResponse = {
  status?: number;
  body?: unknown;
};

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const cliEntry = path.join(packageRoot, "bin", "instafy.js");

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function execCli(
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    setupHome?: (homeDir: string) => void;
  },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-support-home-"));
  try {
    options?.setupHome?.(homeDir);
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd: options?.cwd ?? packageRoot,
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        INSTAFY_ACCESS_TOKEN: "",
        CONTROLLER_ACCESS_TOKEN: "",
        SUPABASE_ACCESS_TOKEN: "",
        INSTAFY_SERVICE_TOKEN: "",
        CONTROLLER_TOKEN: "",
        RUNTIME_ACCESS_TOKEN: "",
        INSTAFY_SERVER_URL: "",
        CONTROLLER_BASE_URL: "",
        ...(options?.env ?? {}),
      },
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
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

async function startMockController(
  handler: (request: CapturedRequest) => MockResponse,
): Promise<{
  controllerUrl: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const captured: CapturedRequest = {
      method: req.method ?? "",
      url: req.url ?? "",
      authorization: typeof req.headers.authorization === "string" ? req.headers.authorization : null,
      body: rawBody.trim() ? JSON.parse(rawBody) : null,
    };
    requests.push(captured);
    const response = handler(captured);
    res.writeHead(response.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(response.body ?? {}));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Mock support controller did not bind to a TCP port");
  }
  return {
    controllerUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("customer support commands", () => {
  it("submits a report through the fail-closed customer support endpoint", async () => {
    const controller = await startMockController(() => ({
      body: {
        id: "report-1",
        createdAt: "2026-08-15T12:00:00.000Z",
        reporterEmail: "must-not-be-printed@example.com",
      },
    }));

    try {
      const result = await execCli([
        "support",
        "report",
        "runtime",
        "lost",
        "connection",
        "--details",
        "The connection closed during sync.",
        "--space",
        "space-1",
        "--runtime-id",
        "runtime-1",
        "--client-request-id",
        "55555555-5555-4555-8555-555555555555",
        "--server-url",
        controller.controllerUrl,
        "--access-token",
        "customer-token",
        "--json",
      ]);

      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        id: "report-1",
        createdAt: "2026-08-15T12:00:00.000Z",
        status: "open",
      });
      expect(result.stdout).not.toContain("must-not-be-printed@example.com");
      expect(result.stderr).toContain("55555555-5555-4555-8555-555555555555");
      expect(controller.requests).toHaveLength(1);
      expect(controller.requests[0]).toMatchObject({
        method: "POST",
        authorization: "Bearer customer-token",
        body: {
          message: "runtime lost connection",
          details: "The connection closed during sync.",
          projectId: "space-1",
          runtimeId: "runtime-1",
          clientRequestId: "55555555-5555-4555-8555-555555555555",
        },
      });
      const requestUrl = new URL(controller.requests[0]?.url ?? "", controller.controllerUrl);
      expect(requestUrl.pathname).toBe("/support/reports");
      expect(controller.requests[0]?.body).not.toHaveProperty("metadata");
      expect(controller.requests[0]?.body).not.toHaveProperty("logs");
      expect(controller.requests[0]?.body).not.toHaveProperty("screenshots");
    } finally {
      await controller.close();
    }
  });

  it("discloses account identity in preview without sending the report", async () => {
    const result = await execCli([
      "support",
      "report",
      "Preview disclosure",
      "--no-linked-space",
      "--preview",
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      upload: false,
      supportAccountIdentityIncluded: true,
      summary: "Preview disclosure",
    });
  });

  it("lists only the public support summary fields", async () => {
    const controller = await startMockController(() => ({
      body: {
        reports: [
          {
            id: "report-2",
            createdAt: "2026-08-15T12:01:00.000Z",
            activityAt: "2026-08-15T12:05:00.000Z",
            updatedAt: "2026-08-15T12:02:00.000Z",
            message: "Build hangs",
            details: "private diagnostic details",
            status: "in_progress",
            priority: "urgent",
            assignee: "internal-user",
            reporterEmail: "customer@example.com",
            userId: "private-user-id",
            projectId: "space-2",
            runtimeId: "runtime-2",
            runId: "run-2",
            conversationId: "conversation-2",
            metadata: { secret: "metadata-secret" },
            logs: [{ message: "log-secret" }],
            screenshotCount: 2,
          },
        ],
        hasMore: true,
        nextCursor: {
          activityAt: "2026-08-15T12:05:00.000Z",
          id: "22222222-2222-4222-8222-222222222222",
        },
      },
    }));

    try {
      const result = await execCli([
        "support",
        "list",
        "--limit",
        "10",
        "--before-activity-at",
        "2026-08-16T00:00:00Z",
        "--before-activity-id",
        "11111111-1111-4111-8111-111111111111",
        "--server-url",
        controller.controllerUrl,
        "--access-token",
        "customer-token",
        "--json",
      ]);

      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        reports: [
          {
            id: "report-2",
            createdAt: "2026-08-15T12:01:00.000Z",
            activityAt: "2026-08-15T12:05:00.000Z",
            updatedAt: "2026-08-15T12:02:00.000Z",
            summary: "Build hangs",
            status: "in_progress",
            projectId: "space-2",
            screenshotCount: 2,
          },
        ],
        hasMore: true,
        nextCursor: {
          activityAt: "2026-08-15T12:05:00.000Z",
          id: "22222222-2222-4222-8222-222222222222",
        },
      });
      expect(result.stdout).not.toContain("private diagnostic details");
      expect(result.stdout).not.toContain("customer@example.com");
      expect(result.stdout).not.toContain("metadata-secret");
      expect(result.stdout).not.toContain("log-secret");
      expect(controller.requests).toHaveLength(1);
      const requestUrl = new URL(controller.requests[0]?.url ?? "", controller.controllerUrl);
      expect(requestUrl.pathname).toBe("/support/reports");
      expect(requestUrl.searchParams.get("limit")).toBe("10");
      expect(requestUrl.searchParams.get("before_activity_at")).toBe(
        "2026-08-16T00:00:00Z",
      );
      expect(requestUrl.searchParams.get("before_activity_id")).toBe(
        "11111111-1111-4111-8111-111111111111",
      );
    } finally {
      await controller.close();
    }
  });

  it("rejects incomplete support pagination cursors before making a request", async () => {
    const controller = await startMockController(() => ({ body: { reports: [] } }));

    try {
      const listResult = await execCli([
        "support",
        "list",
        "--before-activity-at",
        "2026-08-16T00:00:00Z",
        "--server-url",
        controller.controllerUrl,
        "--access-token",
        "customer-token",
      ]);
      expect(listResult.code).not.toBe(0);
      expect(`${listResult.stdout}\n${listResult.stderr}`).toMatch(/must be used together/i);

      const createdListResult = await execCli([
        "support",
        "list",
        "--before-created-at",
        "2026-08-16T00:00:00Z",
        "--server-url",
        controller.controllerUrl,
        "--access-token",
        "customer-token",
      ]);
      expect(createdListResult.code).not.toBe(0);
      expect(`${createdListResult.stdout}\n${createdListResult.stderr}`).toMatch(
        /must be used together/i,
      );

      const messagesResult = await execCli([
        "support",
        "messages",
        "report-3",
        "--before-created-at",
        "2026-02-30T00:00:00Z",
        "--before-message-id",
        "44444444-4444-4444-8444-444444444444",
        "--server-url",
        controller.controllerUrl,
        "--access-token",
        "customer-token",
      ]);
      expect(messagesResult.code).not.toBe(0);
      expect(`${messagesResult.stdout}\n${messagesResult.stderr}`).toMatch(/RFC3339/i);
      expect(controller.requests).toHaveLength(0);
    } finally {
      await controller.close();
    }
  });

  it("continues legacy creation-time report pages with a stable paired cursor", async () => {
    const controller = await startMockController(() => ({
      body: {
        reports: [],
        hasMore: true,
        nextCursor: {
          createdAt: "2026-08-15T12:01:00.000Z",
          id: "22222222-2222-4222-8222-222222222222",
        },
      },
    }));

    try {
      const result = await execCli([
        "support",
        "list",
        "--before-created-at",
        "2026-08-16T00:00:00Z",
        "--before-created-id",
        "11111111-1111-4111-8111-111111111111",
        "--server-url",
        controller.controllerUrl,
        "--access-token",
        "customer-token",
        "--json",
      ]);

      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        reports: [],
        hasMore: true,
        nextCursor: {
          createdAt: "2026-08-15T12:01:00.000Z",
          id: "22222222-2222-4222-8222-222222222222",
        },
      });
      const requestUrl = new URL(controller.requests[0]?.url ?? "", controller.controllerUrl);
      expect(requestUrl.searchParams.get("before_created_at")).toBe(
        "2026-08-16T00:00:00Z",
      );
      expect(requestUrl.searchParams.get("before_created_id")).toBe(
        "11111111-1111-4111-8111-111111111111",
      );
    } finally {
      await controller.close();
    }
  });

  it("shows a report without printing attachment bytes or internal fields", async () => {
    const controller = await startMockController(() => ({
      body: {
        id: "report-3",
        createdAt: "2026-08-15T12:03:00.000Z",
        activityAt: "2026-08-15T12:04:00.000Z",
        updatedAt: "2026-08-15T12:04:00.000Z",
        message: "Preview is blank",
        details: "The preview remains white after reload.",
        status: "open",
        projectId: "space-3",
        runtimeId: null,
        runId: null,
        conversationId: null,
        reporterEmail: "private@example.com",
        userId: "private-user-id",
        metadata: { token: "metadata-secret" },
        logs: [{ message: "log-secret" }],
        screenshots: [
          {
            id: "screenshot-1",
            fileName: "preview.png",
            mediaType: "image/png",
            byteSize: 123,
            dataBase64: "base64-secret",
          },
        ],
      },
    }));

    try {
      const result = await execCli([
        "support",
        "show",
        "report-3",
        "--server-url",
        controller.controllerUrl,
        "--access-token",
        "customer-token",
        "--json",
      ]);

      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        id: "report-3",
        createdAt: "2026-08-15T12:03:00.000Z",
        activityAt: "2026-08-15T12:04:00.000Z",
        updatedAt: "2026-08-15T12:04:00.000Z",
        summary: "Preview is blank",
        status: "open",
        projectId: "space-3",
        screenshotCount: 1,
        details: "The preview remains white after reload.",
        screenshots: [
          {
            id: "screenshot-1",
            fileName: "preview.png",
            mediaType: "image/png",
            byteSize: 123,
          },
        ],
      });
      expect(result.stdout).not.toContain("private@example.com");
      expect(result.stdout).not.toContain("metadata-secret");
      expect(result.stdout).not.toContain("log-secret");
      expect(result.stdout).not.toContain("base64-secret");
      expect(controller.requests).toHaveLength(1);
      const requestUrl = new URL(controller.requests[0]?.url ?? "", controller.controllerUrl);
      expect(requestUrl.pathname).toBe("/support/reports/report-3");
    } finally {
      await controller.close();
    }
  });

  it("lists only customer-visible support messages", async () => {
    const controller = await startMockController(() => ({
      body: {
        messages: [
          {
            id: "message-1",
            authorType: "support",
            body: "We reproduced this and are preparing a fix.",
            createdAt: "2026-08-15T12:05:00.000Z",
            authorUserId: "private-operator-id",
            metadata: { internalConversationId: "private-conversation" },
          },
          {
            id: "message-2",
            authorType: "customer",
            body: "Thank you.",
            createdAt: "2026-08-15T12:06:00.000Z",
          },
        ],
        hasMore: true,
        nextCursor: {
          createdAt: "2026-08-15T12:05:00.000Z",
          id: "33333333-3333-4333-8333-333333333333",
        },
      },
    }));

    try {
      const result = await execCli([
        "support",
        "messages",
        "report-3",
        "--limit",
        "20",
        "--before-created-at",
        "2026-08-16T00:00:00Z",
        "--before-message-id",
        "44444444-4444-4444-8444-444444444444",
        "--server-url",
        controller.controllerUrl,
        "--access-token",
        "customer-token",
        "--json",
      ]);

      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        messages: [
          {
            id: "message-1",
            authorType: "support",
            body: "We reproduced this and are preparing a fix.",
            createdAt: "2026-08-15T12:05:00.000Z",
          },
          {
            id: "message-2",
            authorType: "customer",
            body: "Thank you.",
            createdAt: "2026-08-15T12:06:00.000Z",
          },
        ],
        hasMore: true,
        nextCursor: {
          createdAt: "2026-08-15T12:05:00.000Z",
          id: "33333333-3333-4333-8333-333333333333",
        },
      });
      expect(result.stdout).not.toContain("private-operator-id");
      expect(result.stdout).not.toContain("private-conversation");
      expect(controller.requests).toHaveLength(1);
      const requestUrl = new URL(controller.requests[0]?.url ?? "", controller.controllerUrl);
      expect(requestUrl.pathname).toBe("/support/reports/report-3/messages");
      expect(requestUrl.searchParams.get("limit")).toBe("20");
      expect(requestUrl.searchParams.get("before_created_at")).toBe(
        "2026-08-16T00:00:00Z",
      );
      expect(requestUrl.searchParams.get("before_message_id")).toBe(
        "44444444-4444-4444-8444-444444444444",
      );
      expect(controller.requests[0]).toMatchObject({
        method: "GET",
        authorization: "Bearer customer-token",
      });
    } finally {
      await controller.close();
    }
  });

  it("posts an idempotent customer follow-up without printing internal response fields", async () => {
    const controller = await startMockController(() => ({
      body: {
        message: {
          id: "message-3",
          authorType: "customer",
          body: "The issue also happens in a new space.",
          createdAt: "2026-08-15T12:07:00.000Z",
          authorUserId: "private-customer-id",
        },
      },
    }));

    try {
      const result = await execCli([
        "support",
        "reply",
        "report-3",
        "The",
        "issue",
        "also",
        "happens",
        "in",
        "a",
        "new",
        "space.",
        "--server-url",
        controller.controllerUrl,
        "--access-token",
        "customer-token",
        "--json",
      ]);

      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        message: {
          id: "message-3",
          authorType: "customer",
          body: "The issue also happens in a new space.",
          createdAt: "2026-08-15T12:07:00.000Z",
        },
      });
      expect(result.stdout).not.toContain("private-customer-id");
      const requestId = result.stderr.match(/Support follow-up request id: ([0-9a-f-]{36})/iu)?.[1];
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(controller.requests).toHaveLength(1);
      expect(controller.requests[0]).toMatchObject({
        method: "POST",
        authorization: "Bearer customer-token",
        body: {
          body: "The issue also happens in a new space.",
        },
      });
      expect((controller.requests[0]?.body as Record<string, unknown>)?.clientRequestId).toBe(
        requestId,
      );
      const requestUrl = new URL(controller.requests[0]?.url ?? "", controller.controllerUrl);
      expect(requestUrl.pathname).toBe("/support/reports/report-3/messages");
    } finally {
      await controller.close();
    }
  });

  it("counts Unicode scalar values consistently with the controller", async () => {
    const body = "😀".repeat(4_000);
    const requestId = "11111111-1111-4111-8111-111111111111";
    const controller = await startMockController(() => ({
      body: {
        message: {
          id: "message-unicode",
          authorType: "customer",
          body,
          createdAt: "2026-08-15T12:08:00.000Z",
        },
      },
    }));

    try {
      const result = await execCli([
        "support",
        "reply",
        "report-3",
        body,
        "--client-request-id",
        requestId,
        "--server-url",
        controller.controllerUrl,
        "--access-token",
        "customer-token",
        "--json",
      ]);

      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain(requestId);
      expect(controller.requests[0]?.body).toMatchObject({
        body,
        clientRequestId: requestId,
      });
    } finally {
      await controller.close();
    }
  });

  it("rejects an oversized follow-up before contacting support", async () => {
    const controller = await startMockController(() => ({ body: { message: {} } }));

    try {
      const result = await execCli([
        "support",
        "reply",
        "report-3",
        "x".repeat(4_001),
        "--server-url",
        controller.controllerUrl,
        "--access-token",
        "customer-token",
      ]);

      expect(result.code).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/at most 4000 characters/i);
      expect(controller.requests).toHaveLength(0);
    } finally {
      await controller.close();
    }
  });

  it.each([
    ["service credentials", { INSTAFY_SERVICE_TOKEN: "service-token", CONTROLLER_TOKEN: "service-token" }],
    [
      "runtime and retired controller credentials",
      {
        RUNTIME_ACCESS_TOKEN: "runtime-token",
        CONTROLLER_ACCESS_TOKEN: "retired-controller-token",
      },
    ],
  ])("does not treat %s as a customer identity", async (_label, env) => {
    const controller = await startMockController(() => ({ body: { reports: [] } }));

    try {
      const result = await execCli(
        ["support", "list", "--server-url", controller.controllerUrl, "--json"],
        { env },
      );

      expect(result.code).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/signed-in user|instafy login/i);
      expect(controller.requests).toHaveLength(0);
    } finally {
      await controller.close();
    }
  });

  it("uses a saved human login only with its saved controller origin", async () => {
    const savedController = await startMockController(() => ({ body: { reports: [] } }));
    const otherController = await startMockController(() => ({ body: { reports: [] } }));
    const setupHome = (homeDir: string) => {
      const configDir = path.join(homeDir, ".instafy");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, "config.json"),
        JSON.stringify({
          controllerUrl: savedController.controllerUrl,
          accessToken: "saved-customer-token",
        }),
      );
    };

    try {
      const savedResult = await execCli(["support", "list", "--json"], { setupHome });
      expect(savedResult.code, savedResult.stderr).toBe(0);
      expect(savedController.requests).toHaveLength(1);
      expect(savedController.requests[0]?.authorization).toBe("Bearer saved-customer-token");

      const overrideResult = await execCli(
        ["support", "list", "--server-url", otherController.controllerUrl, "--json"],
        { setupHome },
      );
      expect(overrideResult.code).not.toBe(0);
      expect(`${overrideResult.stdout}\n${overrideResult.stderr}`).toMatch(/saved access token|origin/i);
      expect(otherController.requests).toHaveLength(0);
    } finally {
      await Promise.all([savedController.close(), otherController.close()]);
    }
  });

  it("rejects diagnostic files outside the active workspace before upload", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-support-workspace-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-support-outside-"));
    const detailsPath = path.join(outside, "details.txt");
    fs.writeFileSync(detailsPath, "must not be uploaded");
    const controller = await startMockController(() => ({ body: { id: "unexpected" } }));

    try {
      const result = await execCli(
        [
          "support",
          "report",
          "outside file",
          "--details-file",
          detailsPath,
          "--no-linked-space",
          "--server-url",
          controller.controllerUrl,
          "--access-token",
          "customer-token",
        ],
        { cwd: workspace },
      );
      expect(result.code).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/active Instafy workspace/i);
      expect(controller.requests).toHaveLength(0);
    } finally {
      await controller.close();
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects an intermediate directory symlink that escapes the workspace", async () => {
    if (process.platform === "win32") return;
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-support-workspace-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-support-outside-"));
    const logsPath = path.join(outside, "logs.json");
    fs.writeFileSync(logsPath, JSON.stringify([{ message: "must not be uploaded" }]));
    fs.symlinkSync(outside, path.join(workspace, "linked-logs"), "dir");
    const controller = await startMockController(() => ({ body: { id: "unexpected" } }));

    try {
      const result = await execCli(
        [
          "support",
          "report",
          "symlink escape",
          "--logs-file",
          path.join(workspace, "linked-logs", "logs.json"),
          "--no-linked-space",
          "--server-url",
          controller.controllerUrl,
          "--access-token",
          "customer-token",
        ],
        { cwd: workspace },
      );
      expect(result.code).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/active Instafy workspace/i);
      expect(controller.requests).toHaveLength(0);
    } finally {
      await controller.close();
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("ships support without hosted operator command groups", async () => {
    const rootHelp = await execCli(["--help"]);

    expect(rootHelp.code, rootHelp.stderr).toBe(0);
    expect(rootHelp.stdout).toMatch(/^\s+support\b/m);
    for (const removedCommand of ["ops", "ota", "desktop-updates", "api"]) {
      expect(rootHelp.stdout).not.toMatch(new RegExp(`^\\s+${removedCommand}\\b`, "m"));
      const removed = await execCli([removedCommand]);
      expect(removed.code).not.toBe(0);
      expect(`${removed.stdout}\n${removed.stderr}`).toMatch(/unknown command/i);
    }
  });
});
