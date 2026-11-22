// @vitest-environment jsdom

import { act, type ComponentProps, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialsSettingsCard } from "../CredentialsSettingsCard";
import type { AgentProfileModal } from "../AgentProfileModal";
import type { FrontendTurnEngineAgentAiFieldsProps } from "../../../../features/frontendFeatureModule";
import { setClaudeCodeLoginsLoaderForTests } from "../../../../features/claudeCode/claudeCodeLoginsStore";

// docs/Settings-UI.md, Bot profiles, and docs/Local-Engine-Turns.md 11.20: an
// agent whose AI is one of the person's connections or Claude Code lists
// backups after it; Instafy AI and the person's default have none.

const PROJECT_ID = "11111111-2222-4333-8444-555555555555";

const mocks = vi.hoisted(() => ({
  projectId: "" as string | null,
  agentProfileProps: null as ComponentProps<typeof AgentProfileModal> | null,
  createAgent: vi.fn(),
  listAgents: vi.fn(),
  listCredentials: vi.fn(),
  getCredentialRequirements: vi.fn(),
  updateAgent: vi.fn(),
  fetchStatus: vi.fn(),
  showStatus: vi.fn(),
}));

vi.mock("../../../../projects/ProjectStateProvider", () => ({
  useOptionalActiveProjectId: () => mocks.projectId,
}));
vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({
  useWorkspaceTabs: () => ({ openPanelTab: vi.fn(), requestUrlPush: vi.fn() }),
}));
vi.mock("../../../../providers/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "user-1", email: "person@instafy.test" } }),
}));
vi.mock("../../../../lib/identityImages", () => ({ uploadIdentityImage: vi.fn() }));
vi.mock("../../useStudioDesktopLayout", () => ({ useStudioDesktopLayout: () => false }));
vi.mock("../../../../status/useStatus", () => ({ useStatus: () => ({ showStatus: mocks.showStatus }) }));
vi.mock("../../../../sdk/instafy", () => ({
  controllerBaseUrl: "http://127.0.0.1:8789",
  runtimeControllerEnabled: true,
  controllerClient: {
    agents: { create: mocks.createAgent, list: mocks.listAgents, remove: vi.fn(), update: mocks.updateAgent },
    credentials: {
      clearDefault: vi.fn(),
      createCodex: vi.fn(),
      getRequirements: mocks.getCredentialRequirements,
      list: mocks.listCredentials,
      revoke: vi.fn(),
      setDefault: vi.fn(),
      test: vi.fn(),
    },
    runtimes: { fetchStatus: mocks.fetchStatus },
    core: { resolveRequestContext: async () => ({ baseUrl: "https://controller.example.test" }) },
  },
}));
vi.mock("../CredentialsConnectModal", () => ({ CredentialsConnectModal: () => null }));
vi.mock("../AgentProfileModal", () => ({
  AgentProfileModal: (props: ComponentProps<typeof AgentProfileModal>) => {
    mocks.agentProfileProps = props;
    return null;
  },
}));
vi.mock("../useCredentialsConnectFlow", () => ({
  useCredentialsConnectFlow: () => ({
    canManageAiConnections: true,
    openConnectModal: vi.fn(),
    openConnectModalAtStep: vi.fn(),
    openConnectModalToReplace: vi.fn(),
    connectModalProps: {},
  }),
}));

const WORK_ID = "8d0c4f5e-1a2b-4c3d-8e9f-0a1b2c3d4e01";
const PERSONAL_ID = "8d0c4f5e-1a2b-4c3d-8e9f-0a1b2c3d4e02";
const KEY_ID = "8d0c4f5e-1a2b-4c3d-8e9f-0a1b2c3d4e03";

function credential(id: string, label: string, overrides: Record<string, unknown> = {}) {
  return {
    id, kind: "codex_auth_json", label, isDefault: false, metadata: { source: "device_code", account_id: `acct_${id.slice(-6)}` },
    lastUsedAt: null, revokedAt: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const WORK = credential(WORK_ID, "Work ChatGPT", { isDefault: true });
const PERSONAL = credential(PERSONAL_ID, "Personal");
const API_KEY = credential(KEY_ID, "OpenAI", { kind: "openai_api_key", metadata: { provider: "openai" } });

// Two of the person's Claude Code logins, oldest first (11.19).
const HOME_LOGIN = { id: "6f1c2a43-7b7e-4c51-9a0e-2d4b1f6a8c01", label: "Home", createdAt: "2026-11-01T09:00:00Z" };
const STUDIO_LOGIN = { id: "0b8e5d27-91a4-4f6c-b3d2-5e7a9c1f4e02", label: "Studio", createdAt: "2026-11-02T09:00:00Z" };

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1", handle: "reviewer", displayName: "Reviewer", avatarSeed: "hatchling:3",
    description: null, bio: null, provider: "openai", model: null, credentialId: WORK_ID,
    reasoningEffort: null, runtimeId: null, claudeCodeLoginId: null, backupAis: [],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const OCTO = agent({ id: "agent-octo", handle: "octo", displayName: "Octo", avatarSeed: "octo", credentialId: null });

async function flush() {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

describe("an agent's Backups in Your AI", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    mocks.projectId = PROJECT_ID;
    mocks.agentProfileProps = null;
    for (const mock of [mocks.createAgent, mocks.listAgents, mocks.listCredentials, mocks.getCredentialRequirements, mocks.updateAgent, mocks.fetchStatus, mocks.showStatus]) {
      mock.mockReset();
    }
    mocks.listCredentials.mockResolvedValue({ success: true, credentials: [WORK, PERSONAL, API_KEY] });
    mocks.listAgents.mockResolvedValue({ success: true, agents: [OCTO, agent({ backupAis: [{ credentialId: PERSONAL_ID }] })] });
    mocks.getCredentialRequirements.mockResolvedValue({
      success: true,
      requiresUserCredentials: false,
      proxyBackend: "codex",
      hasDefaultCredential: true,
      managedAi: { enabled: true, available: true, label: "Instafy AI" },
    });
    mocks.fetchStatus.mockResolvedValue({ runtimes: [], preferredRuntimeId: null, claudeCodeLane: true });
    mocks.updateAgent.mockImplementation(async (id: string) => ({ success: true, agent: agent({ id }) }));
    mocks.createAgent.mockResolvedValue({ success: true, agent: agent({ id: "agent-new", handle: "builder" }) });
    setClaudeCodeLoginsLoaderForTests(async () => ({ success: true, logins: [HOME_LOGIN, STUDIO_LOGIN] }));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    setClaudeCodeLoginsLoaderForTests(null);
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderAgents() {
    await act(async () => {
      root.render(<CredentialsSettingsCard section="agents" />);
      await flush();
    });
  }

  async function open(testId: string) {
    await act(async () => {
      container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click();
      await flush();
    });
    expect(mocks.agentProfileProps?.isOpen).toBe(true);
  }

  async function act_(run: () => void) {
    await act(async () => {
      run();
      await flush();
    });
  }

  const backups = () => mocks.agentProfileProps?.backups ?? null;
  const rowLabels = () => backups()?.rows.map((row) => row.label) ?? null;
  const choiceLabels = () => backups()?.choices.map((choice) => choice.label) ?? null;
  const save = () => act_(() => mocks.agentProfileProps!.onSave());
  const setBackups = (next: Record<string, string>[]) => act_(() => backups()!.onChange(next as never));
  const engineFields = () =>
    mocks.agentProfileProps?.aiFields as ReactElement<FrontendTurnEngineAgentAiFieldsProps> | null | undefined;

  it("shows them for an agent on a connection of its own, offering the person's other sign-ins by name", async () => {
    await renderAgents();
    await open("bots-edit-agent-1");
    expect(rowLabels()).toEqual(["Personal"]);
    // Its own connection and what is listed already are left out; Claude
    // Code's logins come from its engine, offered here as it is.
    expect(choiceLabels()).toEqual(["OpenAI", "Home", "Studio"]);
    expect(backups()?.rows[0]?.description).toBe("Browser login (device code) · acct …3d4e02");
    expect(backups()?.choices.find((choice) => choice.label === "Studio")?.description).toBe("Claude Code");

    // Without Claude Code on offer, only connections.
    mocks.fetchStatus.mockResolvedValue({ runtimes: [], preferredRuntimeId: null });
    await act_(() => mocks.agentProfileProps!.onClose());
    await open("bots-edit-agent-1");
    expect(choiceLabels()).toEqual(["OpenAI"]);
  });

  it("saves the whole list in order when it changed, and nothing about it when it did not", async () => {
    await renderAgents();
    await open("bots-edit-agent-1");
    await act_(() => mocks.agentProfileProps!.onBioChange!("Reviews pull requests."));
    await save();
    expect(mocks.updateAgent.mock.lastCall?.[1]).not.toHaveProperty("backupAis");

    await open("bots-edit-agent-1");
    expect(mocks.agentProfileProps?.dirty).toBe(false);
    await setBackups([{ claudeCodeLoginId: STUDIO_LOGIN.id }, { credentialId: PERSONAL_ID }, { credentialId: KEY_ID }]);
    expect(mocks.agentProfileProps?.dirty).toBe(true);
    expect(rowLabels()).toEqual(["Studio", "Personal", "OpenAI"]);
    expect(choiceLabels()).toEqual(["Home"]);
    await save();
    expect(mocks.updateAgent.mock.lastCall?.[1]).toMatchObject({
      backupAis: [{ claudeCodeLoginId: STUDIO_LOGIN.id }, { credentialId: PERSONAL_ID }, { credentialId: KEY_ID }],
    });
    // The AI itself is left as it was.
    expect(mocks.updateAgent.mock.lastCall?.[1]).not.toHaveProperty("credentialId");

    await open("bots-edit-agent-1");
    await setBackups([]);
    await save();
    expect(mocks.updateAgent.mock.lastCall?.[1]).toMatchObject({ backupAis: [] });
  });

  it("drops a backup that becomes the agent's own AI, and sends the list without it", async () => {
    await renderAgents();
    await open("bots-edit-agent-1");
    await act_(() => mocks.agentProfileProps!.onCredentialChange!(PERSONAL_ID));
    expect(rowLabels()).toEqual([]);
    expect(choiceLabels()).toEqual(["Work ChatGPT", "OpenAI", "Home", "Studio"]);
    await save();
    expect(mocks.updateAgent.mock.lastCall?.[1]).toMatchObject({ credentialId: PERSONAL_ID, backupAis: [] });
  });

  it("hides them for an agent left on the person's default, until it gets a connection of its own", async () => {
    mocks.listAgents.mockResolvedValue({ success: true, agents: [OCTO, agent({ credentialId: null })] });
    await renderAgents();
    await open("bots-edit-agent-1");
    expect(backups()).toBeNull();
    await act_(() => mocks.agentProfileProps!.onBioChange!("Reviews pull requests."));
    await save();
    expect(mocks.updateAgent.mock.lastCall?.[1]).not.toHaveProperty("backupAis");

    await open("bots-edit-agent-1");
    await act_(() => mocks.agentProfileProps!.onCredentialChange!(WORK_ID));
    expect(rowLabels()).toEqual([]);
    expect(choiceLabels()).toEqual(["Personal", "OpenAI", "Home", "Studio"]);
  });

  it("never offers a Claude Code agent its own login, by what its Login choice says", async () => {
    mocks.listAgents.mockResolvedValue({
      success: true,
      agents: [OCTO, agent({ provider: "claude-code", credentialId: null, backupAis: [{ claudeCodeLoginId: STUDIO_LOGIN.id }] })],
    });
    await renderAgents();
    await open("bots-edit-agent-1");
    // It names no login, so it runs on the first, Home.
    expect(rowLabels()).toEqual(["Studio"]);
    expect(choiceLabels()).toEqual(["Work ChatGPT", "Personal", "OpenAI"]);
    await act_(() => engineFields()!.props.onFieldsChange({ claudeCodeLoginId: STUDIO_LOGIN.id }));
    expect(rowLabels()).toEqual([]);
    expect(choiceLabels()).toEqual(["Work ChatGPT", "Personal", "OpenAI", "Home"]);
    await save();
    expect(mocks.updateAgent.mock.lastCall?.[1]).toMatchObject({ claudeCodeLoginId: STUDIO_LOGIN.id, backupAis: [] });
  });

  it("hides and clears them for Instafy AI", async () => {
    mocks.listCredentials.mockResolvedValue({ success: true, credentials: [] });
    mocks.listAgents.mockResolvedValue({
      success: true,
      agents: [OCTO, agent({ provider: "claude-code", credentialId: null, backupAis: [{ claudeCodeLoginId: STUDIO_LOGIN.id }] })],
    });
    await renderAgents();
    await open("bots-edit-agent-1");
    expect(rowLabels()).toEqual(["Studio"]);
    await act_(() => mocks.agentProfileProps!.onProviderChange!("instafy-ai"));
    expect(backups()).toBeNull();
    // Going back to Claude Code starts with none.
    await act_(() => mocks.agentProfileProps!.onProviderChange!("claude-code"));
    expect(rowLabels()).toEqual([]);
    await act_(() => mocks.agentProfileProps!.onProviderChange!("instafy-ai"));
    await save();
    const body = mocks.updateAgent.mock.lastCall?.[1];
    expect(body).toMatchObject({ credentialId: null });
    // The controller clears them itself when the agent takes Instafy AI.
    expect(body).not.toHaveProperty("backupAis");
  });

  it("creates an agent with its backups, after the connection it gets", async () => {
    await renderAgents();
    await open("bots-create");
    expect(rowLabels()).toEqual([]);
    expect(choiceLabels()).toEqual(["Personal", "OpenAI", "Home", "Studio"]);
    await act_(() => mocks.agentProfileProps!.onHandleChange("@builder"));
    await setBackups([{ credentialId: KEY_ID }, { claudeCodeLoginId: HOME_LOGIN.id }]);
    await save();
    expect(mocks.createAgent.mock.lastCall?.[0]).toMatchObject({
      credentialId: WORK_ID,
      backupAis: [{ credentialId: KEY_ID }, { claudeCodeLoginId: HOME_LOGIN.id }],
    });

    // With none, a create sends none.
    await open("bots-create");
    await act_(() => mocks.agentProfileProps!.onHandleChange("@helper"));
    await save();
    expect(mocks.createAgent.mock.lastCall?.[0]).not.toHaveProperty("backupAis");
  });

  it("says why the controller refused a save's backups", async () => {
    mocks.updateAgent.mockResolvedValue({ success: false, error: "backup_ai_unknown", code: "backup_ai_unknown" });
    await renderAgents();
    await open("bots-edit-agent-1");
    await setBackups([{ credentialId: KEY_ID }]);
    await save();
    expect(mocks.showStatus).toHaveBeenLastCalledWith(
      "A backup isn't one of your sign-ins anymore. Remove it, then save again.",
      "error",
      4500,
    );
  });

  it("counts them after the AI in the agents list", async () => {
    mocks.listAgents.mockResolvedValue({
      success: true,
      agents: [
        { ...OCTO, credentialId: WORK_ID, backupAis: [{ credentialId: PERSONAL_ID }] },
        agent({ backupAis: [{ credentialId: PERSONAL_ID }, { claudeCodeLoginId: HOME_LOGIN.id }] }),
        agent({ id: "agent-2", handle: "builder", displayName: "Builder", provider: "claude-code", credentialId: null, backupAis: [{ credentialId: KEY_ID }] }),
        agent({ id: "agent-3", handle: "helper", displayName: "Helper", credentialId: PERSONAL_ID }),
      ],
    });
    await renderAgents();
    await act(async () => {
      await flush();
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Reviewer · Work ChatGPT · 2 backups");
    expect(text).toContain("Builder · Claude Code · 1 backup");
    expect(text).toContain("Octo · Work ChatGPT · 1 backup");
    expect(text).toContain("Helper · Personal");
    expect(text).not.toContain("Helper · Personal ·");
  });
});
