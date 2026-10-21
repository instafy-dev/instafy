import { describe, expect, it, vi } from "vitest";
import { ControllerApiError } from "../../../../services/runtimeController/core";
import type { ControllerSitePreview } from "../../../../services/runtimeController/previews";
import { PreviewWakeError, WAKE_TIMEOUT_MS, wakeErrorText, wakeUntilLive } from "../sitePreviewWake";

const PREVIEW_ID = "11111111-1111-4111-8111-111111111111";
function record(overrides: Partial<ControllerSitePreview> = {}): ControllerSitePreview {
  return { previewId: PREVIEW_ID, title: "Site", port: 4173, path: "/", runtimeId: "r-1", status: "active",
    health: { listening: true, status: 200 }, messageId: null, createdAt: null,
    restartable: true, wake: { state: "idle", startedAt: null, error: null }, ...overrides };
}
const down = (overrides: Partial<ControllerSitePreview> = {}) => record({ health: { listening: false, status: null }, ...overrides });
const apiError = (status: number) => new ControllerApiError({ status, message: "x", code: null, details: null });

function clock() {
  let now = 0;
  return { now: () => now, sleep: vi.fn(async (ms: number) => { now += ms; }) };
}

describe("wakeUntilLive", () => {
  it("returns at once when the controller says the site already answers", async () => {
    const get = vi.fn();
    await expect(wakeUntilLive({ wake: async () => ({ state: "live" }), get, ...clock() })).resolves.toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("follows the preview until the wake is done and the site answers", async () => {
    const seen: string[] = [];
    const get = vi.fn()
      .mockResolvedValueOnce(down({ wake: { state: "waking", startedAt: "t", error: null } }))
      // Answering already, but the controller has not finished: keep following.
      .mockResolvedValueOnce(record({ wake: { state: "waking", startedAt: "t", error: null } }))
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(record());
    const time = clock();
    const live = await wakeUntilLive({ wake: async () => ({ state: "waking" }), get, onPreview: preview => seen.push(preview.wake?.state ?? "idle"), ...time });
    expect(live?.wake?.state).toBe("idle");
    expect(get).toHaveBeenCalledTimes(4);
    expect(seen).toEqual(["waking", "waking", "idle"]);
    expect(time.sleep).toHaveBeenCalledWith(2_000, undefined);
  });

  it("fails with the controller's reason", async () => {
    const get = vi.fn().mockResolvedValue(down({ wake: { state: "failed", startedAt: "t", error: "no such command: uw" } }));
    const error = await wakeUntilLive({ wake: async () => ({ state: "waking" }), get, ...clock() }).catch(cause => cause);
    expect(error).toBeInstanceOf(PreviewWakeError);
    expect(error.message).toBe("Couldn't start: no such command: uw");
    expect(error.gone).toBe(false);
  });

  it("gives up after the deadline instead of spinning forever", async () => {
    const time = clock();
    const error = await wakeUntilLive({ wake: async () => ({ state: "waking" }), get: async () => down({ wake: { state: "waking", startedAt: "t", error: null } }), ...time })
      .catch(cause => cause);
    expect(error.message).toBe("It's taking too long to start.");
    expect(time.now()).toBeGreaterThanOrEqual(WAKE_TIMEOUT_MS);
  });

  it("says gone for a preview removed or no longer visible, and words other refusals", async () => {
    const gone = await wakeUntilLive({ wake: async () => { throw apiError(404); }, get: vi.fn(), ...clock() }).catch(cause => cause);
    expect(gone).toMatchObject({ gone: true, message: "This preview is gone." });
    const goneLater = await wakeUntilLive({ wake: async () => ({ state: "waking" }), get: async () => { throw apiError(403); }, ...clock() }).catch(cause => cause);
    expect(goneLater.gone).toBe(true);
    expect(wakeErrorText(apiError(429))).toBe("Asked too often. Try again in a minute.");
    expect(wakeErrorText(apiError(409))).toBe("This preview can't be started from here.");
    expect(wakeErrorText(new Error("stack trace with https://secret"))).toBe("Couldn't start it.");
  });

  it("stops when aborted", async () => {
    const controller = new AbortController();
    const get = vi.fn(async () => { controller.abort(); return down(); });
    const error = await wakeUntilLive({ wake: async () => ({ state: "waking" }), get, signal: controller.signal, ...clock() }).catch(cause => cause);
    expect(error.name).toBe("AbortError");
  });
});
