import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startLocalWorkspacePresence } from "./localWorkspacePresence.js";

function jsonResponse(status: number, body: unknown = { ok: true }): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("startLocalWorkspacePresence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers, heartbeats, and unregisters", async () => {
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return jsonResponse(200);
    }) as unknown as typeof fetch;

    const handle = await startLocalWorkspacePresence({
      controllerUrl: "http://127.0.0.1:8788/",
      projectId: "11111111-2222-3333-4444-555555555555",
      accessToken: "token-abc",
      workspacePath: "/home/dev/projects/demo",
      deviceId: "device-test",
      heartbeatIntervalMs: 1_000,
      fetchImpl,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toBe(
      "http://127.0.0.1:8788/projects/11111111-2222-3333-4444-555555555555/workspaces/local",
    );
    expect(calls[0].body.path).toBe("/home/dev/projects/demo");
    expect(calls[0].body.deviceId).toBe("device-test");
    expect(typeof calls[0].body.hostname).toBe("string");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(2);
    expect(calls[1].method).toBe("POST");
    expect(calls[1].url).toContain("/workspaces/local/heartbeat");
    expect(calls[1].body).toEqual({ deviceId: "device-test" });

    await handle.stop();
    expect(calls).toHaveLength(3);
    expect(calls[2].method).toBe("DELETE");
    expect(calls[2].body).toEqual({ deviceId: "device-test" });

    // No further heartbeats after stop.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(3);
  });

  it("re-registers when a heartbeat reports the registration is gone", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url: String(input) });
      if (method === "POST") {
        return jsonResponse(400, { error: "no local workspace registered" });
      }
      return jsonResponse(200);
    }) as unknown as typeof fetch;

    const handle = await startLocalWorkspacePresence({
      controllerUrl: "http://127.0.0.1:8788",
      projectId: "11111111-2222-3333-4444-555555555555",
      accessToken: "token-abc",
      workspacePath: "/tmp/demo",
      deviceId: "device-test",
      heartbeatIntervalMs: 1_000,
      fetchImpl,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    // register, heartbeat(400), re-register
    expect(calls.map((call) => call.method)).toEqual(["PUT", "POST", "PUT"]);
    await handle.stop();
  });

  it("rotates heartbeat and unregister authorization without restarting", async () => {
    const calls: Array<{ method: string; authorization: string | null }> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? "GET",
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return jsonResponse(200);
    }) as unknown as typeof fetch;

    const handle = await startLocalWorkspacePresence({
      controllerUrl: "http://127.0.0.1:8788",
      projectId: "11111111-2222-3333-4444-555555555555",
      accessToken: "expired-token",
      workspacePath: "/tmp/demo",
      deviceId: "device-test",
      heartbeatIntervalMs: 1_000,
      fetchImpl,
    });

    handle.updateAccessToken(" fresh-token ");
    await vi.advanceTimersByTimeAsync(1_000);
    await handle.stop();

    expect(calls).toEqual([
      { method: "PUT", authorization: "Bearer expired-token" },
      { method: "POST", authorization: "Bearer fresh-token" },
      { method: "DELETE", authorization: "Bearer fresh-token" },
    ]);
  });

  it("rejects an empty rotated token and retains the last valid credential", async () => {
    const authorizations: Array<string | null> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("authorization"));
      return jsonResponse(200);
    }) as unknown as typeof fetch;

    const handle = await startLocalWorkspacePresence({
      controllerUrl: "http://127.0.0.1:8788",
      projectId: "11111111-2222-3333-4444-555555555555",
      accessToken: "valid-token",
      workspacePath: "/tmp/demo",
      deviceId: "device-test",
      heartbeatIntervalMs: 1_000,
      fetchImpl,
    });

    expect(() => handle.updateAccessToken("   ")).toThrow(/requires an access token/i);
    await vi.advanceTimersByTimeAsync(1_000);
    await handle.stop();

    expect(authorizations).toEqual([
      "Bearer valid-token",
      "Bearer valid-token",
      "Bearer valid-token",
    ]);
  });

  it("throws when initial registration is rejected", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(403, { error: "forbidden" })) as unknown as typeof fetch;

    await expect(
      startLocalWorkspacePresence({
        controllerUrl: "http://127.0.0.1:8788",
        projectId: "11111111-2222-3333-4444-555555555555",
        accessToken: "bad-token",
        workspacePath: "/tmp/demo",
        deviceId: "device-test",
        fetchImpl,
      }),
    ).rejects.toThrow(/registration failed \(403\)/);
  });
});
