import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyProtectedDesktopRuntimeEnv,
  buildRuntimeTokenRequestBody,
  normalizeDesktopRuntimeLaunchGrants,
  resolveDesktopRuntimeLocalEngine,
  startDesktopRuntime,
  type DesktopRuntimeLaunchGrant,
} from "./index.js";

// The launcher applies launch grants without knowing what they are for, so
// these fixtures use neutral names.
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const RUNTIME_ID = "22222222-2222-4222-8222-222222222222";
const ENGINE_BIN = "INSTAFY_FIXTURE_ENGINE_BIN";
const ENGINE_USER = "INSTAFY_FIXTURE_ENGINE_USER_ID";
const NOTHING_GRANTED: DesktopRuntimeLaunchGrant = {
  protectedEnvKeys: [ENGINE_BIN, ENGINE_USER],
};
const GRANTED: DesktopRuntimeLaunchGrant = {
  protectedEnvKeys: [ENGINE_BIN, ENGINE_USER],
  env: { [ENGINE_BIN]: "/granted/engine", [ENGINE_USER]: "granted-user" },
  localEngine: "fixture-engine",
};

describe("launch grants in the runtime environment", () => {
  it("strips every declared key from a start that was granted nothing", () => {
    const env: NodeJS.ProcessEnv = {
      [ENGINE_BIN]: "/inherited/engine",
      [ENGINE_USER]: "inherited-user",
      SAFE_VALUE: "kept",
    };

    applyProtectedDesktopRuntimeEnv(env, {
      projectId: PROJECT_ID,
      launchGrants: [NOTHING_GRANTED],
    });

    expect(env).not.toHaveProperty(ENGINE_BIN);
    expect(env).not.toHaveProperty(ENGINE_USER);
    expect(env.SAFE_VALUE).toBe("kept");
  });

  it("sets declared keys only from the grant", () => {
    const env: NodeJS.ProcessEnv = {
      [ENGINE_BIN]: "/inherited/engine",
      [ENGINE_USER]: "inherited-user",
    };

    applyProtectedDesktopRuntimeEnv(env, {
      projectId: PROJECT_ID,
      launchGrants: [
        {
          protectedEnvKeys: [ENGINE_BIN, ENGINE_USER],
          env: { [ENGINE_BIN]: "/granted/engine" },
        },
      ],
    });

    expect(env[ENGINE_BIN]).toBe("/granted/engine");
    // Declared but not granted: removed, never inherited.
    expect(env).not.toHaveProperty(ENGINE_USER);
  });

  it("refuses grants for keys the launcher owns, keys outside Instafy's namespace and undeclared keys", () => {
    for (const key of [
      "RUNTIME_ID",
      "PATH",
      "CONTROLLER_ACCESS_TOKEN",
      "INSTAFY_RUNTIME_AGENT_BIN",
      "INSTAFY_RUNTIME_PARENT_DISPOSITION",
      "INSTAFY_PERSONAL_BROWSER_CONTROL_TOKEN",
      "instafy_lowercase",
    ]) {
      expect(() =>
        normalizeDesktopRuntimeLaunchGrants([{ protectedEnvKeys: [key] }]),
      ).toThrow(/cannot set/);
    }
    expect(() =>
      normalizeDesktopRuntimeLaunchGrants([
        { protectedEnvKeys: [ENGINE_BIN] },
        { protectedEnvKeys: [ENGINE_BIN] },
      ]),
    ).toThrow(/more than once/);
    expect(() =>
      normalizeDesktopRuntimeLaunchGrants([
        { protectedEnvKeys: [ENGINE_BIN], env: { [ENGINE_USER]: "x" } },
      ]),
    ).toThrow(/does not declare/);
    expect(() =>
      normalizeDesktopRuntimeLaunchGrants([
        { protectedEnvKeys: [ENGINE_BIN], env: { [ENGINE_BIN]: "a\0b" } },
      ]),
    ).toThrow(/not a string/);
    expect(() =>
      normalizeDesktopRuntimeLaunchGrants([
        { protectedEnvKeys: [ENGINE_BIN], localEngine: "Not An Engine" },
      ]),
    ).toThrow(/localEngine/);
    expect(() =>
      applyProtectedDesktopRuntimeEnv({}, {
        projectId: PROJECT_ID,
        launchGrants: [{ protectedEnvKeys: ["RUNTIME_ACCESS_TOKEN"] }],
      }),
    ).toThrow(/cannot set/);
  });

  it("names a local engine in the token request only when values were granted", () => {
    expect(buildRuntimeTokenRequestBody("Instafy Desktop", RUNTIME_ID)).not.toHaveProperty(
      "localEngine",
    );
    expect(
      buildRuntimeTokenRequestBody("Instafy Desktop", RUNTIME_ID, false, "fixture-engine"),
    ).toEqual({
      subject: "Instafy Desktop",
      runtimeId: RUNTIME_ID,
      leaseId: null,
      scopes: null,
      localEngine: "fixture-engine",
    });

    expect(resolveDesktopRuntimeLocalEngine(undefined)).toBeUndefined();
    expect(
      resolveDesktopRuntimeLocalEngine([{ ...NOTHING_GRANTED, localEngine: "fixture-engine" }]),
    ).toBeUndefined();
    expect(resolveDesktopRuntimeLocalEngine([GRANTED])).toBe("fixture-engine");
    expect(() =>
      resolveDesktopRuntimeLocalEngine([
        GRANTED,
        {
          protectedEnvKeys: ["INSTAFY_FIXTURE_OTHER"],
          env: { INSTAFY_FIXTURE_OTHER: "1" },
          localEngine: "other-engine",
        },
      ]),
    ).toThrow(/more than one local engine/);
  });
});

function fakeRuntimeToken(runtimeId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ runtime_id: runtimeId })}.fixture`;
}

async function startFakeController(): Promise<{
  url: string;
  requests: string[];
  tokenRequests: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}> {
  const requests: string[] = [];
  const tokenRequests: Array<Record<string, unknown>> = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (request.method === "POST" && request.url === `/projects/${PROJECT_ID}/runtime/token`) {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        tokenRequests.push(JSON.parse(body) as Record<string, unknown>);
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ token: fakeRuntimeToken(RUNTIME_ID), runtimeId: RUNTIME_ID }));
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    tokenRequests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function readEnvDump(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) {
      env[line.slice(0, separator)] = line.slice(separator + 1);
    }
  }
  return env;
}

describe.runIf(process.platform !== "win32")("launch grants on a real start", () => {
  const savedEnv: Record<string, string | undefined> = {};
  let tempDir: string;
  let controller: Awaited<ReturnType<typeof startFakeController>>;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-launch-grants-"));
    controller = await startFakeController();
    // A shell that already holds these must not reach the runtime, and the
    // token must come from the fake controller, not the environment.
    for (const key of [ENGINE_BIN, ENGINE_USER, "ORIGIN_INTERNAL_TOKEN", "ORIGIN_GIT_REMOTE_URL"]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env[ENGINE_BIN] = "/inherited/engine";
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await controller.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function startRecordingRuntime(launchGrants: DesktopRuntimeLaunchGrant[]) {
    const envDump = path.join(tempDir, "runtime-env.txt");
    const runtimeBinary = path.join(tempDir, "fake-runtime-agent");
    fs.writeFileSync(runtimeBinary, `#!/bin/sh\n/usr/bin/env > '${envDump}'\n`, { mode: 0o755 });
    const handle = await startDesktopRuntime({
      projectId: PROJECT_ID,
      controllerUrl: controller.url,
      controllerAccessToken: "person-session-token",
      runtimeBinaryPath: runtimeBinary,
      workspaceDir: path.join(tempDir, "workspace"),
      displayName: "Launch grant fixture",
      env: { [ENGINE_USER]: "from-the-env-bag" },
      origin: { ratholeBin: runtimeBinary, ratholeStateDir: path.join(tempDir, "rathole") },
      logging: { logFilePath: path.join(tempDir, "runtime.log"), teeToStdout: false },
      launchGrants,
    });
    await handle.exited;
    return readEnvDump(envDump);
  }

  it("strips declared keys from the inherited environment and options.env when nothing is granted", async () => {
    const env = await startRecordingRuntime([NOTHING_GRANTED]);

    expect(env).not.toHaveProperty(ENGINE_BIN);
    expect(env).not.toHaveProperty(ENGINE_USER);
    expect(env.RUNTIME_ID).toBe(RUNTIME_ID);
    expect(controller.tokenRequests).toHaveLength(1);
    expect(controller.tokenRequests[0]).not.toHaveProperty("localEngine");
  });

  it("sets declared keys only from the grant and asks the controller for its local engine", async () => {
    const env = await startRecordingRuntime([GRANTED]);

    expect(env[ENGINE_BIN]).toBe("/granted/engine");
    expect(env[ENGINE_USER]).toBe("granted-user");
    expect(controller.tokenRequests).toHaveLength(1);
    expect(controller.tokenRequests[0]).toMatchObject({
      subject: "Launch grant fixture",
      localEngine: "fixture-engine",
    });
  });

  it("refuses a malformed grant before contacting the controller", async () => {
    await expect(
      startRecordingRuntime([{ protectedEnvKeys: ["PATH"], env: { PATH: "/tmp" } }]),
    ).rejects.toThrow(/cannot set/);
    expect(controller.requests).toEqual([]);
  });
});
