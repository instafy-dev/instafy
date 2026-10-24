import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliBin = path.resolve(__dirname, "..", "bin", "instafy.js");

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function runCli(args: string[], options: { env: NodeJS.ProcessEnv; input?: string }) {
  const child = spawn(process.execPath, [cliBin, ...args], {
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  if (options.input) {
    child.stdin.end(options.input);
  } else {
    child.stdin.end();
  }
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { code, stdout, stderr };
}

describe("instafy git credential helper", () => {
  it("mints a token and returns username/password for Git", async () => {
    const projectId = randomUUID();
    let capturedAuth = "";
    let capturedBody = "";

    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        capturedAuth = String(req.headers.authorization ?? "");
        capturedBody = body;
        if (req.method === "POST" && req.url === `/projects/${projectId}/git/access_token`) {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              projectId,
              token: "git-token-123",
              expiresIn: 60,
              scopes: ["git.read", "git.write"],
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end();
      });
    });
    server.listen(0);
    const addr = server.address();
    if (!addr || typeof addr !== "object") throw new Error("failed to bind test server");

    const homeDir = makeTempDir("instafy-cli-home-");
    const env = {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      INSTAFY_SERVER_URL: `http://127.0.0.1:${addr.port}`,
      INSTAFY_ACCESS_TOKEN: "user-access-token",
      SUPABASE_ACCESS_TOKEN: "",
      CONTROLLER_ACCESS_TOKEN: "",
    };

    const input = `protocol=https\nhost=git.instafy.dev\npath=${projectId}.git\n\n`;
    const result = await runCli(["git", "credential", "get"], { env, input });

    server.close();

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("username=instafy");
    expect(result.stdout).toContain("password=git-token-123");
    expect(result.stderr).toBe("");
    expect(capturedAuth).toBe("Bearer user-access-token");

    const parsed = JSON.parse(capturedBody || "{}") as { scopes?: string[] };
    expect(parsed.scopes).toEqual(["git.read", "git.write"]);
  });

  it("does not leak tokens to non-Instafy hosts (even if repo name looks like a project UUID)", async () => {
    const projectId = randomUUID();
    let sawRequest = false;

    const server = http.createServer((_req, res) => {
      sawRequest = true;
      res.statusCode = 500;
      res.end();
    });
    server.listen(0);
    const addr = server.address();
    if (!addr || typeof addr !== "object") throw new Error("failed to bind test server");

    const homeDir = makeTempDir("instafy-cli-home-");
    const env = {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      INSTAFY_SERVER_URL: `http://127.0.0.1:${addr.port}`,
      INSTAFY_ACCESS_TOKEN: "user-access-token",
      SUPABASE_ACCESS_TOKEN: "",
      CONTROLLER_ACCESS_TOKEN: "",
    };

    const input = `protocol=https\nhost=github.com\npath=${projectId}.git\n\n`;
    const result = await runCli(["git", "credential", "get"], { env, input });

    server.close();

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(sawRequest).toBe(false);
  });
  it("answers only exact git hosts, never other hosts under the same parent domain", async () => {
    const projectId = randomUUID();
    let requests = 0;

    const server = http.createServer((req, res) => {
      requests += 1;
      req.resume();
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ projectId, token: "git-token-123", expiresIn: 60, scopes: ["git.read", "git.write"] }));
    });
    server.listen(0);
    const addr = server.address();
    if (!addr || typeof addr !== "object") throw new Error("failed to bind test server");

    const homeDir = makeTempDir("instafy-cli-home-");
    const env = {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      INSTAFY_SERVER_URL: `http://127.0.0.1:${addr.port}`,
      INSTAFY_ACCESS_TOKEN: "user-access-token",
      SUPABASE_ACCESS_TOKEN: "",
      CONTROLLER_ACCESS_TOKEN: "",
      INSTAFY_GIT_HOSTS: "git.example.test",
      ORIGIN_GIT_REMOTE_URL: `https://remote.example.test/${projectId}.git`,
    };

    try {
      for (const host of [
        "other.instafy.dev",
        "sub.git.instafy.dev",
        "sub.git.example.test",
        "instafy.dev",
        "git-shard.attacker.example",
        "git-shard-1.example.test",
        "git-shardz",
        "git-edge.example.test",
      ]) {
        const result = await runCli(["git", "credential", "get"], {
          env,
          input: `protocol=https\nhost=${host}\npath=${projectId}.git\n\n`,
        });
        expect(result.code, host).toBe(0);
        expect(result.stdout, host).toBe("");
      }
      expect(requests).toBe(0);

      for (const host of ["git.example.test", "remote.example.test", `127.0.0.1:${addr.port}`, "git-shard-0", "git-edge"]) {
        const result = await runCli(["git", "credential", "get"], {
          env,
          input: `protocol=https\nhost=${host}\npath=${projectId}.git\n\n`,
        });
        expect(result.stdout, host).toContain("password=git-token-123");
      }
      expect(requests).toBe(5);
    } finally {
      server.close();
    }
  });
});
