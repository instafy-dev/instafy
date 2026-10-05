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
    resultVisibility: "private",
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
    automations: [...initialAutomations] as MockAutomation[],
    createBodies: [] as Record<string, unknown>[],
    updateBodies: [] as Array<{ automationId: string; body: Record<string, unknown> }>,
    requests: [] as Array<{ method: string | undefined; url: string | undefined; authorization: string | undefined }>,
  };

  const server = http.createServer(async (req, res) => {
    state.requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
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
        mode: body.mode ?? "prompt",
        scheduleKind: body.scheduleKind,
        intervalHours: body.intervalHours,
        timezone: body.timezone,
        runtimeMode: body.runtimeMode,
        silentWhenNothingToReport: body.silentWhenNothingToReport,
        resultVisibility: body.resultVisibility ?? "private",
        status: body.status,
      });
      state.automations.push(created);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(created));
      return;
    }

    const updateMatch = /^\/automations\/([^/]+)$/.exec(req.url ?? "");
    if (req.method === "PATCH" && updateMatch) {
      const automationId = updateMatch[1];
      const body = await readJsonBody(req);
      state.updateBodies.push({ automationId, body });
      const existing = state.automations.find((item) => item.id === automationId);
      if (!existing) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "automation not found" }));
        return;
      }
      if (Object.keys(body).length === 0) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "at least one automation field must be provided" }));
        return;
      }
      Object.assign(existing, body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(existing));
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

async function execCli(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const packageRoot = new URL("../", import.meta.url).pathname;
  const entry = path.join(packageRoot, "bin", "instafy.js");
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-home-"));
  try {
    const env = { ...process.env };
    for (const key of ["INSTAFY_ACCESS_TOKEN", "SUPABASE_ACCESS_TOKEN", "CONTROLLER_ACCESS_TOKEN", "CONTROLLER_BASE_URL", "RUNTIME_ACCESS_TOKEN", "RUNTIME_ID", "RUNTIME_LEASE_ID", "INSTAFY_CONVERSATION_ID", "CONVERSATION_ID", "SPACE_ID", "INSTAFY_SPACE_ID", "PROJECT_ID", "INSTAFY_PROJECT_ID", "INSTAFY_PROFILE", "INSTAFY_SERVER_URL", "INSTAFY_CLI_CONFIG", "INSTAFY_CLIENT_TIMEZONE", "TZ"]) delete env[key];
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: packageRoot,
      env: {
        ...env,
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        ...extraEnv,
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
  return ["--space", projectId, ...automationArgs(controllerUrl, token)];
}

function automationArgs(controllerUrl: string, token: string): string[] {
  return ["--server-url", controllerUrl, "--access-token", token];
}

describe("automations cli", () => {
  it.each([
    { clientTimezone: undefined, flags: [] },
    { clientTimezone: "   ", flags: [] },
    { clientTimezone: "Europe/Vienna", flags: ["--timezone", "   "] },
  ])("rejects an unresolved or explicitly blank runtime timezone before creating a schedule: %j", async ({ clientTimezone, flags }) => {
    const { server, projectId, state } = startMockController("scoped-job-token");
    await once(server, "listening");
    try {
      const address = server.address() as { port: number };
      const result = await execCli(["automations", "create", "--name", "Reminder", "--prompt", "Remind me to revisit the draft", "--schedule-kind", "once", "--run-at", "2099-10-05T22:00:00", ...flags, "--json"], {
        RUNTIME_ID: randomUUID(), INSTAFY_CONVERSATION_ID: randomUUID(),
        CONTROLLER_ACCESS_TOKEN: "scoped-job-token", CONTROLLER_BASE_URL: `http://127.0.0.1:${address.port}`,
        SPACE_ID: projectId, INSTAFY_CLIENT_TIMEZONE: clientTimezone, TZ: "Pacific/Auckland",
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("--timezone");
      expect(state.requests).toEqual([]);
    } finally { await closeServer(server); }
  });

  it.each([
    { clientTimezone: "Europe/Vienna", explicit: undefined, expected: "Europe/Vienna" },
    { clientTimezone: "UTC", explicit: undefined, expected: "UTC" },
    { clientTimezone: undefined, explicit: "UTC", expected: "UTC" },
    { clientTimezone: "Europe/Vienna", explicit: "Asia/Tokyo", expected: "Asia/Tokyo" },
  ])("creates runtime automations using the explicit or trusted client timezone: %j", async ({ clientTimezone, explicit, expected }) => {
    const { server, projectId, state } = startMockController("scoped-job-token");
    await once(server, "listening");
    try {
      const address = server.address() as { port: number };
      const result = await execCli(["automations", "create", "--name", "Reminder", "--prompt", "Remind me to revisit the draft", "--schedule-kind", "once", "--run-at", "2099-10-05T22:00:00", ...(explicit ? ["--timezone", explicit] : []), "--json"], {
        RUNTIME_ID: randomUUID(), INSTAFY_CONVERSATION_ID: randomUUID(),
        CONTROLLER_ACCESS_TOKEN: "scoped-job-token", CONTROLLER_BASE_URL: `http://127.0.0.1:${address.port}`,
        SPACE_ID: projectId, INSTAFY_CLIENT_TIMEZONE: clientTimezone, TZ: "Pacific/Auckland",
      });
      expect(result.code, result.stderr).toBe(0);
      expect(state.createBodies[0].timezone).toBe(expected);
      expect(JSON.parse(result.stdout).timezone).toBe(expected);
    } finally { await closeServer(server); }
  });

  it("preserves human CLI local timezone defaults", async () => {
    const { server, projectId, state } = startMockController("human-token");
    await once(server, "listening");
    try {
      const address = server.address() as { port: number };
      const result = await execCli(["automations", "create", "--name", "Reminder", "--prompt", "Remind me to revisit the draft", "--schedule-kind", "once", "--run-at", "2099-10-05T22:00:00", "--json", ...controllerArgs(projectId, `http://127.0.0.1:${address.port}`, "human-token")], { TZ: "Pacific/Auckland" });
      expect(result.code, result.stderr).toBe(0);
      expect(state.createBodies[0].timezone).toBe("Pacific/Auckland");
    } finally { await closeServer(server); }
  });

  it("preserves an existing automation timezone when a runtime cadence update omits it", async () => {
    const automation = automationPayload({ timezone: "Europe/Vienna" });
    const { server, projectId, state } = startMockController("scoped-job-token", [automation]);
    await once(server, "listening");
    try {
      const address = server.address() as { port: number };
      const result = await execCli(["automations", "update", automation.id, "--interval-hours", "48", "--json"], {
        RUNTIME_ID: randomUUID(), INSTAFY_CONVERSATION_ID: randomUUID(),
        CONTROLLER_ACCESS_TOKEN: "scoped-job-token", CONTROLLER_BASE_URL: `http://127.0.0.1:${address.port}`,
        SPACE_ID: projectId, TZ: "Pacific/Auckland",
      });
      expect(result.code, result.stderr).toBe(0);
      expect(state.updateBodies).toEqual([{ automationId: automation.id, body: { intervalHours: 48 } }]);
      expect(JSON.parse(result.stdout).timezone).toBe("Europe/Vienna");
    } finally { await closeServer(server); }
  });

  it("lists, changes cadence and pauses with only the active runtime job credential", async () => {
    const token = "scoped-job-token";
    const automation = automationPayload({ mode: "space_review" });
    const { server, projectId, state } = startMockController(token, [automation]);
    await once(server, "listening");
    try {
      const address = server.address() as { port: number };
      const env = {
        RUNTIME_ID: randomUUID(), INSTAFY_CONVERSATION_ID: randomUUID(),
        CONTROLLER_ACCESS_TOKEN: token, CONTROLLER_BASE_URL: `http://127.0.0.1:${address.port}`,
        SPACE_ID: projectId,
      };
      const listed = await execCli(["automations", "list", "--json"], env);
      expect(listed.code, listed.stderr).toBe(0);
      expect(JSON.parse(listed.stdout)[0].id).toBe(automation.id);
      const updated = await execCli(["automations", "update", automation.id, "--schedule-kind", "weekly", "--days", "fr", "--time", "10:00", "--timezone", "Europe/Vienna", "--json"], env);
      expect(updated.code, updated.stderr).toBe(0);
      expect(JSON.parse(updated.stdout)).toMatchObject({ id: automation.id, scheduleKind: "weekly", byDay: ["fr"], byHour: 10, timezone: "Europe/Vienna" });
      const paused = await execCli(["automations", "pause", automation.id, "--json"], env);
      expect(paused.code, paused.stderr).toBe(0);
      expect(JSON.parse(paused.stdout).status).toBe("paused");
      expect(state.updateBodies).toEqual([
        { automationId: automation.id, body: { scheduleKind: "weekly", byDay: ["fr"], byHour: 10, byMinute: 0, timezone: "Europe/Vienna" } },
        { automationId: automation.id, body: { status: "paused" } },
      ]);
      expect(state.requests.map((request) => request.authorization)).toEqual(Array(3).fill(`Bearer ${token}`));
    } finally { await closeServer(server); }
  });

  it("refuses to send a scoped job credential to another controller origin", async () => {
    const { server, projectId, state } = startMockController("scoped-job-token");
    await once(server, "listening");
    try {
      const address = server.address() as { port: number };
      const result = await execCli(["automations", "list", "--space", projectId, "--server-url", `http://127.0.0.1:${address.port}`, "--json"], {
        RUNTIME_ID: randomUUID(), CONVERSATION_ID: randomUUID(),
        CONTROLLER_ACCESS_TOKEN: "scoped-job-token", CONTROLLER_BASE_URL: "http://127.0.0.1:1",
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("controller origin other than CONTROLLER_BASE_URL");
      expect(state.requests).toEqual([]);
    } finally { await closeServer(server); }
  });

  it("does not replace a missing job credential with a human session token", async () => {
    const { server, projectId, state } = startMockController("human-token");
    await once(server, "listening");
    try {
      const address = server.address() as { port: number };
      const result = await execCli(["automations", "list", "--space", projectId, "--json"], {
        RUNTIME_ID: randomUUID(), INSTAFY_CONVERSATION_ID: randomUUID(),
        CONTROLLER_BASE_URL: `http://127.0.0.1:${address.port}`, INSTAFY_ACCESS_TOKEN: "human-token",
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("CONTROLLER_ACCESS_TOKEN");
      expect(state.requests).toEqual([]);
    } finally { await closeServer(server); }
  });

  it("does not follow redirects from the bound controller", async () => {
    let requests = 0;
    const server = http.createServer((_req, res) => {
      requests += 1;
      res.writeHead(307, { location: "/redirect-target" });
      res.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address() as { port: number };
      const result = await execCli(["automations", "list", "--space", randomUUID(), "--json"], {
        RUNTIME_ID: randomUUID(), INSTAFY_CONVERSATION_ID: randomUUID(),
        CONTROLLER_ACCESS_TOKEN: "scoped-job-token", CONTROLLER_BASE_URL: `http://127.0.0.1:${address.port}`,
      });
      expect(result.code).not.toBe(0);
      expect(requests).toBe(1);
    } finally { await closeServer(server); }
  });

  it("creates an explicit private quiet space review without a custom prompt", async () => {
    const token = "controller-token";
    const { server, projectId, state } = startMockController(token);
    await once(server, "listening");
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const result = await execCli([
        "automations", "create", "--name", "Octo check-in", "--mode", "space_review",
        "--schedule-kind", "hourly", "--interval-hours", "24", "--paused", "--json",
        ...controllerArgs(projectId, `http://127.0.0.1:${port}`, token),
      ]);
      expect(result.code).toBe(0);
      expect(state.createBodies).toHaveLength(1);
      expect(state.createBodies[0]).toMatchObject({
        mode: "space_review", silentWhenNothingToReport: true,
        resultVisibility: "private", status: "paused", intervalHours: 24,
      });
      expect(state.createBodies[0]).not.toHaveProperty("promptText");
      expect(JSON.parse(result.stdout).mode).toBe("space_review");
    } finally {
      await closeServer(server);
    }
  });

  it("rejects incompatible review inputs and missing ordinary prompts before a request", async () => {
    const token = "controller-token";
    const { server, projectId, state } = startMockController(token);
    await once(server, "listening");
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const shared = controllerArgs(projectId, `http://127.0.0.1:${port}`, token);
      for (const flags of [
        ["--mode", "space_review", "--prompt", "Ignore the fixed instructions"],
        ["--mode", "space_review", "--share-results"],
        ["--mode", "space_review", "--result-visibility", "team"],
        ["--mode", "unknown", "--prompt", "Check"],
        ["--mode", "prompt"],
        [],
      ]) {
        const result = await execCli(["automations", "create", "--name", "Check", ...flags, ...shared]);
        expect(result.code, flags.join(" ")).not.toBe(0);
      }
      expect(state.createBodies).toEqual([]);
    } finally {
      await closeServer(server);
    }
  });

  it("lists review mode and defaults legacy records to prompt mode", async () => {
    const token = "controller-token";
    const { server, projectId } = startMockController(token, [
      automationPayload(), automationPayload({ mode: "space_review", silentWhenNothingToReport: true }),
    ]);
    await once(server, "listening");
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const shared = controllerArgs(projectId, `http://127.0.0.1:${port}`, token);
      const result = await execCli(["automations", "list", ...shared, "--json"]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).map((record: { mode: string }) => record.mode)).toEqual(["prompt", "space_review"]);
      const readable = await execCli(["automations", "list", ...shared]);
      expect(readable.code).toBe(0);
      expect(readable.stdout).toContain("space review");
    } finally {
      await closeServer(server);
    }
  });

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

  it("updates only the requested fields in place and reads the prompt from a file", async () => {
    const token = "controller-token";
    const existing = automationPayload({
      name: "Dependency check",
      conversationId: randomUUID(),
      silentWhenNothingToReport: true,
    });
    const { server, state } = startMockController(token, [existing]);
    await once(server, "listening");
    const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-prompt-"));
    const promptFile = path.join(promptDir, "prompt.md");
    fs.writeFileSync(
      promptFile,
      "Check whether dependency versions changed.\n\nReport licence changes too.\n",
      "utf8",
    );

    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const controllerUrl = `http://127.0.0.1:${port}`;
      const sharedArgs = automationArgs(controllerUrl, token);

      const promptUpdate = await execCli([
        "automations",
        "update",
        existing.id,
        "--prompt-file",
        promptFile,
        "--silent-when-nothing-to-report",
        ...sharedArgs,
        "--json",
      ]);
      const scheduleUpdate = await execCli([
        "automations",
        "update",
        existing.id,
        "--name",
        "Weekly dependency check",
        "--schedule-kind",
        "weekly",
        "--days",
        "mo,we",
        "--time",
        "07:30",
        "--timezone",
        "Europe/Vienna",
        "--runtime-mode",
        "existing",
        "--no-silent-when-nothing-to-report",
        ...sharedArgs,
      ]);

      expect(promptUpdate.code).toBe(0);
      expect(scheduleUpdate.code).toBe(0);
      expect(state.updateBodies.map((entry) => entry.automationId)).toEqual([
        existing.id,
        existing.id,
      ]);
      expect(state.updateBodies[0]?.body).toEqual({
        promptText: "Check whether dependency versions changed.\n\nReport licence changes too.",
        silentWhenNothingToReport: true,
      });
      expect(state.updateBodies[1]?.body).toEqual({
        name: "Weekly dependency check",
        scheduleKind: "weekly",
        byDay: ["mo", "we"],
        byHour: 7,
        byMinute: 30,
        timezone: "Europe/Vienna",
        runtimeMode: "existing",
        silentWhenNothingToReport: false,
      });
      const promptPayload = JSON.parse(promptUpdate.stdout) as Record<string, unknown>;
      expect(promptPayload.id).toBe(existing.id);
      expect(promptPayload.conversationId).toBe(existing.conversationId);
      expect(scheduleUpdate.stdout).toContain("Weekly dependency check");
      expect(scheduleUpdate.stdout).toContain(existing.id);
    } finally {
      fs.rmSync(promptDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  it("refuses an update without any field before contacting the controller", async () => {
    const token = "controller-token";
    const existing = automationPayload({ name: "Dependency check" });
    const { server, state } = startMockController(token, [existing]);
    await once(server, "listening");

    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const controllerUrl = `http://127.0.0.1:${port}`;
      const sharedArgs = automationArgs(controllerUrl, token);

      const noFields = await execCli(["automations", "update", existing.id, ...sharedArgs]);
      const bothPrompts = await execCli([
        "automations",
        "update",
        existing.id,
        "--prompt",
        "inline",
        "--prompt-file",
        "prompt.md",
        ...sharedArgs,
      ]);

      expect(noFields.code).toBe(1);
      expect(noFields.stderr).toContain("Nothing to update");
      expect(noFields.stderr).toContain("--prompt-file");
      expect(bothPrompts.code).toBe(1);
      expect(bothPrompts.stderr).toContain("either --prompt or --prompt-file");
      expect(state.updateBodies).toEqual([]);
    } finally {
      await closeServer(server);
    }
  });

  it("shares results with the team on create and omits the field by default", async () => {
    const token = "controller-token";
    const { server, projectId, state } = startMockController(token);
    await once(server, "listening");

    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const controllerUrl = `http://127.0.0.1:${port}`;
      const sharedArgs = controllerArgs(projectId, controllerUrl, token);

      const shared = await execCli([
        "automations",
        "create",
        "--name",
        "Team dependency check",
        "--prompt",
        "Report dependency changes.",
        "--schedule-kind",
        "hourly",
        "--interval-hours",
        "24",
        "--timezone",
        "UTC",
        "--share-results",
        ...sharedArgs,
        "--json",
      ]);
      const privateDefault = await execCli([
        "automations",
        "create",
        "--name",
        "Private dependency check",
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

      expect(shared.code).toBe(0);
      expect(privateDefault.code).toBe(0);
      expect(state.createBodies.map((body) => body.resultVisibility)).toEqual([
        "team",
        undefined,
      ]);
      expect(JSON.parse(shared.stdout).resultVisibility).toBe("team");
      expect(JSON.parse(privateDefault.stdout).resultVisibility).toBe("private");
    } finally {
      await closeServer(server);
    }
  });

  it("flips result visibility on update and reflects it in list output", async () => {
    const token = "controller-token";
    const existing = automationPayload({
      name: "Shared nightly check",
      resultVisibility: "team",
    });
    const { server, projectId, state } = startMockController(token, [existing]);
    await once(server, "listening");

    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const controllerUrl = `http://127.0.0.1:${port}`;
      const sharedArgs = controllerArgs(projectId, controllerUrl, token);
      // `automations update` targets an automation by id (like pause/resume/run/delete)
      // and does not take --space.
      const idArgs = ["--server-url", controllerUrl, "--access-token", token];

      const teamJsonList = await execCli(["automations", "list", ...sharedArgs, "--json"]);
      expect(teamJsonList.code).toBe(0);
      const teamRecords = JSON.parse(teamJsonList.stdout) as Array<Record<string, unknown>>;
      expect(teamRecords[0]?.resultVisibility).toBe("team");

      const humanTeamList = await execCli(["automations", "list", ...sharedArgs]);
      expect(humanTeamList.stdout).toContain("team-visible");

      const updated = await execCli([
        "automations",
        "update",
        String(existing.id),
        "--result-visibility",
        "private",
        ...idArgs,
        "--json",
      ]);

      expect(updated.code).toBe(0);
      expect(state.updateBodies).toEqual([
        { automationId: String(existing.id), body: { resultVisibility: "private" } },
      ]);
      expect(JSON.parse(updated.stdout).resultVisibility).toBe("private");

      const humanPrivateList = await execCli(["automations", "list", ...sharedArgs]);
      expect(humanPrivateList.stdout).not.toContain("team-visible");
    } finally {
      await closeServer(server);
    }
  });
});
