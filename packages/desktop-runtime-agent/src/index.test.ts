import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyProtectedDesktopRuntimeEnv,
  buildPersonalBrowserRuntimeEnv,
  buildRuntimeTokenRequestBody,
  createRetryableDesktopRuntimeStop,
  DESKTOP_PARENT_DISPOSITION_HEARTBEAT_SECONDS,
  DESKTOP_RUNTIME_PARENT_DISPOSITION_ENV,
  desktopRuntimeUsesParentDisposition,
  type DesktopRuntimeChildStopTarget,
  hasProjectWorkspaceContent,
  resolveAuthoritativeRuntimeId,
  resolveWindowsTaskkillPath,
  runDesktopRuntimeExitFinalizer,
  shouldEnableProjectOrigin,
  stopDesktopRuntimeChildWithEscalation,
  waitForProjectWorkspaceContent,
} from "./index.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const RUNTIME_ID = "22222222-2222-4222-8222-222222222222";

describe("hasProjectWorkspaceContent", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-desktop-workspace-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("rejects missing and marker-only workspace folders", () => {
    expect(hasProjectWorkspaceContent(path.join(tempDir, "missing"))).toBe(false);

    fs.mkdirSync(path.join(tempDir, ".instafy"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, ".instafy", "space.json"),
      JSON.stringify({ spaceId: "space-test" }),
    );
    fs.writeFileSync(path.join(tempDir, ".DS_Store"), "");

    expect(hasProjectWorkspaceContent(tempDir)).toBe(false);
  });

  it("accepts folders with project files or directories", () => {
    fs.writeFileSync(path.join(tempDir, "README.md"), "# Demo\n");
    expect(hasProjectWorkspaceContent(tempDir)).toBe(true);

    fs.rmSync(path.join(tempDir, "README.md"));
    fs.mkdirSync(path.join(tempDir, "repos", "demo"), { recursive: true });
    expect(hasProjectWorkspaceContent(tempDir)).toBe(true);
  });

  it("enables origin for existing content or an empty folder that can hydrate from git", () => {
    expect(
      shouldEnableProjectOrigin({
        projectWorkspaceHasContent: true,
        gitRemoteUrl: null,
      }),
    ).toBe(true);
    expect(
      shouldEnableProjectOrigin({
        projectWorkspaceHasContent: false,
        gitRemoteUrl: "http://127.0.0.1:8080/project.git",
      }),
    ).toBe(true);
    expect(
      shouldEnableProjectOrigin({
        projectWorkspaceHasContent: false,
        gitRemoteUrl: null,
      }),
    ).toBe(false);
  });

  it("waits until hydration creates real project content", async () => {
    fs.mkdirSync(path.join(tempDir, ".instafy"), { recursive: true });
    const waitPromise = waitForProjectWorkspaceContent(tempDir, {
      timeoutMs: 1_000,
      intervalMs: 5,
    });

    setTimeout(() => {
      fs.writeFileSync(path.join(tempDir, "README.md"), "# Hydrated\n");
    }, 10);

    await expect(waitPromise).resolves.toBe(true);
  });

  it("times out when only workspace markers exist", async () => {
    fs.mkdirSync(path.join(tempDir, ".instafy"), { recursive: true });

    await expect(
      waitForProjectWorkspaceContent(tempDir, {
        timeoutMs: 10,
        intervalMs: 5,
      }),
    ).resolves.toBe(false);
  });
});

describe("desktop runtime identity and Personal Browser capabilities", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("includes a supplied runtime id in the controller token request", () => {
    expect(buildRuntimeTokenRequestBody("Instafy Desktop", RUNTIME_ID)).toEqual({
      subject: "Instafy Desktop",
      runtimeId: RUNTIME_ID,
      leaseId: null,
      scopes: null,
    });
    expect(buildRuntimeTokenRequestBody("Instafy Desktop").runtimeId).toBeNull();
    expect(buildRuntimeTokenRequestBody("Instafy Desktop")).not.toHaveProperty(
      "personalBrowser",
    );
    expect(
      buildRuntimeTokenRequestBody("Instafy Desktop", RUNTIME_ID, true),
    ).toEqual({
      subject: "Instafy Desktop",
      runtimeId: RUNTIME_ID,
      leaseId: null,
      scopes: null,
      personalBrowser: true,
    });
  });

  it("adopts the controller-signed runtime identity and rejects mismatches", () => {
    expect(resolveAuthoritativeRuntimeId(undefined, RUNTIME_ID)).toBe(RUNTIME_ID);
    expect(resolveAuthoritativeRuntimeId(RUNTIME_ID, RUNTIME_ID)).toBe(RUNTIME_ID);
    expect(resolveAuthoritativeRuntimeId(undefined, undefined)).toBeUndefined();
    expect(() =>
      resolveAuthoritativeRuntimeId(
        RUNTIME_ID,
        "33333333-3333-4333-8333-333333333333",
      ),
    ).toThrow("does not match the requested runtimeId");
  });

  it("bounds runtime shutdown and escalates an unresponsive child", async () => {
    vi.useFakeTimers();
    const signals: NodeJS.Signals[] = [];
    const child = {
      pid: 4242,
      exitCode: null,
      signalCode: null,
      kill(signal: NodeJS.Signals) {
        signals.push(signal);
        return true;
      },
    };
    const neverExits = new Promise<void>(() => undefined);
    const stopping = stopDesktopRuntimeChildWithEscalation(child, neverExits, {
      sigintGraceMs: 10,
      sigtermGraceMs: 10,
      sigkillGraceMs: 10,
    });

    expect(signals).toEqual(["SIGINT"]);
    await vi.advanceTimersByTimeAsync(10);
    expect(signals).toEqual(["SIGINT", "SIGTERM"]);
    await vi.advanceTimersByTimeAsync(10);
    expect(signals).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    const rejection = expect(stopping).rejects.toThrow(
      "Desktop runtime 4242 did not exit after SIGKILL",
    );
    await vi.advanceTimersByTimeAsync(10);
    await rejection;
  });

  it("does not mistake an exit-listener error for process termination", async () => {
    vi.useFakeTimers();
    const signals: NodeJS.Signals[] = [];
    const child = {
      pid: 4343,
      exitCode: null,
      signalCode: null,
      kill(signal: NodeJS.Signals) {
        signals.push(signal);
        return true;
      },
    };

    const stopping = stopDesktopRuntimeChildWithEscalation(
      child,
      Promise.reject(new Error("child process error")),
      { sigintGraceMs: 10, sigtermGraceMs: 10, sigkillGraceMs: 10 },
    );
    expect(signals).toEqual(["SIGINT"]);
    await vi.advanceTimersByTimeAsync(10);
    expect(signals).toEqual(["SIGINT", "SIGTERM"]);
    await vi.advanceTimersByTimeAsync(10);
    expect(signals).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    const rejection = expect(stopping).rejects.toThrow(
      "Desktop runtime 4343 did not exit after SIGKILL",
    );
    await vi.advanceTimersByTimeAsync(10);
    await rejection;
    expect(signals).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
  });

  it("deduplicates an active stop proof but retries after a rejected proof", async () => {
    let attempts = 0;
    let rejectFirst!: (error: Error) => void;
    const stop = createRetryableDesktopRuntimeStop(async () => {
      attempts += 1;
      if (attempts === 1) {
        await new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        });
      }
    });

    const first = stop();
    expect(stop()).toBe(first);
    expect(attempts).toBe(1);
    rejectFirst(new Error("tree probe raced process exit"));
    await expect(first).rejects.toThrow(/tree probe raced/i);

    await expect(stop()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it("finalizes runtime-scoped resources when the child exit promise rejects", async () => {
    const finalizer = vi.fn(async () => undefined);
    await expect(
      runDesktopRuntimeExitFinalizer(
        Promise.reject(new Error("child process error")),
        finalizer,
      ),
    ).resolves.toBeUndefined();
    expect(finalizer).toHaveBeenCalledOnce();
  });

  it("signals the detached Unix process group when stopping the real runtime tree", async () => {
    vi.useFakeTimers();
    const groupSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let groupAlive = true;
    const child: DesktopRuntimeChildStopTarget = {
      pid: 4444,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    };
    const stopping = stopDesktopRuntimeChildWithEscalation(
      child,
      new Promise<void>(() => undefined),
      {
        killProcessTree: true,
        platform: "linux",
        sigintGraceMs: 10,
        isProcessGroupAlive: () => groupAlive,
        signalProcessGroup(pid, signal) {
          groupSignals.push({ pid, signal });
          child.signalCode = signal;
          groupAlive = false;
        },
      },
    );

    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(groupSignals).toEqual([{ pid: 4444, signal: "SIGINT" }]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("uses taskkill tree termination on Windows", async () => {
    const terminatedPids: number[] = [];
    const child: DesktopRuntimeChildStopTarget = {
      pid: 4545,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    };

    await stopDesktopRuntimeChildWithEscalation(
      child,
      new Promise<void>(() => undefined),
      {
        killProcessTree: true,
        platform: "win32",
        terminateWindowsProcessTree: async (pid) => {
          terminatedPids.push(pid);
          child.signalCode = "SIGKILL";
        },
      },
    );

    expect(terminatedPids).toEqual([4545]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("accepts Windows root exit as Job Object process-tree proof", async () => {
    const terminateWindowsProcessTree = vi.fn(async () => undefined);
    const child: DesktopRuntimeChildStopTarget = {
      pid: 4646,
      exitCode: 1,
      signalCode: null,
      kill: vi.fn(() => true),
    };

    await expect(stopDesktopRuntimeChildWithEscalation(child, Promise.resolve(), {
      killProcessTree: true,
      platform: "win32",
      terminateWindowsProcessTree,
    })).resolves.toBeUndefined();
    expect(terminateWindowsProcessTree).not.toHaveBeenCalled();
  });

  it("resolves taskkill from the trusted Windows system directory", () => {
    expect(resolveWindowsTaskkillPath({ SystemRoot: "C:\\Windows" })).toBe(
      "C:\\Windows\\System32\\taskkill.exe",
    );
    expect(resolveWindowsTaskkillPath({ SystemRoot: "relative" })).toBe(
      "C:\\Windows\\System32\\taskkill.exe",
    );
  });

  it.runIf(process.platform !== "win32")(
    "escalates until a real detached runtime's stubborn descendant is gone",
    async () => {
      const parent = spawn(
        process.execPath,
        [
          "-e",
          [
            'const { spawn } = require("node:child_process");',
            'const child = spawn(process.execPath, ["-e", "process.on(\\"SIGINT\\", () => {}); process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });',
            "process.stdout.write(String(child.pid) + '\\n');",
            'process.on("SIGINT", () => process.exit(0));',
            "setInterval(() => {}, 1000);",
          ].join(" "),
        ],
        { detached: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      const chunks: Buffer[] = [];
      parent.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
      await once(parent.stdout!, "data");
      const descendantPid = Number(Buffer.concat(chunks).toString("utf8").trim());
      expect(Number.isSafeInteger(descendantPid) && descendantPid > 0).toBe(true);
      const exited = once(parent, "exit");

      try {
        await stopDesktopRuntimeChildWithEscalation(parent, exited, {
          killProcessTree: true,
          sigintGraceMs: 100,
          sigtermGraceMs: 100,
          sigkillGraceMs: 2_000,
        });
        const deadline = Date.now() + 2_000;
        let descendantAlive = true;
        while (descendantAlive && Date.now() < deadline) {
          try {
            process.kill(descendantPid, 0);
            await new Promise((resolve) => setTimeout(resolve, 20));
          } catch {
            descendantAlive = false;
          }
        }
        expect(descendantAlive).toBe(false);
      } finally {
        if (parent.pid) {
          try {
            process.kill(-parent.pid, "SIGKILL");
          } catch {
            // The process group should already be gone.
          }
        }
      }
    },
    10_000,
  );

  it("builds the project-scoped loopback browser capability without exposing it by default", () => {
    expect(buildPersonalBrowserRuntimeEnv({ projectId: PROJECT_ID })).toEqual({});
    expect(
      buildPersonalBrowserRuntimeEnv({
        projectId: PROJECT_ID,
        personalBrowser: {
          controlUrl: "http://127.0.0.1:43127/",
          token: "short-lived-secret",
          projectId: PROJECT_ID,
        },
      }),
    ).toEqual({
      INSTAFY_PERSONAL_BROWSER_CONTROL_URL: "http://127.0.0.1:43127",
      INSTAFY_PERSONAL_BROWSER_CONTROL_TOKEN: "short-lived-secret",
      INSTAFY_PERSONAL_BROWSER_PROJECT_ID: PROJECT_ID,
    });
  });

  it("rejects non-loopback and cross-project browser capabilities", () => {
    expect(() =>
      buildPersonalBrowserRuntimeEnv({
        projectId: PROJECT_ID,
        personalBrowser: {
          controlUrl: "https://browser.example.com",
          token: "secret",
        },
      }),
    ).toThrow("loopback URL");
    expect(() =>
      buildPersonalBrowserRuntimeEnv({
        projectId: PROJECT_ID,
        personalBrowser: {
          controlUrl: "http://localhost:43127",
          token: "secret",
          projectId: "33333333-3333-4333-8333-333333333333",
        },
      }),
    ).toThrow("must match");
  });

  it("strips inherited protected values when Electron did not grant them", () => {
    const env: NodeJS.ProcessEnv = {
      RUNTIME_ID: "44444444-4444-4444-8444-444444444444",
      INSTAFY_RUNTIME_AGENT_BIN: "/tmp/spoofed-runtime-agent",
      INSTAFY_PERSONAL_BROWSER_CONTROL_URL: "http://127.0.0.1:9999",
      INSTAFY_PERSONAL_BROWSER_CONTROL_TOKEN: "inherited-secret",
      INSTAFY_PERSONAL_BROWSER_PROJECT_ID: PROJECT_ID,
      INSTAFY_RUNTIME_PARENT_DISPOSITION: "0",
      SAFE_VALUE: "kept",
    };

    expect(applyProtectedDesktopRuntimeEnv(env, { projectId: PROJECT_ID })).toEqual({
      SAFE_VALUE: "kept",
    });
  });

  it("keeps CLI runtimes self-dispositioned unless Electron opts into parent ownership", () => {
    expect(desktopRuntimeUsesParentDisposition({})).toBe(false);
    expect(
      desktopRuntimeUsesParentDisposition({
        parentDispositionsRuntimeOnShutdown: true,
      }),
    ).toBe(true);
  });

  it("sets runtime identity and browser capability only from explicit options", () => {
    const env: NodeJS.ProcessEnv = {
      RUNTIME_ID: "44444444-4444-4444-8444-444444444444",
      INSTAFY_PERSONAL_BROWSER_CONTROL_TOKEN: "generic-env-secret",
      RUNTIME_HEARTBEAT_SECONDS: "999",
    };

    applyProtectedDesktopRuntimeEnv(env, {
      projectId: PROJECT_ID,
      runtimeId: RUNTIME_ID,
      runtimeBinaryPath: "/Applications/Instafy.app/runtime-agent",
      parentDispositionsRuntimeOnShutdown: true,
      personalBrowser: {
        controlUrl: "http://[::1]:43127",
        token: "desktop-grant",
      },
    });

    expect(env).toMatchObject({
      RUNTIME_ID,
      INSTAFY_RUNTIME_AGENT_BIN: "/Applications/Instafy.app/runtime-agent",
      INSTAFY_PERSONAL_BROWSER_CONTROL_URL: "http://[::1]:43127",
      INSTAFY_PERSONAL_BROWSER_CONTROL_TOKEN: "desktop-grant",
      INSTAFY_PERSONAL_BROWSER_PROJECT_ID: PROJECT_ID,
      [DESKTOP_RUNTIME_PARENT_DISPOSITION_ENV]: "1",
      RUNTIME_HEARTBEAT_SECONDS: String(
        DESKTOP_PARENT_DISPOSITION_HEARTBEAT_SECONDS,
      ),
    });
  });
});
