import { once } from "node:events";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

type OtaReleaseRegistrationInput = {
  release_id: string;
  platform: "ios" | "android";
  channel: string;
  bundle_version: string;
  git_sha: string;
  native_version: string;
  min_supported_native_version: string;
  artifact_url: string;
  artifact_sha256: string;
  artifact_size_bytes: number;
  artifact_type: "zip";
  signature?: string | null;
  rollout_percentage: number;
  status: "draft" | "live" | "paused" | "rolled_back" | "archived";
  published_at?: string;
  published_by: string;
  notes?: string | null;
};

type OtaChannelAssignment = {
  platform: "ios" | "android";
  channel: string;
  active_release_id: string;
  previous_release_id?: string | null;
  rollout_percentage: number;
  activated_at: string;
  activated_by: string;
};

type DesktopPromotionRecord = {
  request_id: string;
  source_channel: "internal" | "stable";
  target_channel: "internal" | "stable";
  workflow_ref: string;
  requested_at: string;
  requested_by: string;
  status: "dispatched";
  notes?: string | null;
};

type CapturedRequest = {
  method: string;
  url: string;
  auth: string | null;
  body: unknown;
};

function startMockController(
  handler: (req: CapturedRequest) => { status: number; body: unknown },
) {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const body = rawBody.trim().length ? JSON.parse(rawBody) : null;
    const response = handler({
      method: req.method ?? "",
      url: req.url ?? "",
      auth: req.headers["authorization"] ?? null,
      body,
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

describe("ota commands", () => {
  it("registers an OTA release from a payload file", async () => {
    const payload: OtaReleaseRegistrationInput = {
      release_id: "ios-beta-2026-03-19T120000Z-deadbeef",
      platform: "ios",
      channel: "beta",
      bundle_version: "2026.03.19-deadbeef",
      git_sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      native_version: "1.0.0",
      min_supported_native_version: "1.0.0",
      artifact_url: "https://downloads.instafy.dev/mobile/test.zip",
      artifact_sha256: "abc123",
      artifact_size_bytes: 12345,
      artifact_type: "zip",
      signature: "signature",
      rollout_percentage: 40,
      status: "draft",
      published_at: "2026-03-19T12:00:00.000Z",
      published_by: "github-actions",
      notes: "test release",
    };

    const captured: CapturedRequest[] = [];
    const server = startMockController((req) => {
      captured.push(req);
      return { status: 200, body: req.body };
    });
    await once(server, "listening");
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-ota-"));
    const payloadPath = path.join(tmpDir, "release.json");
    fs.writeFileSync(payloadPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    const result = await execCli([
      "ota",
      "releases",
      "register",
      "--file",
      payloadPath,
      "--controller-url",
      `http://127.0.0.1:${port}`,
      "--service-token",
      "service-token",
      "--json",
    ]);

    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject(payload);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.method).toBe("POST");
    expect(captured[0]?.url).toBe("/ota/releases");
    expect(captured[0]?.auth).toBe("Bearer service-token");
    expect(captured[0]?.body).toMatchObject(payload);
  });

  it("activates an OTA channel via the controller API", async () => {
    const captured: CapturedRequest[] = [];
    const assignment: OtaChannelAssignment = {
      platform: "ios",
      channel: "beta",
      active_release_id: "ios-beta-2026-03-19T120000Z-deadbeef",
      previous_release_id: "ios-beta-2026-03-18T110000Z-cafebabe",
      rollout_percentage: 25,
      activated_at: "2026-03-19T12:01:00.000Z",
      activated_by: "github-actions",
    };
    const server = startMockController((req) => {
      captured.push(req);
      return { status: 200, body: assignment };
    });
    await once(server, "listening");
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const result = await execCli([
      "ota",
      "channels",
      "activate",
      "--platform",
      "ios",
      "--channel",
      "beta",
      "--release-id",
      assignment.active_release_id,
      "--rollout-percentage",
      "25",
      "--activated-by",
      "github-actions",
      "--controller-url",
      `http://127.0.0.1:${port}`,
      "--service-token",
      "service-token",
      "--json",
    ]);

    server.close();

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject(assignment);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.method).toBe("POST");
    expect(captured[0]?.url).toBe("/ota/channels/ios/beta/activate");
    expect(captured[0]?.auth).toBe("Bearer service-token");
    expect(captured[0]?.body).toEqual({
      release_id: assignment.active_release_id,
      rollout_percentage: 25,
      activated_by: "github-actions",
    });
  });

  it("requests a desktop promotion via the controller API", async () => {
    const requestId = randomUUID();
    const captured: CapturedRequest[] = [];
    const record: DesktopPromotionRecord = {
      request_id: requestId,
      source_channel: "stable",
      target_channel: "internal",
      workflow_ref: "main",
      requested_at: "2026-03-19T12:02:00.000Z",
      requested_by: "github-actions",
      status: "dispatched",
      notes: "copy stable release for diagnostics",
    };
    const server = startMockController((req) => {
      captured.push(req);
      return { status: 200, body: record };
    });
    await once(server, "listening");
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const result = await execCli([
      "desktop-updates",
      "promotions",
      "request",
      "--source-channel",
      "stable",
      "--target-channel",
      "internal",
      "--requested-by",
      "github-actions",
      "--notes",
      "copy stable release for diagnostics",
      "--controller-url",
      `http://127.0.0.1:${port}`,
      "--service-token",
      "service-token",
      "--json",
    ]);

    server.close();

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject(record);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.method).toBe("POST");
    expect(captured[0]?.url).toBe("/desktop-updates/promotions");
    expect(captured[0]?.auth).toBe("Bearer service-token");
    expect(captured[0]?.body).toEqual({
      source_channel: "stable",
      target_channel: "internal",
      requested_by: "github-actions",
      notes: "copy stable release for diagnostics",
    });
  });
});
