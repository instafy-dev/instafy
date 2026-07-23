import { once } from "node:events";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

function startMockController(spaceId: string, orgId: string, orgName: string) {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/orgs") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          org_id: orgId,
          org_slug: "cli-org",
          org_name: orgName,
        }),
      );
      return;
    }
    if (req.method === "POST" && req.url === `/orgs/${orgId}/projects`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          project_id: spaceId,
          org_id: orgId,
          org_name: orgName,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0);
  return { server };
}

async function execCli(args: string[], env?: NodeJS.ProcessEnv) {
  const entry = "dist/index.js";
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

describe("space init", () => {
  it("creates a space via controller and writes manifest", async () => {
    const spaceId = randomUUID();
    const orgId = randomUUID();
    const orgName = "CLI Org";
    const { server } = startMockController(spaceId, orgId, orgName);
    await once(server, "listening");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-space-"));
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const controllerUrl = `http://127.0.0.1:${port}`;

      const { code, stdout, stderr } = await execCli([
        "space",
        "init",
        "--path",
        tmpDir,
        "--controller-url",
        controllerUrl,
        "--access-token",
        "controller-token",
        "--org-name",
        orgName,
      ]);

      if (code !== 0) {
        // eslint-disable-next-line no-console
        console.error("stdout:", stdout, "stderr:", stderr);
      }
      expect(code).toBe(0);

      const manifestPath = path.join(tmpDir, ".instafy", "space.json");
      expect(fs.existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        spaceId: string;
        orgId: string | null;
        orgName: string | null;
        controllerUrl: string;
      };
      expect(manifest.spaceId).toBe(spaceId);
      expect(manifest.orgId).toBe(orgId);
      expect(manifest.orgName).toBe(orgName);
      expect(manifest.controllerUrl).toBe(controllerUrl);
    } finally {
      server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("fails without controller or Supabase token", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-space-"));
    try {
      const { code, stdout, stderr } = await execCli([
        "space",
        "init",
        "--path",
        tmpDir,
      ]);
      expect(code).not.toBe(0);
      const combined = `${stdout}\n${stderr}`;
      expect(
        combined.includes("Not authenticated") ||
          combined.includes("Login required") ||
          combined.includes("instafy login"),
      ).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
