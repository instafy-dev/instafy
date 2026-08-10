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
  it("non-interactive login without credentials fails fast, not after a 10-minute wait", () => {
    // The blocker: this used to block on the browser callback for 10 minutes
    // and then throw a message naming no fix, so an agent's shell timeout
    // killed it with nothing learned.
    const r = run(["login"], "");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Non-interactive session/);
    expect(r.stderr).toMatch(/--token/);
  });

  it("login --token --json performs the login instead of silently printing a URL", () => {
    const r = run(["login", "--token", "faketoken123", "--json", "--no-store"]);
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout.trim());
    expect(payload).toMatchObject({ ok: true, stored: false, method: "token" });
  });

  it("an unknown subcommand errors on stderr with a non-zero exit", () => {
    const r = run(["space", "definitely-not-a-real-subcommand"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/unknown command/);
  });

  it("config list reports the effective controller URL, not just the stored one", () => {
    const r = run(["config", "list", "--json"]);
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout.trim());
    expect(payload).toHaveProperty("effectiveControllerUrl");
    expect(typeof payload.effectiveControllerUrl).toBe("string");
  });
});
