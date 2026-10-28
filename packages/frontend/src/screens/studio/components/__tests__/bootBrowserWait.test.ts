import { describe, expect, it, vi } from "vitest";
import {
  BOOT_BROWSER_RESTARTING_CODE,
  BOOT_BROWSER_STOPPED_CODE,
  bootBrowserProbeFromError,
  waitForBootBrowserRunning,
  type BootBrowserProbe,
} from "../bootBrowserWait";

function clock() {
  let nowMs = 0;
  return {
    now: () => nowMs,
    sleep: vi.fn(async (ms: number) => {
      nowMs += ms;
      return true;
    }),
  };
}

function probes(...answers: BootBrowserProbe[]) {
  return vi.fn(async () => answers.shift() ?? "running");
}

describe("waitForBootBrowserRunning", () => {
  it("connects at once when its browser runs, or when the origin says nothing", async () => {
    for (const first of ["running", "unknown"] as const) {
      const time = clock();
      const probe = probes(first);
      const onRestarting = vi.fn();
      await expect(waitForBootBrowserRunning({ probe, onRestarting, ...time })).resolves.toEqual({ kind: "connect" });
      expect(probe).toHaveBeenCalledTimes(1);
      expect(time.sleep).not.toHaveBeenCalled();
      expect(onRestarting).not.toHaveBeenCalled();
    }
  });

  it("says once that it restarts, and reads every two seconds until it runs", async () => {
    const time = clock();
    const probe = probes("restarting", "restarting", "restarting", "running");
    const onRestarting = vi.fn();
    await expect(waitForBootBrowserRunning({ probe, onRestarting, ...time })).resolves.toEqual({ kind: "connect" });
    expect(probe).toHaveBeenCalledTimes(4);
    expect(onRestarting).toHaveBeenCalledTimes(1);
    expect(time.sleep.mock.calls.map(([ms]) => ms)).toEqual([2_000, 2_000, 2_000]);
  });

  it("ends when the machine gave up, or when the wait runs out", async () => {
    await expect(waitForBootBrowserRunning({ probe: probes("restarting", "stopped"), ...clock() }))
      .resolves.toEqual({ kind: "stopped" });
    const forever = vi.fn(async (): Promise<BootBrowserProbe> => "restarting");
    await expect(waitForBootBrowserRunning({ probe: forever, timeoutMs: 10_000, ...clock() }))
      .resolves.toEqual({ kind: "timeout" });
    expect(forever).toHaveBeenCalledTimes(6);
  });

  it("stops when it is cancelled, and a read that fails counts as saying nothing", async () => {
    const controller = new AbortController();
    const probe = vi.fn(async (): Promise<BootBrowserProbe> => {
      controller.abort();
      return "restarting";
    });
    await expect(waitForBootBrowserRunning({ probe, signal: controller.signal, ...clock() }))
      .resolves.toEqual({ kind: "cancelled" });
    const failing = vi.fn(async (): Promise<BootBrowserProbe> => {
      throw new Error("network");
    });
    await expect(waitForBootBrowserRunning({ probe: failing, ...clock() })).resolves.toEqual({ kind: "connect" });
  });
});

describe("bootBrowserProbeFromError", () => {
  const unavailable = (code: string | null) => Object.assign(new Error("503"), { code });
  const isUnavailable = (error: unknown) => error instanceof Error && error.message === "503";
  it("reads only the origin's two codes", () => {
    expect(bootBrowserProbeFromError(unavailable(BOOT_BROWSER_RESTARTING_CODE), isUnavailable)).toBe("restarting");
    expect(bootBrowserProbeFromError(unavailable(BOOT_BROWSER_STOPPED_CODE), isUnavailable)).toBe("stopped");
    expect(bootBrowserProbeFromError(unavailable("browser_host_not_ready"), isUnavailable)).toBe("unknown");
    expect(bootBrowserProbeFromError(unavailable(null), isUnavailable)).toBe("unknown");
    // A code on any other error is not the origin's answer.
    expect(bootBrowserProbeFromError(Object.assign(new Error("x"), { code: BOOT_BROWSER_STOPPED_CODE }), isUnavailable))
      .toBe("unknown");
  });
});
