import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTROLLER_RUNTIME_CLAUDE_CODE_MAX_LOGINS,
  CONTROLLER_RUNTIME_CLAUDE_CODE_VERSION,
  fetchRuntimeStatus,
  mapControllerRuntimeClaudeCode,
} from "../runtimes";

// The lane's codes are runtime-contracts' lists: the same file the runtime's
// and the controller's tests read, so a reason renamed on one side and not
// here fails at once.
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../../../..");
const LANE = JSON.parse(
  readFileSync(resolve(repo, "packages/runtime-contracts/src/claude_code_lane_fixtures.json"), "utf8"),
) as {
  notReadyReasons: string[];
  programNotReadyReasons: string[];
  runtimeFailureCodes: string[];
  stopAndSweepFailureCodes: string[];
  capabilityVersion: number;
  maxLogins: number;
  capability: Record<string, unknown> & { logins: Record<string, Record<string, unknown>> };
};

const { resolveContext } = vi.hoisted(() => ({ resolveContext: vi.fn() }));
vi.mock("../projectNotFound", () => ({ reportControllerProjectNotFound: vi.fn() }));
vi.mock("../core", async () => ({
  ...(await vi.importActual<typeof import("../core")>("../core")),
  runtimeControllerEnabled: true,
  resolveControllerRequestContext: resolveContext,
  readControllerError: vi.fn(async () => "Runtime status unavailable"),
  coerceControllerRuntimeIdleTtlSeconds: () => 600,
}));

const WORK = "6f1c2a43-7b7e-4c51-9a0e-2d4b1f6a8c01";
const PERSONAL = "0b8e5d27-91a4-4f6c-b3d2-5e7a9c1f4e02";
const SIGNED_IN = { ready: true, planSignIn: true, signedIn: true };
const READY = { version: 2, ready: true, cli: "2.1.325", verified: true, partialMessages: true, logins: { [WORK]: SIGNED_IN } };

describe("mapControllerRuntimeClaudeCode", () => {
  // docs/Local-Engine-Turns.md 11.19: the capability as a runtime with two
  // logins reports it and registration keeps it.
  it("reads both logins of runtime-contracts' version 2 capability", () => {
    expect(LANE.capabilityVersion).toBe(CONTROLLER_RUNTIME_CLAUDE_CODE_VERSION);
    expect(LANE.maxLogins).toBe(CONTROLLER_RUNTIME_CLAUDE_CODE_MAX_LOGINS);
    expect(Object.keys(LANE.capability.logins)).toHaveLength(2);
    expect(mapControllerRuntimeClaudeCode(LANE.capability)).toEqual({
      ready: true,
      reason: null,
      cli: "2.1.325",
      verified: true,
      logins: {
        [WORK]: { ready: true, reason: null, resetsAt: null, planSignIn: true, signedIn: true },
        [PERSONAL]: {
          ready: false,
          reason: "plan_limit",
          resetsAt: "2026-11-22T18:00:00Z",
          planSignIn: true,
          signedIn: true,
        },
      },
    });
  });

  it("reads a version 1 capability, one without a version, or another version as none", () => {
    for (const version of [1, undefined, 3, "2", null]) {
      expect(mapControllerRuntimeClaudeCode({ ...READY, version }), String(version)).toBeNull();
    }
    // Version 1's shape: the plan's sign-in and reset at the top, no logins.
    expect(
      mapControllerRuntimeClaudeCode({ version: 1, ready: true, cli: "2.1.314", verified: true, planSignIn: true }),
    ).toBeNull();
  });

  it("reads a ready that is not a boolean, or anything but an object, as no capability", () => {
    expect(mapControllerRuntimeClaudeCode({ ...READY, ready: "true" })).toBeNull();
    expect(mapControllerRuntimeClaudeCode({ version: 2 })).toBeNull();
    expect(mapControllerRuntimeClaudeCode([READY])).toBeNull();
    expect(mapControllerRuntimeClaudeCode("ready")).toBeNull();
    expect(mapControllerRuntimeClaudeCode(null)).toBeNull();
  });

  it("keeps the program's reason only while it is not ready, and only a program reason", () => {
    for (const reason of LANE.programNotReadyReasons) {
      expect(mapControllerRuntimeClaudeCode({ ...READY, ready: false, reason })?.reason, reason).toBe(reason);
    }
    // A login's own reason is never the program's.
    expect(mapControllerRuntimeClaudeCode({ ...READY, ready: false, reason: "plan_limit" })?.reason).toBeNull();
    expect(mapControllerRuntimeClaudeCode({ ...READY, reason: "bare_default" })?.reason).toBeNull();
    // The top-level plan sign-in and reset of version 1 are gone.
    const mapped = mapControllerRuntimeClaudeCode({ ...READY, planSignIn: true, resetsAt: "2026-11-22T18:00:00Z" });
    expect(mapped).not.toHaveProperty("planSignIn");
    expect(mapped).not.toHaveProperty("resetsAt");
  });

  // A grant malformed as a whole (11.19): the program not ready, no login.
  it("reads a malformed grant as a program that is not ready with no login", () => {
    expect(mapControllerRuntimeClaudeCode({ version: 2, ready: false, reason: "binary_unsafe", logins: {} })).toEqual({
      ready: false,
      reason: "binary_unsafe",
      cli: null,
      verified: null,
      logins: {},
    });
    // Logins that are not an object read as none.
    for (const logins of [undefined, null, [SIGNED_IN], "all"]) {
      expect(mapControllerRuntimeClaudeCode({ ...READY, logins })?.logins, String(logins)).toEqual({});
    }
  });

  it("keeps a login only under a canonical UUID, with a boolean ready, and only its known fields", () => {
    const mapped = mapControllerRuntimeClaudeCode({
      ...READY,
      logins: {
        [WORK]: { ...SIGNED_IN, configDir: "/home/sam/.claude-work", email: "sam@example.com" },
        [PERSONAL.toUpperCase()]: SIGNED_IN,
        "not-a-uuid": SIGNED_IN,
        "__proto__": SIGNED_IN,
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee": { ready: "true" },
        "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff": [SIGNED_IN],
      },
    });
    expect(Object.keys(mapped?.logins ?? {})).toEqual([WORK]);
    expect(mapped?.logins[WORK]).toEqual({ ready: true, reason: null, resetsAt: null, planSignIn: true, signedIn: true });
    expect(mapped?.logins[WORK]).not.toHaveProperty("configDir");
  });

  it("keeps how auth status exited only as a boolean, and a plan sign-in only when true", () => {
    const login = (entry: Record<string, unknown>) =>
      mapControllerRuntimeClaudeCode({ ...READY, logins: { [WORK]: entry } })?.logins[WORK];
    expect(login({ ready: true, signedIn: false })).toMatchObject({ signedIn: false, planSignIn: false });
    expect(login({ ready: true })).toMatchObject({ signedIn: null, planSignIn: false });
    expect(login({ ready: true, signedIn: "yes", planSignIn: "true" })).toMatchObject({ signedIn: null, planSignIn: false });
  });

  // 11.11: a runtime holds turns on a login until its plan's limit resets, and says when.
  it("keeps when a login's plan limit resets, only while the runtime holds it for that", () => {
    const holding = { ready: false, reason: "plan_limit", resetsAt: "2026-11-22T18:00:00Z" };
    const login = (entry: Record<string, unknown>) =>
      mapControllerRuntimeClaudeCode({ ...READY, logins: { [WORK]: entry } })?.logins[WORK];
    expect(login(holding)?.resetsAt).toBe("2026-11-22T18:00:00Z");
    expect(login({ ...holding, resetsAt: "soon" })?.resetsAt).toBeNull();
    expect(login({ ...holding, resetsAt: 1763834400000 })?.resetsAt).toBeNull();
    expect(login({ ...holding, ready: true })).toMatchObject({ ready: true, reason: null, resetsAt: null });
    expect(login({ ...holding, reason: "binary_unsafe" })).toMatchObject({ reason: "binary_unsafe", resetsAt: null });
  });

  it("keeps exactly the not-ready reasons runtime-contracts lists for a login", () => {
    expect(LANE.notReadyReasons.length).toBeGreaterThan(0);
    for (const reason of LANE.notReadyReasons) {
      const mapped = mapControllerRuntimeClaudeCode({ ...READY, logins: { [WORK]: { ready: false, reason } } });
      expect(mapped?.logins[WORK]?.reason, reason).toBe(reason);
    }
    // Every other code of the lane is a failure's, never a reason.
    const others = [...LANE.runtimeFailureCodes, ...LANE.stopAndSweepFailureCodes].filter(
      (code) => !LANE.notReadyReasons.includes(code),
    );
    expect(others.length).toBeGreaterThan(0);
    for (const code of others) {
      const mapped = mapControllerRuntimeClaudeCode({ ...READY, logins: { [WORK]: { ready: false, reason: code } } });
      expect(mapped?.logins[WORK]?.reason, code).toBeNull();
      expect(mapControllerRuntimeClaudeCode({ ...READY, ready: false, reason: code })?.reason, code).toBeNull();
    }
  });

  // A login is never ready while the program is not, as attestation forces it.
  it("never reads a login as ready while the program is not, and gives it the program's reason", () => {
    const mapped = mapControllerRuntimeClaudeCode({
      ...READY,
      ready: false,
      reason: "unsupported_version",
      logins: { [WORK]: SIGNED_IN, [PERSONAL]: { ready: false, reason: "plan_limit", resetsAt: "2026-11-22T18:00:00Z" } },
    });
    expect(mapped?.logins[WORK]).toMatchObject({ ready: false, reason: "unsupported_version" });
    expect(mapped?.logins[PERSONAL]).toMatchObject({ ready: false, reason: "unsupported_version", resetsAt: null });
  });

  it("keeps at most ten logins", () => {
    const logins = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `aaaaaaaa-bbbb-4ccc-8ddd-${String(index).padStart(12, "0")}`,
        SIGNED_IN,
      ]),
    );
    const mapped = mapControllerRuntimeClaudeCode({ ...READY, logins });
    expect(Object.keys(mapped?.logins ?? {})).toHaveLength(CONTROLLER_RUNTIME_CLAUDE_CODE_MAX_LOGINS);
  });

  it("keeps a program field only when well-formed, and never a key it does not know", () => {
    const mapped = mapControllerRuntimeClaudeCode({
      ...READY,
      ready: false,
      reason: "not_a_reason",
      cli: "latest; rm -rf",
      verified: "yes",
      path: "/home/someone/.local/bin/claude",
    });
    expect(mapped).toMatchObject({ ready: false, reason: null, cli: null, verified: null });
    expect(mapped).not.toHaveProperty("path");
    expect(mapped).not.toHaveProperty("partialMessages");
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
        { runtimeId: "desktop", claudeCode: LANE.capability },
        { runtimeId: "older", claudeCode: { version: 1, ready: true, planSignIn: true } },
        { runtimeId: "none" },
      ],
    });
    const result = await fetchRuntimeStatus({ projectId: "project-1" });
    expect(result?.claudeCodeLane).toBe(true);
    expect(result?.runtimes.map((entry) => entry.claudeCode ?? null)).toEqual([
      mapControllerRuntimeClaudeCode(LANE.capability),
      null,
      null,
    ]);
    expect(Object.keys(result?.runtimes[0]?.claudeCode?.logins ?? {})).toEqual([WORK, PERSONAL]);
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
