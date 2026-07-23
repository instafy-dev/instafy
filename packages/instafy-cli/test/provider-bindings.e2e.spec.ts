import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

async function execCli(args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) {
  const entry = "dist/index.js";
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-home-"));
  try {
    const child = spawn("node", [entry, ...args], {
      env: { ...process.env, HOME: tmpHome, ...(opts?.env ?? {}) },
      cwd: new URL("../", import.meta.url).pathname,
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

describe("provider bindings", () => {
  it("grants, shows, and revokes project-scoped provider bindings", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-provider-bindings-"));
    try {
      fs.mkdirSync(path.join(tmpDir, ".instafy"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".instafy", "space.json"),
        JSON.stringify(
          {
            spaceId: "space-test",
          },
          null,
          2,
        ),
      );

      const grant = await execCli(
        [
          "space",
          "provider-bindings",
          "grant",
          "demo",
          "--path",
          tmpDir,
          "--purpose",
          "Persist learned robot state",
          "--prefix",
          ".instafy/providers/demo/",
          "--capability",
          "project_content_read",
          "--capability",
          "project_content_write",
          "--json",
        ],
        { cwd: tmpDir },
      );

      expect(grant.code).toBe(0);
      expect(JSON.parse(grant.stdout)).toMatchObject({
        providerId: "demo",
        projectId: "space-test",
        grantedCapabilities: ["project_content_read", "project_content_write"],
        grantedPrefix: ".instafy/providers/demo/",
        purpose: "Persist learned robot state",
        status: "bound_read_write",
      });

      const bindingsPath = path.join(tmpDir, ".instafy", "provider-bindings.json");
      expect(fs.existsSync(bindingsPath)).toBe(true);
      const stored = JSON.parse(fs.readFileSync(bindingsPath, "utf8")) as {
        version: number;
        bindings: Record<string, { rootUri: string }>;
      };
      expect(stored.version).toBe(1);
      expect(stored.bindings.demo.rootUri).toBe(`file://${tmpDir}`);

      const show = await execCli(
        [
          "space",
          "provider-bindings",
          "show",
          "demo",
          "--path",
          tmpDir,
          "--json",
        ],
        { cwd: tmpDir },
      );
      expect(show.code).toBe(0);
      expect(JSON.parse(show.stdout)).toMatchObject({
        providerId: "demo",
        projectId: "space-test",
        status: "bound_read_write",
      });

      const revoke = await execCli(
        [
          "space",
          "provider-bindings",
          "revoke",
          "demo",
          "--path",
          tmpDir,
          "--json",
        ],
        { cwd: tmpDir },
      );
      expect(revoke.code).toBe(0);
      expect(JSON.parse(revoke.stdout)).toEqual({
        revoked: true,
        providerId: "demo",
      });

      const finalStore = JSON.parse(fs.readFileSync(bindingsPath, "utf8")) as {
        version: number;
        bindings: Record<string, unknown>;
      };
      expect(finalStore.version).toBe(1);
      expect(finalStore.bindings).toEqual({});
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
