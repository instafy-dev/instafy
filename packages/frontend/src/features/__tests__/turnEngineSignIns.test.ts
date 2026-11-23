import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INSTAFY_FEATURE_MODULE_API_VERSION } from "@instafy/sdk/feature-modules";
import {
  AGENT_EDITOR_OWN_FIELDS,
  createFrontendFeatureComposition,
  turnEngineAgentAiRequestFields,
  type FrontendFeatureModule,
  type FrontendTurnEngineSignIns,
} from "../frontendFeatureModule";
import { APPLICATION_FRONTEND_FEATURE_MODULES } from "../publicFrontendFeatureManifest";
import {
  loadClaudeCodeLogins,
  setClaudeCodeLoginsLoaderForTests,
} from "../claudeCode/claudeCodeLoginsStore";

// docs/Local-Engine-Turns.md 11.20: a turn engine's own sign-ins, such as the
// person's Claude Code logins, reach core code only through its `signIns`
// slot: the agent editor's Backups offers them, and the chat names them.

const FIRST_LOGIN = { id: "6f1c2a43-7b7e-4c51-9a0e-2d4b1f6a8c01", label: "Personal", createdAt: "2026-11-01T09:00:00Z" };
const WORK_LOGIN = { id: "0b8e5d27-91a4-4f6c-b3d2-5e7a9c1f4e02", label: "Work", createdAt: "2026-11-02T09:00:00Z" };

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1", handle: "reviewer", displayName: "Reviewer", avatarSeed: "hatchling:3",
    description: null, bio: null, provider: "claude-code", model: null, credentialId: null,
    reasoningEffort: null, runtimeId: null, claudeCodeLoginId: null,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function engineWithSignIns(id: string, refKey: string): FrontendFeatureModule {
  const signIns: FrontendTurnEngineSignIns = {
    refKey,
    snapshot: () => null,
    subscribe: () => () => {},
    load: () => {},
  };
  return { apiVersion: INSTAFY_FEATURE_MODULE_API_VERSION, id: `fixture.${id}`, turnEngines: [{ id, signIns }] };
}

describe("the signIns slot of a turn engine", () => {
  const claudeCode = () => createFrontendFeatureComposition(APPLICATION_FRONTEND_FEATURE_MODULES).turnEngines[0];

  beforeEach(() => {
    setClaudeCodeLoginsLoaderForTests(async () => ({ success: true, logins: [FIRST_LOGIN, WORK_LOGIN] }));
  });
  afterEach(() => {
    setClaudeCodeLoginsLoaderForTests(null);
  });

  it("names Claude Code's logins by claudeCodeLoginId, from the logins store, null until it lists them", async () => {
    const signIns = claudeCode()?.signIns;
    expect(signIns?.refKey).toBe("claudeCodeLoginId");
    expect(signIns?.snapshot()).toBeNull();
    await loadClaudeCodeLogins();
    expect(signIns?.snapshot()?.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: FIRST_LOGIN.id, label: "Personal" },
      { id: WORK_LOGIN.id, label: "Work" },
    ]);
  });

  it("says which login an agent on Claude Code runs on first: the one it or the editor names, else the first", async () => {
    const signIns = claudeCode()?.signIns;
    // Nothing to say before the list loads.
    expect(signIns?.firstForAgent?.({ agent: agent(), fields: null })).toBeNull();
    await loadClaudeCodeLogins();
    expect(signIns?.firstForAgent?.({ agent: agent(), fields: null })).toBe(FIRST_LOGIN.id);
    expect(signIns?.firstForAgent?.({ agent: agent({ claudeCodeLoginId: WORK_LOGIN.id }), fields: null })).toBe(WORK_LOGIN.id);
    // What the Login choice set wins over what the agent saved, null meaning the first login.
    expect(
      signIns?.firstForAgent?.({ agent: agent({ claudeCodeLoginId: WORK_LOGIN.id }), fields: { claudeCodeLoginId: null } }),
    ).toBe(FIRST_LOGIN.id);
    expect(signIns?.firstForAgent?.({ agent: null, fields: { claudeCodeLoginId: WORK_LOGIN.id } })).toBe(WORK_LOGIN.id);
    // A login it names that the person deleted: the first login.
    expect(
      signIns?.firstForAgent?.({ agent: agent({ claudeCodeLoginId: "11111111-2222-4333-8444-555555555555" }), fields: null }),
    ).toBe(FIRST_LOGIN.id);
  });

  it("is optional, and the composition refuses a key that names no engine's sign-in, or one two engines share", () => {
    const bare: FrontendFeatureModule = {
      apiVersion: INSTAFY_FEATURE_MODULE_API_VERSION,
      id: "fixture.bare-engine",
      turnEngines: [{ id: "bare-engine" }],
    };
    expect(createFrontendFeatureComposition([bare]).turnEngines[0]?.signIns).toBeUndefined();
    expect(() => createFrontendFeatureComposition([engineWithSignIns("fixture-engine", "credentialId")])).toThrow(
      'Turn engine "fixture-engine" names its sign-ins by "credentialId"',
    );
    expect(() => createFrontendFeatureComposition([engineWithSignIns("fixture-engine", "fixtureLoginId")])).toThrow(
      'Turn engine "fixture-engine" names its sign-ins by "fixtureLoginId"',
    );
    expect(() =>
      createFrontendFeatureComposition([
        engineWithSignIns("first-engine", "claudeCodeLoginId"),
        engineWithSignIns("second-engine", "claudeCodeLoginId"),
      ]),
    ).toThrow('Two turn engines name their sign-ins by "claudeCodeLoginId".');
  });

  it("keeps backupAis the editor's own field, which an engine's fields never send", () => {
    expect(AGENT_EDITOR_OWN_FIELDS).toContain("backupAis");
    expect(
      turnEngineAgentAiRequestFields({
        claudeCodeLoginId: WORK_LOGIN.id,
        backupAis: [{ credentialId: "11111111-2222-4333-8444-555555555555" }],
      } as never),
    ).toEqual({ claudeCodeLoginId: WORK_LOGIN.id });
  });

  it("lets Claude Code's speaker line say, to the turn's own person alone, that a backup ran it", async () => {
    const presentation = claudeCode()?.presentation;
    const metadata = { aiAccessMode: "claude-code", claudeCode: { version: 1, loginId: WORK_LOGIN.id } };
    const viewer = { isViewer: true, name: "Ada" };
    await loadClaudeCodeLogins();
    expect(presentation?.describeSpeaker(viewer, metadata)).toBe("Ran on your own Claude Code (Work), on your computer");
    expect(presentation?.describeSpeaker(viewer, metadata, { backup: false })).toBe(
      "Ran on your own Claude Code (Work), on your computer",
    );
    expect(presentation?.describeSpeaker(viewer, metadata, { backup: true })).toBe(
      "Ran on your own Claude Code (Work), a backup, on your computer",
    );
    // With one login the line names none, and still says it was a backup.
    setClaudeCodeLoginsLoaderForTests(async () => ({ success: true, logins: [WORK_LOGIN] }));
    await loadClaudeCodeLogins();
    expect(presentation?.describeSpeaker(viewer, metadata, { backup: true })).toBe(
      "Ran on your own Claude Code, a backup, on your computer",
    );
    // Everyone else reads it as before.
    expect(presentation?.describeSpeaker({ isViewer: false, name: "Ada" }, metadata, { backup: true })).toBe(
      "Ran on Ada's own Claude Code, on their computer",
    );
  });
});
