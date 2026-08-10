import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliBin = path.resolve(__dirname, "..", "bin", "instafy.js");

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("@instafy/cli login callback", () => {
  it("accepts a browser callback and stores the token without copy/paste", async () => {
    const homeDir = makeTempDir("instafy-cli-home-");
    const gitConfigGlobal = path.join(homeDir, "gitconfig");
    const env = {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      GIT_CONFIG_GLOBAL: gitConfigGlobal,
      INSTAFY_ACCESS_TOKEN: "",
      SUPABASE_ACCESS_TOKEN: "",
      CONTROLLER_ACCESS_TOKEN: "",
      INSTAFY_SERVICE_TOKEN: "",
    };

    const child = spawn(process.execPath, [cliBin, "login", "--wait-for-browser", "--studio-url", "http://localhost:5173", "--server-url", "http://127.0.0.1:8788", "--no-git-setup"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    const loginUrl = await new Promise<URL>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`timed out waiting for login URL (stdout=${stdoutChunks.join("")}, stderr=${stderrChunks.join("")})`));
      }, 5000);

      const onData = () => {
        const stdout = stdoutChunks.join("");
        const match = stdout.match(/https?:\/\/\S+/);
        if (!match) {
          return;
        }
        try {
          const parsed = new URL(match[0]);
          if (parsed.pathname.endsWith("/cli/login")) {
            clearTimeout(timeout);
            child.stdout.off("data", onData);
            resolve(parsed);
          }
        } catch {
          // keep waiting for a valid URL
        }
      };

      child.stdout.on("data", onData);
    });

    const callbackUrl = loginUrl.searchParams.get("cliCallbackUrl");
    const state = loginUrl.searchParams.get("cliState");
    expect(callbackUrl).toMatch(/^http:\/\/(127\.0\.0\.1|localhost)/);
    expect(state).toBeTruthy();

    const callbackResponse = await fetch(callbackUrl!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "test-token", state }),
    });
    expect(callbackResponse.ok).toBe(true);

    const exitCode = await new Promise<number>((resolve) => {
      child.on("close", (code) => resolve(code ?? -1));
    });
    expect(exitCode).toBe(0);

    const configPath = path.join(homeDir, ".instafy", "config.json");
    const configRaw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(configRaw) as { accessToken?: string };
    expect(parsed.accessToken).toBe("test-token");
  });
});
