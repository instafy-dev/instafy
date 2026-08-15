import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

type MockAutomation = Record<string, unknown> & {
  id: string;
  name: string;
};

function automationPayload(overrides: Record<string, unknown> = {}): MockAutomation {
  return {
    id: randomUUID(),
    name: "Dependency check",
    scheduleKind: "hourly",
    runAt: null,
    intervalHours: 24,
    byDay: [],
    byHour: null,
    byMinute: null,
    timezone: "UTC",
    runtimeMode: "auto",
    runtimeProvider: null,
    status: "active",
    nextRunAt: "2026-08-16T09:00:00Z",
    lastRunAt: null,
    lastError: null,
    ...overrides,
  };
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function startMockController(token: string, initialAutomations: MockAutomation[] = []) {
  const projectId = randomUUID();
  const state = {
    automations: [...initialAutomations],
    createBodies: [] as Record<string, unknown>[],
  };

  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "invalid token" }));
      return;
    }

    const collectionPath = `/projects/${projectId}/automations`;
    if (req.method === "GET" && req.url === collectionPath) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(state.automations));
      return;
    }

    if (req.method === "POST" && req.url === collectionPath) {
      const body = await readJsonBody(req);
      state.createBodies.push(body);
      const created = automationPayload({
        name: typeof body.name === "string" ? body.name : "Created automation",
        scheduleKind: body.scheduleKind,
        intervalHours: body.intervalHours,
        timezone: body.timezone,
        runtimeMode: body.runtimeMode,
        silentWhenNothingToReport: body.silentWhenNothingToReport,
        status: body.status,
      });
      state.automations.push(created);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(created));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "not found" }));
  });

  server.listen(0);
  return { server, projectId, state };
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function execCli(args: string[]) {
  const packageRoot = new URL("../", import.meta.url).pathname;
  const entry = path.join(packageRoot, "dist", "index.js");
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-home-"));
  try {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: packageRoot,
      env: {
        ...process.env,
        HOME: tmpHome,
        USERPROFILE: tmpHome,
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
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

function controllerArgs(projectId: string, controllerUrl: string, token: string): string[] {
  return [
    "--space",
    projectId,
    "--server-url",
    controllerUrl,
    "--access-token",
    token,
  ];
}

describe("automations cli", () => {
  it("sends true for the quiet flag and explicit false when the flag is omitted", async () => {
    const token = "controller-token";
    const { server, projectId, state } = startMockController(token);
    await once(server, "listening");

    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const controllerUrl = `http://127.0.0.1:${port}`;
      const sharedArgs = controllerArgs(projectId, controllerUrl, token);

      const quiet = await execCli([
        "automations",
        "create",
        "--name",
        "Quiet dependency check",
        "--prompt",
        "Report dependency changes.",
        "--schedule-kind",
        "hourly",
        "--interval-hours",
        "24",
        "--timezone",
        "UTC",
        "--silent-when-nothing-to-report",
        ...sharedArgs,
        "--json",
      ]);
      const ordinary = await execCli([
        "automations",
        "create",
        "--name",
        "Ordinary dependency check",
        "--prompt",
        "Report dependency changes.",
        "--schedule-kind",
        "hourly",
        "--interval-hours",
        "24",
        "--timezone",
        "UTC",
        ...sharedArgs,
        "--json",
      ]);

      expect(quiet.code).toBe(0);
      expect(ordinary.code).toBe(0);
      expect(state.createBodies.map((body) => body.silentWhenNothingToReport)).toEqual([
        true,
        false,
      ]);
      expect(JSON.parse(quiet.stdout).silentWhenNothingToReport).toBe(true);
      expect(JSON.parse(ordinary.stdout).silentWhenNothingToReport).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it("normalizes legacy list rows to false and marks findings-only rows for humans", async () => {
    const token = "controller-token";
    const { server, projectId } = startMockController(token, [
      automationPayload({
        name: "Quiet findings check",
        silentWhenNothingToReport: true,
      }),
      automationPayload({ name: "Legacy always-report check" }),
    ]);
    await once(server, "listening");

    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const controllerUrl = `http://127.0.0.1:${port}`;
      const sharedArgs = controllerArgs(projectId, controllerUrl, token);

      const jsonList = await execCli([
        "automations",
        "list",
        ...sharedArgs,
        "--json",
      ]);
      const humanList = await execCli(["automations", "list", ...sharedArgs]);

      expect(jsonList.code).toBe(0);
      expect(humanList.code).toBe(0);
      const records = JSON.parse(jsonList.stdout) as Array<Record<string, unknown>>;
      expect(records.map((record) => record.silentWhenNothingToReport)).toEqual([
        true,
        false,
      ]);
      expect(humanList.stdout).toContain("Quiet findings check");
      expect(humanList.stdout).toContain("Legacy always-report check");
      expect(humanList.stdout.match(/findings only/g)).toHaveLength(1);
    } finally {
      await closeServer(server);
    }
  });
});
