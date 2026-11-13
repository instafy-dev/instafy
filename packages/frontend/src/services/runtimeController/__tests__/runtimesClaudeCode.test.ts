import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRuntimeStatus, mapControllerRuntimeClaudeCode } from "../runtimes";

const { resolveContext } = vi.hoisted(() => ({ resolveContext: vi.fn() }));
vi.mock("../projectNotFound", () => ({ reportControllerProjectNotFound: vi.fn() }));
vi.mock("../core", async () => ({
  ...(await vi.importActual<typeof import("../core")>("../core")),
  runtimeControllerEnabled: true,
  resolveControllerRequestContext: resolveContext,
  readControllerError: vi.fn(async () => "Runtime status unavailable"),
  coerceControllerRuntimeIdleTtlSeconds: () => 600,
}));

const READY = { version: 1, ready: true, cli: "2.1.314", verified: true, planSignIn: true };

describe("mapControllerRuntimeClaudeCode", () => {
  it("keeps the attested shape", () => {
    expect(mapControllerRuntimeClaudeCode(READY)).toEqual({
      ready: true,
      reason: null,
      cli: "2.1.314",
      verified: true,
      planSignIn: true,
    });
    // The status route sends the fields without a version.
    expect(
      mapControllerRuntimeClaudeCode({ ready: false, reason: "binary_unsafe", cli: null }),
    ).toEqual({ ready: false, reason: "binary_unsafe", cli: null, verified: null, planSignIn: false });
  });

  it("reads another version, or a ready that is not a boolean, as no capability", () => {
    expect(mapControllerRuntimeClaudeCode({ ...READY, version: 2 })).toBeNull();
    expect(mapControllerRuntimeClaudeCode({ ...READY, version: "1" })).toBeNull();
    expect(mapControllerRuntimeClaudeCode({ ...READY, ready: "true" })).toBeNull();
    expect(mapControllerRuntimeClaudeCode({ version: 1 })).toBeNull();
    expect(mapControllerRuntimeClaudeCode([READY])).toBeNull();
    expect(mapControllerRuntimeClaudeCode("ready")).toBeNull();
    expect(mapControllerRuntimeClaudeCode(null)).toBeNull();
  });

  it("keeps a field only when well-formed, and never a key it does not know", () => {
    const mapped = mapControllerRuntimeClaudeCode({
      ready: false,
      reason: "not_a_reason",
      cli: "latest; rm -rf",
      verified: "yes",
      planSignIn: "true",
      path: "/Users/someone/.local/bin/claude",
    });
    expect(mapped).toEqual({ ready: false, reason: null, cli: null, verified: null, planSignIn: false });
    expect(mapped).not.toHaveProperty("path");
    // A reason means nothing on a ready capability.
    expect(mapControllerRuntimeClaudeCode({ ...READY, reason: "bare_default" })?.reason).toBeNull();
  });
});

describe("fetchRuntimeStatus and the lane", () => {
  beforeEach(() => {
    resolveContext.mockResolvedValue({ baseUrl: "https://controller.test", accessToken: "inert-session" });
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  function answer(body: unknown) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
  }

  it("keeps the lane flag and each runtime's capability when the lane covers the viewer", async () => {
    answer({
      preferredRuntimeId: null,
      claudeCodeLane: true,
      runtimes: [
        { runtimeId: "desktop", claudeCode: { ...READY, planSignIn: false } },
        { runtimeId: "odd", claudeCode: { version: 3, ready: true } },
        { runtimeId: "none" },
      ],
    });
    const result = await fetchRuntimeStatus({ projectId: "project-1" });
    expect(result?.claudeCodeLane).toBe(true);
    expect(result?.runtimes.map((entry) => entry.claudeCode ?? null)).toEqual([
      { ready: true, reason: null, cli: "2.1.314", verified: true, planSignIn: false },
      null,
      null,
    ]);
  });

  it("drops every capability, and says nothing of the lane, when the flag is absent or not true", async () => {
    for (const claudeCodeLane of [undefined, false, "true", 1]) {
      answer({
        preferredRuntimeId: null,
        claudeCodeLane,
        runtimes: [{ runtimeId: "desktop", claudeCode: READY }],
      });
      const result = await fetchRuntimeStatus({ projectId: "project-1" });
      expect(result).not.toHaveProperty("claudeCodeLane");
      expect(result?.runtimes[0]?.claudeCode).toBeUndefined();
    }
  });
});
