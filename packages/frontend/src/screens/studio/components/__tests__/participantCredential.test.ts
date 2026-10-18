import { describe, expect, it } from "vitest";
import { resolveRosterCredential } from "../participantCredential";

const managedAi = {
  enabled: true,
  available: true,
  label: "Instafy AI",
  modelId: "gpt-6-luna",
  modelLabel: "GPT-6 Luna",
};

describe("resolveRosterCredential", () => {
  it("shows the managed lane and its model when the space has no credential of its own", () => {
    // Oct 16: the roster said "gpt-5.6-sol · No AI credential" in a managed-AI space whose turns all ran on
    // GPT-6 Luna.
    const resolved = resolveRosterCredential({
      pinnedCredentialId: null,
      pinnedModel: null,
      providerDefaultModel: "gpt-5.6-sol",
      credentialsById: new Map(),
      defaultCredential: null,
      managedAi,
    });
    expect(resolved.credentialState).toBe("managed");
    expect(resolved.managedLabel).toBe("Instafy AI");
    expect(resolved.model).toBeNull();
    expect(resolved.modelLabel).toBe("GPT-6 Luna");
  });

  it("keeps the warning when managed AI is off or unavailable", () => {
    for (const lane of [null, { ...managedAi, available: false }, { ...managedAi, enabled: false }]) {
      const resolved = resolveRosterCredential({
        pinnedCredentialId: null,
        pinnedModel: null,
        providerDefaultModel: "gpt-5.6-sol",
        credentialsById: new Map(),
        defaultCredential: null,
        managedAi: lane,
      });
      expect(resolved.credentialState).toBe("none");
      expect(resolved.modelLabel).toBe("gpt-5.6-sol");
    }
  });

  it("prefers the agent's own credential and pinned model", () => {
    const key = { id: "c1", revokedAt: null };
    const byId = new Map([["c1", key]]);
    const pinned = resolveRosterCredential({
      pinnedCredentialId: "c1",
      pinnedModel: "gpt-5.6-sol",
      providerDefaultModel: "gpt-5.6-sol",
      credentialsById: byId,
      defaultCredential: null,
      managedAi,
    });
    expect(pinned.credentialState).toBe("pinned");
    expect(pinned.credential).toBe(key);
    const viaDefault = resolveRosterCredential({
      pinnedCredentialId: null,
      pinnedModel: null,
      providerDefaultModel: "gpt-5.6-sol",
      credentialsById: byId,
      defaultCredential: key,
      managedAi,
    });
    expect(viaDefault.credentialState).toBe("default");
    expect(viaDefault.modelLabel).toBe("gpt-5.6-sol");
    const revoked = resolveRosterCredential({
      pinnedCredentialId: "c2",
      pinnedModel: null,
      providerDefaultModel: null,
      credentialsById: new Map([["c2", { id: "c2", revokedAt: "2026-10-01" }]]),
      defaultCredential: null,
      managedAi,
    });
    expect(revoked.credentialState).toBe("revoked");
    expect(revoked.credential).toBeNull();
    expect(revoked.labelCredential?.id).toBe("c2");
    expect(resolveRosterCredential({ pinnedCredentialId: "gone", pinnedModel: null, providerDefaultModel: null, credentialsById: new Map(), defaultCredential: null, managedAi }).credentialState).toBe("missing");
  });
});
