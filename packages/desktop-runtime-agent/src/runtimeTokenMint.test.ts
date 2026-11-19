import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { text } from "node:stream/consumers";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startDesktopRuntime } from "./index.js";

// What a start did, in one ordered log: every request the start sent and the
// controller got, the rathole download a first start makes, the spawn of the
// agent, and the first tick after the start read the mint's answer.
const start = vi.hoisted(() => ({
  log: [] as string[],
  ratholeBin: "/downloaded/rathole",
  registrations: [] as unknown[],
  finishDownload: null as (() => void) | null,
}));
// The download ends only when the test ends it, so how long it takes decides
// nothing: whatever the start sends before it ends is in the log before it.
vi.mock("./rathole.js", () => ({
  ensureRatholeBinary: () => {
    start.log.push("rathole download started");
    return new Promise<string>((resolve) => {
      start.finishDownload = () => {
        start.log.push("rathole downloaded");
        resolve(start.ratholeBin);
      };
    });
  },
}));
// The real spawn, logged at the moment the agent starts.
vi.mock("node:child_process", async (importOriginal) => {
  const childProcess = await importOriginal<typeof import("node:child_process")>();
  const { basename } = await import("node:path");
  return {
    ...childProcess,
    spawn: (...args: Parameters<typeof childProcess.spawn>) => {
      start.log.push(`spawned ${basename(args[0])}`);
      return childProcess.spawn(...args);
    },
  };
});

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const RUNTIME_ID = "22222222-2222-4222-8222-222222222222";
const MINT_PATH = `/projects/${PROJECT_ID}/runtime/token`;

function fakeRuntimeToken(runtimeId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ runtime_id: runtimeId })}.fixture`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

describe.runIf(process.platform !== "win32")("the runtime token a Desktop start mints", () => {
  const savedEnv: Record<string, string | undefined> = {};
  let tempDir: string;
  let controller: http.Server;
  let controllerUrl: string;

  beforeEach(async () => {
    start.log.length = 0;
    start.registrations.length = 0;
    start.finishDownload = null;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-runtime-token-mint-"));
    // A first start: no rathole from the environment or on PATH, so it is
    // downloaded, and no runtime token from the environment, so it is minted.
    for (const key of ["PATH", "RATHOLE_BIN", "ORIGIN_INTERNAL_TOKEN", "ORIGIN_GIT_REMOTE_URL"]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    const emptyPath = path.join(tempDir, "empty-path");
    fs.mkdirSync(emptyPath);
    process.env.PATH = emptyPath;

    // Each request is logged as the start sends it, not only as the
    // controller gets it, so a mint sent while the download still runs is
    // logged before the download ends.
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      start.log.push(`requested ${method} ${url.pathname}`);
      return realFetch(input, init);
    });

    // Once the start has read the mint's answer it must reach the spawn
    // without waiting on the event loop, so a tick queued here runs only
    // after the agent is spawned.
    const readJson = Response.prototype.json;
    vi.spyOn(Response.prototype, "json").mockImplementation(async function (this: Response) {
      const body = await readJson.call(this);
      if (new URL(this.url).pathname === MINT_PATH) {
        process.nextTick(() => start.log.push("first tick after the mint was read"));
      }
      return body;
    });

    controller = http.createServer((request, response) => {
      const bearer = request.headers.authorization?.replace(/^Bearer /, "");
      start.log.push(`${request.method} ${request.url}${bearer ? ` as ${bearer}` : ""}`);
      if (request.method === "GET" && request.url === "/healthz") {
        response.writeHead(200, { "content-type": "text/plain" }).end("ok");
        return;
      }
      if (request.method === "POST" && request.url === MINT_PATH) {
        request.resume();
        request.on("end", () => {
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ token: fakeRuntimeToken(RUNTIME_ID), runtimeId: RUNTIME_ID }));
        });
        return;
      }
      if (request.method === "POST" && request.url === "/runtime/register") {
        void text(request).then((body) => {
          start.registrations.push(JSON.parse(body));
          response.writeHead(200, { "content-type": "application/json" }).end("{}");
        });
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => controller.listen(0, "127.0.0.1", resolve));
    controllerUrl = `http://127.0.0.1:${(controller.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await new Promise<void>((resolve) => controller.close(() => resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("is minted after a first start downloads rathole, right before the agent starts with it", async () => {
    // The agent registers with the controller first, as the real one does,
    // with the token it was started with, and reports the rathole it got.
    const agentProgram = path.join(tempDir, "fake-runtime-agent.mjs");
    fs.writeFileSync(
      agentProgram,
      [
        'const response = await fetch(new URL("/runtime/register", process.env.CONTROLLER_BASE_URL), {',
        '  method: "POST",',
        '  headers: { authorization: "Bearer " + process.env.RUNTIME_ACCESS_TOKEN },',
        "  body: JSON.stringify({ ratholeBin: process.env.RATHOLE_BIN }),",
        "});",
        "process.exit(response.ok ? 0 : 1);",
        "",
      ].join("\n"),
    );
    const runtimeBinary = path.join(tempDir, "fake-runtime-agent");
    fs.writeFileSync(
      runtimeBinary,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(agentProgram)}\n`,
      { mode: 0o755 },
    );

    const starting = startDesktopRuntime({
      projectId: PROJECT_ID,
      controllerUrl,
      controllerAccessToken: "person-session-token",
      runtimeBinaryPath: runtimeBinary,
      workspaceDir: path.join(tempDir, "workspace"),
      displayName: "Runtime token fixture",
      origin: { ratholeStateDir: path.join(tempDir, "rathole") },
      logging: { logFilePath: path.join(tempDir, "runtime.log"), teeToStdout: false },
    });
    // Reported by the await below, not as an unhandled rejection meanwhile.
    starting.catch(() => undefined);
    // The download runs until the start has had every chance to send
    // something while it runs: a start that sent the mint first is caught
    // by the log's order, however fast the mint is.
    await vi.waitFor(() => expect(start.log).toContain("rathole download started"));
    for (let turn = 0; turn < 5; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    start.finishDownload?.();
    const handle = await starting;
    const exited = await handle.exited;

    // A person's mint ends with their session, so whatever a start waits on
    // between the mint and the agent's first registration is spent from it.
    // The mint is sent only after the slow rathole download ends. The agent
    // is spawned next, with no request in between, and before the first tick
    // after the start read the mint's answer: nothing between them waited on
    // a timer, a file or the network. Its first registration carries the
    // token the mint returned.
    const minted = fakeRuntimeToken(RUNTIME_ID);
    expect(start.log).toEqual([
      "requested GET /healthz",
      "GET /healthz",
      "rathole download started",
      "rathole downloaded",
      `requested POST ${MINT_PATH}`,
      `POST ${MINT_PATH} as person-session-token`,
      "spawned fake-runtime-agent",
      "first tick after the mint was read",
      `POST /runtime/register as ${minted}`,
    ]);
    expect(start.registrations).toEqual([{ ratholeBin: start.ratholeBin }]);
    expect(exited).toEqual({ code: 0, signal: null });
  });
});
