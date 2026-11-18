import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
vi.mock("../client", () => ({ controllerJsonRequest: request }));

import { listMyMachines, revokeMyMachines } from "../myMachines";

const RUNTIME = "11111111-1111-4111-8111-111111111111";
const PENDING = "22222222-2222-4222-8222-222222222222";
const SPACE = "33333333-3333-4333-8333-333333333333";

const machine = {
  runtimeId: RUNTIME,
  projectId: SPACE,
  projectReadable: true,
  projectName: "Garden plans",
  displayName: "Studio Mac",
  provider: "self-hosted",
  status: "ready",
  lastSeenAt: "2026-11-18T12:00:00Z",
  mintedAt: null,
  personalBrowser: false,
  revoked: false,
  revokedAt: null,
};

describe("your machines client", () => {
  beforeEach(() => request.mockReset());

  it("lists your machines from /me/runtimes and drops entries it cannot name", async () => {
    request.mockResolvedValue({
      success: true,
      value: {
        runtimes: [
          machine,
          {
            ...machine,
            runtimeId: PENDING,
            projectReadable: false,
            projectName: "Renamed after you left",
            displayName: null,
            provider: null,
            status: "pending",
            lastSeenAt: null,
            mintedAt: "2026-11-18T11:00:00Z",
          },
          { ...machine, runtimeId: null },
          { ...machine, status: "" },
          null,
        ],
      },
    });
    const result = await listMyMachines({ accessToken: "session" });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ path: "/me/runtimes", accessToken: "session" }));
    expect(request.mock.calls[0][0].method).toBeUndefined();
    expect(result).toEqual({
      success: true,
      machines: [
        machine,
        {
          runtimeId: PENDING,
          projectId: SPACE,
          projectReadable: false,
          projectName: null,
          displayName: null,
          provider: null,
          status: "pending",
          lastSeenAt: null,
          mintedAt: "2026-11-18T11:00:00Z",
          personalBrowser: false,
          revoked: false,
          revokedAt: null,
        },
      ],
    });
  });

  it("reads which machines you revoked, and when, only from an explicit true", async () => {
    const REVOKED = "44444444-4444-4444-8444-444444444444";
    const STRING_TRUE = "55555555-5555-4555-8555-555555555555";
    const STRAY_TIME = "66666666-6666-4666-8666-666666666666";
    const OLD_CONTROLLER = "77777777-7777-4777-8777-777777777777";
    const NO_TIME = "88888888-8888-4888-8888-888888888888";
    // A controller from before revocation was recorded says nothing of it.
    const withoutRevocation = Object.fromEntries(
      Object.entries(machine).filter(([key]) => key !== "revoked" && key !== "revokedAt"),
    );
    request.mockResolvedValue({
      success: true,
      value: {
        runtimes: [
          { ...machine, runtimeId: REVOKED, status: "stopped", revoked: true, revokedAt: "2026-11-18T12:30:00Z" },
          { ...machine, runtimeId: STRING_TRUE, revoked: "true", revokedAt: "2026-11-18T12:30:00Z" },
          { ...machine, runtimeId: STRAY_TIME, revoked: false, revokedAt: "2026-11-18T12:30:00Z" },
          { ...withoutRevocation, runtimeId: OLD_CONTROLLER },
          { ...machine, runtimeId: NO_TIME, status: "offline", revoked: true, revokedAt: 1_700_000_000 },
        ],
      },
    });
    const result = await listMyMachines();
    expect(result.success).toBe(true);
    const read = result.machines.map(({ runtimeId, status, revoked, revokedAt }) => ({ runtimeId, status, revoked, revokedAt }));
    expect(read).toEqual([
      { runtimeId: REVOKED, status: "stopped", revoked: true, revokedAt: "2026-11-18T12:30:00Z" },
      { runtimeId: STRING_TRUE, status: "ready", revoked: false, revokedAt: null },
      { runtimeId: STRAY_TIME, status: "ready", revoked: false, revokedAt: null },
      { runtimeId: OLD_CONTROLLER, status: "ready", revoked: false, revokedAt: null },
      { runtimeId: NO_TIME, status: "offline", revoked: true, revokedAt: null },
    ]);
  });

  it("reports a failed or malformed list as an error, never as no machines", async () => {
    request.mockResolvedValueOnce({ success: false, error: "Unable to load your machines (503)" });
    expect(await listMyMachines()).toEqual({ success: false, machines: [], error: "Unable to load your machines (503)" });
    request.mockResolvedValueOnce({ success: true, value: { machines: [] } });
    const malformed = await listMyMachines();
    expect(malformed.success).toBe(false);
  });

  it("revokes the machines named, or all of them, and reads back what ended", async () => {
    request.mockResolvedValue({ success: true, value: { revoked: [RUNTIME, 7], pendingEnded: [PENDING] } });
    expect(await revokeMyMachines({ runtimeIds: [` ${RUNTIME} `, ""] }, { accessToken: "session" })).toEqual({
      success: true,
      revoked: [RUNTIME],
      pendingEnded: [PENDING],
    });
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({
      path: "/me/runtimes/revoke",
      method: "POST",
      accessToken: "session",
      body: { runtimeIds: [RUNTIME] },
    }));
    await revokeMyMachines({ all: true });
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ path: "/me/runtimes/revoke", method: "POST", body: { all: true } }));
  });

  it("reads an answer that ended nothing as two empty lists", async () => {
    // A machine already revoked is skipped, so naming only that one ends
    // nothing and the controller says so with two empty lists.
    request.mockResolvedValue({ success: true, value: { revoked: [], pendingEnded: [] } });
    expect(await revokeMyMachines({ runtimeIds: [RUNTIME] })).toEqual({ success: true, revoked: [], pendingEnded: [] });
    request.mockResolvedValue({ success: true, value: {} });
    expect(await revokeMyMachines({ all: true })).toEqual({ success: true, revoked: [], pendingEnded: [] });
  });

  it("never sends a revocation that names no machine", async () => {
    expect(await revokeMyMachines({ runtimeIds: [" "] })).toEqual({ success: false, error: "Choose a machine to revoke." });
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValue({ success: false, error: "No machine of yours has that id." });
    expect(await revokeMyMachines({ runtimeIds: [RUNTIME] })).toEqual({ success: false, error: "No machine of yours has that id." });
  });
});
