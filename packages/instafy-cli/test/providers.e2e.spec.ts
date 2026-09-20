import { once } from "node:events";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

type CapturedRequest = {
  method: string;
  url: string;
  body: string;
};

function startMockProviderHost(handler: (req: CapturedRequest) => { status: number; body: unknown }) {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const response = handler({
      method: req.method ?? "",
      url: req.url ?? "",
      body: Buffer.concat(chunks).toString("utf8"),
    });
    res.writeHead(response.status, { "content-type": "application/json" });
    res.end(JSON.stringify(response.body));
  });
  server.listen(0);
  return server;
}

async function execCli(args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) {
  const packageRoot = new URL("../", import.meta.url).pathname;
  const entry = path.join(packageRoot, "bin", "instafy.js");
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

describe("providers command", () => {
  it("lists and discovers providers through the shared provider host client", async () => {
    const captured: CapturedRequest[] = [];
    const server = startMockProviderHost((req) => {
      captured.push(req);

      if (req.method === "GET" && req.url === "/providers") {
        return {
          status: 200,
          body: {
            ok: true,
            providers: [
              {
                id: "demo",
                title: "Demo",
                capabilityIds: ["robot_embodiment"],
                discoverable: true,
              },
            ],
          },
        };
      }

      if (req.method === "GET" && req.url === "/providers/demo/discover") {
        return {
          status: 200,
          body: {
            ok: true,
            providerId: "demo",
            provider: {
              id: "demo",
              transport_probe_supported: true,
              resources: [{ uri: "demo://robot/status-summary" }],
            },
          },
        };
      }

      return { status: 404, body: { ok: false, error: "not_found" } };
    });

    await once(server, "listening");
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    const listResult = await execCli(["providers", "list", "--provider-host-url", baseUrl, "--json"]);
    const discoverResult = await execCli([
      "providers",
      "discover",
      "demo",
      "--provider-host-url",
      baseUrl,
      "--json",
    ]);

    server.close();

    expect(listResult.code).toBe(0);
    expect(JSON.parse(listResult.stdout)).toMatchObject({
      providerHostUrl: baseUrl,
      providers: [{ id: "demo" }],
    });

    expect(discoverResult.code).toBe(0);
    expect(JSON.parse(discoverResult.stdout)).toMatchObject({
      providerHostUrl: baseUrl,
      providerId: "demo",
      provider: {
        id: "demo",
      },
    });
    expect(captured.map((request) => request.url)).toEqual([
      "/providers",
      "/providers/demo/discover",
    ]);
  });

  it("reads resources and probes transport through the shared provider host client", async () => {
    const captured: CapturedRequest[] = [];
    const server = startMockProviderHost((req) => {
      captured.push(req);

      if (
        req.method === "POST" &&
        req.url === "/providers/demo/resources/read" &&
        JSON.parse(req.body).uri === "demo://robot/status-summary"
      ) {
        return {
          status: 200,
          body: {
            ok: true,
            uri: "demo://robot/status-summary",
            value: {
              connection: "ready",
            },
          },
        };
      }

      if (req.method === "POST" && req.url === "/providers/demo/transport/probe") {
        return {
          status: 200,
          body: {
            ok: true,
            connected: true,
            backend: "virtual_tcp",
          },
        };
      }

      return { status: 404, body: { ok: false, error: "not_found" } };
    });

    await once(server, "listening");
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    const readResult = await execCli([
      "providers",
      "read",
      "demo",
      "demo://robot/status-summary",
      "--provider-host-url",
      baseUrl,
      "--json",
    ]);
    const probeResult = await execCli([
      "providers",
      "probe",
      "demo",
      "--provider-host-url",
      baseUrl,
      "--backend",
      "virtual_tcp",
      "--json",
    ]);

    server.close();

    expect(readResult.code).toBe(0);
    expect(JSON.parse(readResult.stdout)).toMatchObject({
      providerHostUrl: baseUrl,
      uri: "demo://robot/status-summary",
      value: {
        connection: "ready",
      },
    });

    expect(probeResult.code).toBe(0);
    expect(JSON.parse(probeResult.stdout)).toMatchObject({
      providerHostUrl: baseUrl,
      providerId: "demo",
      value: {
        connected: true,
        backend: "virtual_tcp",
      },
    });
    expect(captured[0]).toMatchObject({
      method: "POST",
      url: "/providers/demo/resources/read",
    });
    expect(JSON.parse(captured[0]?.body ?? "{}")).toEqual({
      uri: "demo://robot/status-summary",
    });
    expect(captured[1]?.body).toContain("\"backend\":\"virtual_tcp\"");
  });
});
