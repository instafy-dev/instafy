import { describe, expect, it } from "vitest";
import { mapTunnelGrantFromPayload } from "../../services/runtimeController/runtimes";
import type { ControllerRuntimeStatusEntry } from "../../services/runtimeController";
import { createInitialRuntimeStoreState, runtimeReducer, tunnelGrantPurpose, tunnelGrantStoreKey } from "../runtimeStore";

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

    // Revoking the other tunnel drops it and leaves the runtime's own as it was.
    state = runtimeReducer(state, { type: "upsertTunnelGrant", grant: { ...other, status: "revoked" } });
    expect(state.tunnelGrants["runtime-1"]?.status).toBe("active");
    expect(state.tunnelGrants).not.toHaveProperty("grant-other");
  });

  it("drops a purpose tunnel once it ends, so ended grants never pile up, and keeps the runtime's own", () => {
    const own = mapTunnelGrantFromPayload({ ...event, id: "grant-own", tunnelId: "tunnel-own" })!;
    let state = runtimeReducer(createInitialRuntimeStoreState(), { type: "upsertTunnelGrant", grant: own });
    for (let index = 0; index < 5; index += 1) {
      const preview = mapTunnelGrantFromPayload({ ...event, id: `grant-${index}`, tunnelId: `tunnel-${index}`, kind: "preview" })!;
      state = runtimeReducer(state, { type: "upsertTunnelGrant", grant: preview });
      for (const status of ["expired", "closed", "failed", "revoked"]) {
        state = runtimeReducer(state, { type: "upsertTunnelGrant", grant: { ...preview, status } });
      }
    }
    expect(Object.keys(state.tunnelGrants)).toEqual(["runtime-1"]);
    // An ended event for a grant the store never kept changes nothing.
    const unknown = mapTunnelGrantFromPayload({ ...event, id: "grant-x", tunnelId: "tunnel-x", kind: "preview", status: "revoked" })!;
    expect(runtimeReducer(state, { type: "upsertTunnelGrant", grant: unknown })).toBe(state);
    // The runtime's own tunnel keeps its last status where readers look it up.
    state = runtimeReducer(state, { type: "upsertTunnelGrant", grant: { ...own, status: "revoked" } });
    expect(state.tunnelGrants["runtime-1"]?.status).toBe("revoked");
  });

  it("reads a purpose as the controller does: the first key present, normalized", () => {
    expect(tunnelGrantPurpose({ purpose: "  Web Preview  " })).toBe("web_preview");
    expect(tunnelGrantPurpose({ kind: "weird:purpose!" })).toBe("weird_purpose");
    expect(tunnelGrantPurpose({ kind: "x".repeat(60) })).toBe("x".repeat(48));
    // Nothing that normalizes to a purpose is one.
    expect(tunnelGrantPurpose({ purpose: "!!!" })).toBeNull();
    expect(tunnelGrantPurpose({ purpose: "   " })).toBeNull();
    // The first key present decides, even when it is not a string.
    expect(tunnelGrantPurpose({ purpose: 7, kind: "preview" })).toBeNull();
    expect(tunnelGrantPurpose({ tunnelPurpose: "cli", kind: "preview" })).toBe("cli");
    expect(tunnelGrantPurpose(null)).toBeNull();
  });

  it("reads a tunnel's purpose wherever the controller does, whatever it is", () => {
    const grant = mapTunnelGrantFromPayload({ ...event, id: "grant-1", tunnelId: "tunnel-1" })!;
    expect(tunnelGrantStoreKey(grant)).toBe("runtime-1");
    for (const key of ["purpose", "tunnelPurpose", "tunnel_purpose", "kind"]) {
      expect(tunnelGrantStoreKey({ ...grant, metadata: { [key]: "anything" } }), key).toBe("grant-1");
    }
    expect(tunnelGrantStoreKey({ ...grant, metadata: { purpose: " " } })).toBe("runtime-1");
    expect(tunnelGrantStoreKey({ ...grant, metadata: { purpose: "!!!" } })).toBe("runtime-1");
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
