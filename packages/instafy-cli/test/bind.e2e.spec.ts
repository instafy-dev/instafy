import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliBin = path.resolve(here, "..", "bin", "instafy.js");
const helloSite = path.resolve(here, "..", "..", "instafy-bind", "examples", "hello");

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [cliBin, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: mkdtempSync(path.join(tmpdir(), "instafy-bind-")), INSTAFY_ACCESS_TOKEN: "", ...env },
    timeout: 20_000,
  });
}

describe("instafy bind", () => {
  it("passes its arguments through to instafy-bind", () => {
    const help = run(["bind", "--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("instafy-bind serve <dir|gallery>");

    const doctor = run(["bind", "doctor", helloSite]);
    expect(doctor.status).toBe(0);
    expect(doctor.stdout).toContain("hello: hello -> script handlers/hello.mjs");
  });

  it("returns the binder's exit code", () => {
    const result = run(["bind", "command"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("usage: instafy-bind command");
  });

  it("explains how to find the binder when it is missing", () => {
    const result = run(["bind", "doctor"], { INSTAFY_BIND_BIN: path.join(tmpdir(), "no-such-instafy-bind.mjs") });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("INSTAFY_BIND_BIN");
  });
});
