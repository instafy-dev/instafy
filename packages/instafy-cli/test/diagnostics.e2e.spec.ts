import { randomUUID } from "node:crypto";
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
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const homeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "instafy-diagnostics-home-"),
  );
  try {
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
        INSTAFY_SERVER_URL: "",
        CONTROLLER_BASE_URL: "",
        SPACE_ID: "",
        INSTAFY_SPACE_ID: "",
        PROJECT_ID: "",
        INSTAFY_PROJECT_ID: "",
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
  basePath = "",
): Promise<{
  controllerUrl: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const captured: CapturedRequest = {
      method: req.method ?? "",
      url: req.url ?? "",
      authorization:
        typeof req.headers.authorization === "string"
          ? req.headers.authorization
          : null,
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
    throw new Error("Mock diagnostics controller did not bind to a TCP port");
  }
  return {
    controllerUrl: `http://127.0.0.1:${address.port}${basePath}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("agent-facing diagnostics commands", () => {
  it("returns one run result in the stable JSON-only envelope", async () => {
    const runId = randomUUID();
    const conversationId = randomUUID();
    const controller = await startMockController(() => ({
      body: {
        runId,
        conversationId,
        status: "ready",
        result: {
          outcome: "succeeded",
          summary: "Completed the requested change.",
          artifacts: [],
        },
        internalOperatorNote: "must not become part of the public CLI contract",
      },
    }));

    try {
      const result = await execCli([
        "diagnostics",
        "run-result",
        runId,
        "--server-url",
        controller.controllerUrl,
        "--access-token",
        "customer-user-token",
      ]);

      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        schemaVersion: "instafy-diagnostics-v1",
        kind: "run-result",
        runId,
        conversationId,
        status: "ready",
        result: {
          outcome: "succeeded",
          summary: "Completed the requested change.",
          artifacts: [],
        },
      });
      expect(controller.requests).toHaveLength(1);
      expect(controller.requests[0]).toEqual({
        method: "GET",
        url: `/diagnostics/runs/${runId}/result`,
        authorization: "Bearer customer-user-token",
      });
    } finally {
      await controller.close();
    }
  });

  it("normalizes an unavailable run payload without omitting typed fields", async () => {
    const runId = randomUUID();
    const controller = await startMockController(() => ({
      body: { runId, status: "pending" },
    }));

    try {
      const result = await execCli([
        "diagnostics",
        "run-result",
        runId,
        "--server-url",
        controller.controllerUrl,
        "--access-token",
        "customer-user-token",
      ]);

      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        schemaVersion: "instafy-diagnostics-v1",
        kind: "run-result",
        runId,
        conversationId: null,
        status: "pending",
        result: null,
      });
    } finally {
      await controller.close();
    }
  });

  it("loads filtered persisted runtime events for the linked space", async () => {
    const spaceId = randomUUID();
    const runtimeId = randomUUID();
    const since = "2026-08-15T10:00:00.000Z";
    const createdAt = "2026-08-15T10:05:00.000Z";
    const controller = await startMockController(
      () => ({
        body: [
          {
            runtimeId,
            kind: "stopped",
            createdAt,
            data: { reason: "offline", requeued_job_count: 2 },
            internalTrace: "must not become part of the public CLI contract",
          },
        ],
      }),
      "/controller-prefix",
    );
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "instafy-diagnostics-space-"),
    );
    fs.mkdirSync(path.join(workspace, ".instafy"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, ".instafy", "space.json"),
      JSON.stringify({ spaceId }, null, 2),
    );

    try {
      const result = await execCli(
        [
          "diagnostics",
          "runtime-events",
          "--runtime-id",
          runtimeId,
          "--kind",
          "stopped",
          "--since",
          since,
          "--limit",
          "17",
          "--server-url",
          controller.controllerUrl,
          "--access-token",
          "customer-user-token",
        ],
        { cwd: workspace },
      );

      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        schemaVersion: "instafy-diagnostics-v1",
        kind: "runtime-events",
        spaceId,
        events: [
          {
            runtimeId,
            kind: "stopped",
            createdAt,
            data: { reason: "offline", requeued_job_count: 2 },
          },
        ],
      });
      expect(controller.requests).toHaveLength(1);
      const request = controller.requests[0];
      expect(request.method).toBe("GET");
      expect(request.authorization).toBe("Bearer customer-user-token");
      const requestUrl = new URL(request.url, controller.controllerUrl);
      expect(requestUrl.pathname).toBe(
        `/controller-prefix/diagnostics/projects/${spaceId}/runtime-events`,
      );
      expect(requestUrl.searchParams.get("runtimeId")).toBe(runtimeId);
      expect(requestUrl.searchParams.get("kind")).toBe("stopped");
      expect(requestUrl.searchParams.get("since")).toBe(since);
      expect(requestUrl.searchParams.get("limit")).toBe("17");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
      await controller.close();
    }
  });

  it(
    "does not treat a service-token environment variable as customer diagnostics auth",
    async () => {
      const runId = randomUUID();
      const controller = await startMockController(() => ({
        body: { runId, status: "pending" },
      }));

      try {
        const result = await execCli(
          [
            "diagnostics",
            "run-result",
            runId,
            "--server-url",
            controller.controllerUrl,
          ],
          {
            env: {
              INSTAFY_SERVICE_TOKEN: "operator-service-token-must-not-be-used",
              CONTROLLER_TOKEN: "legacy-service-token-must-not-be-used",
            },
          },
        );

        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toMatch(/signed-in|login|access token/i);
        expect(result.stderr).not.toContain(
          "operator-service-token-must-not-be-used",
        );
        expect(result.stderr).not.toContain(
          "legacy-service-token-must-not-be-used",
        );
        expect(controller.requests).toHaveLength(0);
      } finally {
        await controller.close();
      }
    },
  );
});
