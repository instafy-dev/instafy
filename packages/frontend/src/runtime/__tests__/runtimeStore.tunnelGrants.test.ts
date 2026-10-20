import { describe, expect, it } from "vitest";
import { mapTunnelGrantFromPayload } from "../../services/runtimeController/runtimes";
import type { ControllerRuntimeStatusEntry } from "../../services/runtimeController";
import { createInitialRuntimeStoreState, runtimeReducer, tunnelGrantStoreKey } from "../runtimeStore";

// A `tunnel.*` event's data, as the controller broadcasts it: no metadata.
const event = {
  projectId: "project-1",
  runtimeId: "runtime-1",
  provider: "self_hosted",
  hostname: "abc.rt.test",
  url: "http://abc.rt.test",
  status: "active",
  expiresAt: "2026-10-20T20:00:00Z",
};

describe("runtime store tunnel grants", () => {
  it("keeps two tunnels on one runtime apart: the runtime's own by runtime id, another by grant id", () => {
    const own = mapTunnelGrantFromPayload({ ...event, id: "grant-own", tunnelId: "tunnel-own" })!;
    const other = mapTunnelGrantFromPayload({ ...event, id: "grant-other", tunnelId: "tunnel-other", kind: "preview" })!;
    expect(other.metadata).toEqual({ kind: "preview" });

    let state = runtimeReducer(createInitialRuntimeStoreState(), { type: "upsertTunnelGrant", grant: own });
    state = runtimeReducer(state, { type: "upsertTunnelGrant", grant: other });
    expect(state.tunnelGrants["runtime-1"]?.id).toBe("grant-own");
    expect(state.tunnelGrants["grant-other"]?.id).toBe("grant-other");

    // Revoking the other tunnel leaves the runtime's own as it was.
    state = runtimeReducer(state, { type: "upsertTunnelGrant", grant: { ...other, status: "revoked" } });
    expect(state.tunnelGrants["runtime-1"]?.status).toBe("active");
    expect(state.tunnelGrants["grant-other"]?.status).toBe("revoked");
  });

  it("reads a tunnel's purpose wherever the controller does, whatever it is", () => {
    const grant = mapTunnelGrantFromPayload({ ...event, id: "grant-1", tunnelId: "tunnel-1" })!;
    expect(tunnelGrantStoreKey(grant)).toBe("runtime-1");
    for (const key of ["purpose", "tunnelPurpose", "tunnel_purpose", "kind"]) {
      expect(tunnelGrantStoreKey({ ...grant, metadata: { [key]: "anything" } }), key).toBe("grant-1");
    }
    expect(tunnelGrantStoreKey({ ...grant, metadata: { purpose: " " } })).toBe("runtime-1");
    expect(tunnelGrantStoreKey({ ...grant, runtimeId: null })).toBeNull();
  });

  it("drops every tunnel of a runtime that is gone, and only those", () => {
    const grant = (id: string, runtimeId: string, kind?: string) =>
      mapTunnelGrantFromPayload({ ...event, id, tunnelId: id, runtimeId, ...(kind ? { kind } : {}) })!;
    let state = createInitialRuntimeStoreState();
    for (const entry of [grant("own-1", "runtime-1"), grant("other-1", "runtime-1", "preview"),
      grant("own-2", "runtime-2"), grant("other-2", "runtime-2", "preview")]) {
      state = runtimeReducer(state, { type: "upsertTunnelGrant", grant: entry });
    }
    state = runtimeReducer(state, {
      type: "setRuntimeStatuses",
      statuses: [{ runtimeId: "runtime-1", status: "running" } as ControllerRuntimeStatusEntry],
      preferredRuntimeId: null,
    });
    expect(Object.keys(state.tunnelGrants).sort()).toEqual(["other-1", "runtime-1"]);
  });
});
