import { describe, expect, it } from "vitest";
import { mapTunnelGrantFromPayload } from "../../services/runtimeController/runtimes";
import type { ControllerRuntimeStatusEntry } from "../../services/runtimeController";
import { MAX_ENDED_SIDE_TUNNEL_GRANTS, createInitialRuntimeStoreState, runtimeReducer, tunnelGrantStoreKey } from "../runtimeStore";

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
    expect(other.kind).toBe("preview");

    let state = runtimeReducer(createInitialRuntimeStoreState(), { type: "upsertTunnelGrant", grant: own });
    state = runtimeReducer(state, { type: "upsertTunnelGrant", grant: other });
    expect(state.tunnelGrants["runtime-1"]?.id).toBe("grant-own");
    expect(state.tunnelGrants["grant-other"]?.id).toBe("grant-other");

    // Revoking the other tunnel keeps only its status, and leaves the runtime's own as it was.
    state = runtimeReducer(state, { type: "upsertTunnelGrant", grant: { ...other, status: "revoked" } });
    expect(state.tunnelGrants["runtime-1"]?.status).toBe("active");
    expect(state.tunnelGrants["grant-other"]?.status).toBe("revoked");
  });

  it("keeps an ended side tunnel's status, bounded, and the runtime's own where readers look", () => {
    const own = mapTunnelGrantFromPayload({ ...event, id: "grant-own", tunnelId: "tunnel-own" })!;
    let state = runtimeReducer(createInitialRuntimeStoreState(), { type: "upsertTunnelGrant", grant: own });
    const total = MAX_ENDED_SIDE_TUNNEL_GRANTS + 5;
    for (let index = 0; index < total; index += 1) {
      const preview = mapTunnelGrantFromPayload({ ...event, id: `grant-${index}`, tunnelId: `tunnel-${index}`, kind: "preview" })!;
      state = runtimeReducer(state, { type: "upsertTunnelGrant", grant: preview });
      for (const status of ["expired", "closed", "failed", "revoked"]) {
        state = runtimeReducer(state, { type: "upsertTunnelGrant", grant: { ...preview, status } });
      }
    }
    const ended = Object.keys(state.tunnelGrants).filter((key) => key !== "runtime-1");
    // Only the newest ended ones are kept, each with its last status.
    expect(ended).toHaveLength(MAX_ENDED_SIDE_TUNNEL_GRANTS);
    expect(state.tunnelGrants).not.toHaveProperty("grant-0");
    expect(state.tunnelGrants[`grant-${total - 1}`]?.status).toBe("revoked");
    // A live side tunnel is never dropped for the bound.
    const live = mapTunnelGrantFromPayload({ ...event, id: "grant-live", tunnelId: "tunnel-live", kind: "preview" })!;
    state = runtimeReducer(state, { type: "upsertTunnelGrant", grant: live });
    state = runtimeReducer(state, { type: "upsertTunnelGrant", grant: { ...live, id: "grant-late", tunnelId: "tunnel-late", status: "revoked" } });
    expect(state.tunnelGrants["grant-live"]?.status).toBe("active");
    // The runtime's own tunnel keeps its last status where readers look it up.
    state = runtimeReducer(state, { type: "upsertTunnelGrant", grant: { ...own, status: "revoked" } });
    expect(state.tunnelGrants["runtime-1"]?.status).toBe("revoked");
  });

  it("keeps no address, host or credentials for a side tunnel", () => {
    const preview = mapTunnelGrantFromPayload({ ...event, id: "grant-1", tunnelId: "tunnel-1", kind: "preview",
      credentials: { token: "secret" } })!;
    const state = runtimeReducer(createInitialRuntimeStoreState(), { type: "upsertTunnelGrant", grant: preview });
    const kept = state.tunnelGrants["grant-1"]!;
    expect(kept).toMatchObject({ id: "grant-1", tunnelId: "tunnel-1", status: "active", url: null, hostname: null, credentials: null });
    expect(JSON.stringify(state.tunnelGrants)).not.toContain("abc.rt.test");
    expect(JSON.stringify(state.tunnelGrants)).not.toContain("secret");
  });

  it("keeps a tunnel apart only when the controller marks it, never for its metadata", () => {
    const grant = mapTunnelGrantFromPayload({ ...event, id: "grant-1", tunnelId: "tunnel-1" })!;
    expect(tunnelGrantStoreKey(grant)).toBe("runtime-1");
    expect(tunnelGrantStoreKey({ ...grant, kind: "preview" })).toBe("grant-1");
    // A runtime's own tunnel from a REST answer, whatever metadata a client
    // asked for, stays where its runtime's readers look it up.
    for (const key of ["purpose", "tunnelPurpose", "tunnel_purpose", "kind"]) {
      const rest = mapTunnelGrantFromPayload({ ...event, id: "grant-1", tunnelId: "tunnel-1", metadata: { [key]: "origin" } })!;
      expect(tunnelGrantStoreKey(rest), key).toBe("runtime-1");
      const state = runtimeReducer(createInitialRuntimeStoreState(), { type: "upsertTunnelGrant", grant: rest });
      expect(state.tunnelGrants["runtime-1"]?.id, key).toBe("grant-1");
    }
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
