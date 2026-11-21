import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A runtime record whose pid names no single process (a failed spawn's -1, 0, anything but a positive
// integer) is stale. `process.kill` reads 0 as the caller's process group and -1 as every process the
// user may signal, so these run `runtime status`, `runtime stop` and `runtime start` with process.kill
// replaced by a stand-in that only records its calls: nothing here can signal anything, whatever the
// code under test does.

type Kill = [pid: unknown, signal: unknown];

describe("a runtime record whose pid names no single process", () => {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  let home = "";
  let kills: Kill[] = [];
  let printed: string[] = [];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-stale-pid-"));
    // The CLI keeps the runtime's state under HOME, which it reads as it loads.
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    kills = [];
    printed = [];
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      kills.push([pid, signal]);
      // Node's own check, which lets "-1" through as -1.
      // eslint-disable-next-line eqeqeq
      if (pid != (pid | 0)) {
        throw Object.assign(new TypeError("The \"pid\" argument must be of type number"), {
          code: "ERR_INVALID_ARG_TYPE",
        });
      }
      // Answers as the real one would for a group that exists, without sending anything.
      if (Number(pid) <= 0) return true;
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    }) as typeof process.kill);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    fs.rmSync(home, { recursive: true, force: true });
    vi.resetModules();
  });

  async function withRecord(pid: unknown) {
    vi.resetModules();
    const runtime = await import("../src/runtime.js");
    const stateFile = path.join(home, ".instafy", "cli-runtime-state.json");
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        runner: "process",
        pid,
        projectId: randomUUID(),
        workspace: home,
        startedAt: new Date().toISOString(),
      }),
    );
    // process.kill is the stand-in from here on.
    expect(() => process.kill(2147483647, 0)).toThrow("ESRCH");
    expect(kills).toEqual([[2147483647, 0]]);
    kills = [];
    return { runtime, stateFile };
  }

  it.each([-1, 0, "-1", 1.5, null])(
    "with pid %s reads as not running, and `runtime stop` clears it without signalling",
    async (pid) => {
      const { runtime, stateFile } = await withRecord(pid);

      await runtime.runtimeStatus({ json: true });
      expect(JSON.parse(printed.pop() ?? "null")).toMatchObject({ running: false });
      expect(fs.existsSync(stateFile)).toBe(true);

      await runtime.runtimeStop({ json: true });
      expect(JSON.parse(printed.pop() ?? "null")).toEqual({ stopped: false, reason: "not_running" });
      expect(fs.existsSync(stateFile)).toBe(false);

      expect(kills).toEqual([]);
    },
    20_000,
  );

  it.each([-1, 0])("with pid %s does not keep `runtime start` from starting", async (pid) => {
    const { runtime } = await withRecord(pid);
    // With no sign-in, a start that gets past the record stops at the next check.
    await expect(runtime.runtimeStart({ project: randomUUID() })).rejects.toThrow(/Login required/);
    expect(kills).toEqual([]);
  });
});
