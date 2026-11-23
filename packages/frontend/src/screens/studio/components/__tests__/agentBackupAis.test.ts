import { describe, expect, it } from "vitest";
import type { AgentBackupAi } from "@instafy/sdk/agents";
import type { FrontendTurnEngineContribution } from "../../../../features/frontendFeatureModule";
import type { ControllerCredentialListItem } from "../../../../sdk/instafy";
import {
  backupChoices,
  backupCountLabel,
  backupRows,
  backupsToSave,
  describeBackupSaveRefusal,
  resolveAgentOwnAi,
} from "../agentBackupAis";

// docs/Local-Engine-Turns.md 11.20: what the agent editor's Backups list
// shows, offers and saves, whatever engine a sign-in belongs to.

const WORK = "8d0c4f5e-1a2b-4c3d-8e9f-0a1b2c3d4e01";
const PERSONAL = "8d0c4f5e-1a2b-4c3d-8e9f-0a1b2c3d4e02";
const LOGIN_A = "6f1c2a43-7b7e-4c51-9a0e-2d4b1f6a8c01";
const LOGIN_B = "0b8e5d27-91a4-4f6c-b3d2-5e7a9c1f4e02";

function connection(id: string, label: string, overrides: Partial<ControllerCredentialListItem> = {}) {
  return {
    id, kind: "codex_auth_json", label, isDefault: false, metadata: { source: "device_code" },
    lastUsedAt: null, revokedAt: null, createdAt: "", updatedAt: "", ...overrides,
  } as ControllerCredentialListItem;
}

// An engine of a fixture's, named by the key the controller gives logins.
const ENGINE: FrontendTurnEngineContribution = {
  id: "fixture-engine",
  agentAi: {
    label: "Fixture Engine",
    icon: null,
    description: "",
    offeredBy: () => true,
    describeSaveRefusal: () => null,
  },
  signIns: {
    refKey: "claudeCodeLoginId",
    snapshot: () => null,
    subscribe: () => () => {},
    load: () => {},
    firstForAgent: ({ fields }) => (fields && "claudeCodeLoginId" in fields ? fields.claudeCodeLoginId ?? LOGIN_A : LOGIN_A),
  },
};

const connections = [connection(WORK, "Work ChatGPT"), connection(PERSONAL, "Personal")];
const credentialsById = new Map(connections.map((credential) => [credential.id, credential]));
const engines = [{ engine: ENGINE, signIns: [{ id: LOGIN_A, label: "Home" }, { id: LOGIN_B, label: "Studio" }] }];

describe("the agent editor's Backups", () => {
  it("saves each sign-in once, never the agent's own first AI, at most 8, and nothing without an AI of its own", () => {
    const list: AgentBackupAi[] = [
      { credentialId: PERSONAL },
      { claudeCodeLoginId: LOGIN_B },
      { credentialId: PERSONAL.toUpperCase() },
      { credentialId: WORK },
    ];
    expect(backupsToSave(list, { signIn: { credentialId: WORK } })).toEqual([
      { credentialId: PERSONAL },
      { claudeCodeLoginId: LOGIN_B },
    ]);
    expect(backupsToSave(list, null)).toEqual([]);
    const many = Array.from({ length: 10 }, (_, index) => ({ credentialId: `8d0c4f5e-1a2b-4c3d-8e9f-0a1b2c3d4f${index}0` }));
    expect(backupsToSave(many, { signIn: null })).toHaveLength(8);
  });

  it("names each row as its own list does, and still lists one it cannot name", () => {
    const rows = backupRows(
      [
        { credentialId: PERSONAL },
        { claudeCodeLoginId: LOGIN_B },
        { credentialId: "8d0c4f5e-1a2b-4c3d-8e9f-0a1b2c3d4e99" },
        { claudeCodeLoginId: "8d0c4f5e-1a2b-4c3d-8e9f-0a1b2c3d4e98" },
      ],
      { credentialsById, engines },
    );
    expect(rows.map((row) => [row.label, row.description])).toEqual([
      ["Personal", "Browser login (device code) · id …8d0c4f"],
      ["Studio", "Fixture Engine"],
      ["A connection you no longer have", null],
      ["A sign-in you no longer have", "Fixture Engine"],
    ]);
    expect(backupRows([{ claudeCodeLoginId: LOGIN_B }], { credentialsById, engines: [{ engine: ENGINE, signIns: null }] })[0]?.label).toBe(
      "Loading…",
    );
    expect(backupRows([{ claudeCodeLoginId: LOGIN_B }], { credentialsById, engines: [] })[0]?.label).toBe(
      "Another of your sign-ins",
    );
  });

  it("offers the person's live connections, then the engine's sign-ins, but not the agent's own AI or what is listed", () => {
    const revoked = connection("8d0c4f5e-1a2b-4c3d-8e9f-0a1b2c3d4e03", "Old", { revokedAt: "2026-11-01T00:00:00Z" });
    const offered = (ownAi: Parameters<typeof backupChoices>[0]["ownAi"], listed: AgentBackupAi[]) =>
      backupChoices({ connections: [...connections, revoked], engines, ownAi, listed }).map((choice) => choice.label);
    expect(offered({ signIn: { credentialId: WORK } }, [{ claudeCodeLoginId: LOGIN_B }])).toEqual(["Personal", "Home"]);
    expect(offered({ signIn: { claudeCodeLoginId: LOGIN_A } }, [])).toEqual(["Work ChatGPT", "Personal", "Studio"]);
    // An engine with no sign-in yet: nothing of its own to leave out.
    expect(offered({ signIn: null }, [])).toEqual(["Work ChatGPT", "Personal", "Home", "Studio"]);
    // Instafy AI or the default: nothing to offer.
    expect(offered(null, [])).toEqual([]);
  });

  it("works out the agent's own AI after a save as the save sends it", () => {
    const agent = { credentialId: WORK } as never;
    const base = {
      mode: "edit" as const,
      engine: null,
      agent,
      engineFields: null,
      engineChanged: false,
      credentialDraft: WORK,
      credentialDirty: false,
      hasConnections: true,
    };
    // An edit that leaves its AI alone keeps the connection it pins.
    expect(resolveAgentOwnAi(base)).toEqual({ signIn: { credentialId: WORK } });
    // One on the default shows the default in the picker, and has none of its own.
    expect(resolveAgentOwnAi({ ...base, agent: { credentialId: null } as never })).toBeNull();
    // Choosing a connection makes it its own.
    expect(resolveAgentOwnAi({ ...base, agent: { credentialId: null } as never, credentialDraft: PERSONAL, credentialDirty: true })).toEqual({
      signIn: { credentialId: PERSONAL },
    });
    // Leaving an engine: the connection the pickers show, or Instafy AI without one.
    expect(resolveAgentOwnAi({ ...base, agent: { credentialId: null } as never, engineChanged: true })).toEqual({
      signIn: { credentialId: WORK },
    });
    expect(resolveAgentOwnAi({ ...base, engineChanged: true, hasConnections: false, credentialDraft: null })).toBeNull();
    // A new agent takes the connection its picker shows.
    expect(resolveAgentOwnAi({ ...base, mode: "create", agent: null })).toEqual({ signIn: { credentialId: WORK } });
    expect(resolveAgentOwnAi({ ...base, mode: "create", agent: null, credentialDraft: null })).toBeNull();
    // An engine: its first sign-in by its own fields.
    expect(resolveAgentOwnAi({ ...base, engine: ENGINE })).toEqual({ signIn: { claudeCodeLoginId: LOGIN_A } });
    expect(resolveAgentOwnAi({ ...base, engine: ENGINE, engineFields: { claudeCodeLoginId: LOGIN_B } })).toEqual({
      signIn: { claudeCodeLoginId: LOGIN_B },
    });
  });

  it("counts backups for the agents list, and words the controller's refusals of them", () => {
    expect(backupCountLabel(undefined)).toBeNull();
    expect(backupCountLabel([])).toBeNull();
    expect(backupCountLabel([{ credentialId: WORK }])).toBe("1 backup");
    expect(backupCountLabel([{ credentialId: WORK }, { claudeCodeLoginId: LOGIN_A }])).toBe("2 backups");
    expect(describeBackupSaveRefusal("backup_ai_limit")).toBe("An agent can have up to 8 backups.");
    expect(describeBackupSaveRefusal("backup_ai_repeated")).toBe(
      "A backup is listed twice, or is this agent's own AI. Remove it, then save again.",
    );
    expect(describeBackupSaveRefusal("backup_ai_needs_own_ai")).toContain("Backups need an AI of this agent's own.");
    expect(describeBackupSaveRefusal("agent_handle_taken")).toBeNull();
    expect(describeBackupSaveRefusal(null)).toBeNull();
  });
});
