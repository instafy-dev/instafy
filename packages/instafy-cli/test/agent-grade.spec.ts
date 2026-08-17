import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cliBin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "instafy.js");

function run(args: string[], input = "") {
  return spawnSync(process.execPath, [cliBin, ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, HOME: mkdtempSync(path.join(tmpdir(), "instafy-agent-")) },
    timeout: 20_000,
  });
}

describe("agent-grade CLI contract", () => {
  it("non-interactive login without credentials fails fast", () => {
    const result = run(["login"], "");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Non-interactive session/);
    expect(result.stderr).toMatch(/--token/);
  });

  it("login --token --json performs the login", () => {
    const result = run(["login", "--token", "faketoken123", "--json", "--no-store"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      ok: true,
      stored: false,
      method: "token",
    });
  });

  it("rejects an ambiguous JSON browser-wait mode", () => {
    const result = run(["login", "--json", "--wait-for-browser"], "");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/cannot be combined/);
    expect(result.stdout).toBe("");
  });

  it("an unknown subcommand errors on stderr with a non-zero exit", () => {
    const result = run(["space", "definitely-not-a-real-subcommand"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unknown command/);
  });

  it("config list reports the effective controller URL", () => {
    const result = run(["config", "list", "--json"]);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload).toHaveProperty("effectiveControllerUrl");
    expect(typeof payload.effectiveControllerUrl).toBe("string");
  });
});
