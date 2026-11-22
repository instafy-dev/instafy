// @vitest-environment jsdom

import { act, type ComponentProps, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialsSettingsCard } from "../CredentialsSettingsCard";
import type { AgentProfileModal } from "../AgentProfileModal";
import type { FrontendTurnEngineAgentAiFieldsProps } from "../../../../features/frontendFeatureModule";
import { setClaudeCodeLoginsLoaderForTests } from "../../../../features/claudeCode/claudeCodeLoginsStore";

// docs/Local-Engine-Turns.md 11.3: every agent's AI, @octo's included, can be
// Claude Code, beside Instafy AI and the person's own connections, offered
// only where the open space's status says the switch covers the person.

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

const CONNECTION = {
  id: "cred-old",
  kind: "codex_auth_json",
  label: "Browser upload",
  isDefault: true,
  metadata: { account_id: "acct_1234567890" },
  lastUsedAt: null,
  revokedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1", handle: "reviewer", displayName: "Reviewer", avatarSeed: "hatchling:3",
    description: null, bio: null, provider: "openai", model: null, credentialId: null,
    reasoningEffort: null, runtimeId: null,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const OCTO = agent({ id: "agent-octo", handle: "octo", displayName: "Octo", avatarSeed: "octo" });

// Two of the person's Claude Code logins, oldest first (docs/Local-Engine-Turns.md 11.19).
const FIRST_LOGIN = { id: "6f1c2a43-7b7e-4c51-9a0e-2d4b1f6a8c01", label: "Personal", createdAt: "2026-11-01T09:00:00Z" };
const WORK_LOGIN = { id: "0b8e5d27-91a4-4f6c-b3d2-5e7a9c1f4e02", label: "Work", createdAt: "2026-11-02T09:00:00Z" };

async function flush() {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
  }
}

describe("Claude Code as an agent's AI in Your AI", () => {
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
    mocks.listCredentials.mockResolvedValue({ success: true, credentials: [CONNECTION] });
    mocks.listAgents.mockResolvedValue({ success: true, agents: [OCTO, agent()] });
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
    setClaudeCodeLoginsLoaderForTests(async () => ({ success: true, logins: [FIRST_LOGIN, WORK_LOGIN] }));
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

  async function choose(id: string) {
    await act(async () => {
      mocks.agentProfileProps!.onProviderChange!(id);
      await flush();
    });
  }

  async function save() {
    await act(async () => {
      mocks.agentProfileProps!.onSave();
      await flush();
    });
  }

  const choiceIds = () => mocks.agentProfileProps?.providerOptions?.map((option) => option.id) ?? [];
  // The engine's own fields under its choice, as the editor renders them.
  const engineFields = () =>
    mocks.agentProfileProps?.aiFields as ReactElement<FrontendTurnEngineAgentAiFieldsProps> | null | undefined;
  async function setEngineFields(fields: Record<string, unknown>) {
    await act(async () => {
      engineFields()!.props.onFieldsChange(fields);
      await flush();
    });
  }

  it("offers Claude Code beside the connections where the switch covers the person, and only there", async () => {
    await renderAgents();
    await open("bots-edit-agent-1");
    expect(mocks.fetchStatus).toHaveBeenCalledWith(expect.objectContaining({ projectId: PROJECT_ID }));
    expect(choiceIds()).toEqual(["openai", "deepseek", "zai", "gemini", "claude-code"]);
    expect(mocks.agentProfileProps?.providerOptions?.at(-1)?.label).toBe("Claude Code");

    // Without the lane flag the editor is as it always was.
    mocks.fetchStatus.mockResolvedValue({ runtimes: [], preferredRuntimeId: null });
    await act(async () => mocks.agentProfileProps!.onClose());
    await open("bots-edit-agent-1");
    expect(choiceIds()).toEqual(["openai", "deepseek", "zai", "gemini"]);
  });

  it("works for @octo too, and hides model and connection for Claude Code, with its line", async () => {
    await renderAgents();
    await open("bots-octo-edit");
    expect(choiceIds()).toContain("claude-code");
    await choose("claude-code");
    expect(mocks.agentProfileProps?.providerId).toBe("claude-code");
    expect(mocks.agentProfileProps?.credentials).toEqual([]);
    expect(mocks.agentProfileProps?.modelOptions).toEqual([]);
    expect(mocks.agentProfileProps?.subtitle).toBe("Powered by Claude Code.");
    const note = document.createElement("div");
    const noteRoot = createRoot(note);
    await act(async () => noteRoot.render(<>{mocks.agentProfileProps?.aiNote}</>));
    expect(note.textContent).toContain(
      "Runs on your own Claude Code, on your computer. Its turns wait while your computer is off.",
    );
    await act(async () => noteRoot.unmount());

    await save();
    expect(mocks.updateAgent).toHaveBeenCalledTimes(1);
    const [agentId, body] = mocks.updateAgent.mock.lastCall!;
    expect(agentId).toBe("agent-octo");
    expect(body).toMatchObject({ provider: "claude-code" });
    // The controller clears the credential itself, and refuses one beside the provider.
    expect(body).not.toHaveProperty("credentialId");
    expect(body).not.toHaveProperty("model");
  });

  it("shows an agent that uses Claude Code as such, also where it isn't offered, and lists it so", async () => {
    mocks.fetchStatus.mockResolvedValue({ runtimes: [], preferredRuntimeId: null });
    mocks.listAgents.mockResolvedValue({
      success: true,
      agents: [{ ...OCTO, provider: "claude-code" }, agent({ provider: "claude-code" })],
    });
    await renderAgents();
    // Wherever agents' AI is listed.
    expect(container.textContent).toContain("Reviewer · Claude Code");
    expect(container.textContent).toContain("Octo · Claude Code");
    await open("bots-edit-agent-1");
    expect(mocks.agentProfileProps?.providerId).toBe("claude-code");
    expect(choiceIds()).toEqual(["openai", "deepseek", "zai", "gemini", "claude-code"]);
    expect(mocks.agentProfileProps?.modelOptions).toEqual([]);
    // Opening it changes nothing.
    await act(async () => mocks.agentProfileProps!.onBioChange!("Reviews pull requests."));
    await save();
    expect(mocks.updateAgent.mock.lastCall?.[1]).not.toHaveProperty("provider");
    expect(mocks.updateAgent.mock.lastCall?.[1]).not.toHaveProperty("credentialId");
  });

  it("goes back to a connection by sending that connection, even the one the pickers show", async () => {
    mocks.listAgents.mockResolvedValue({ success: true, agents: [OCTO, agent({ provider: "claude-code" })] });
    await renderAgents();
    await open("bots-edit-agent-1");
    await choose("openai");
    expect(mocks.agentProfileProps?.providerId).toBe("openai");
    expect(mocks.agentProfileProps?.credentials?.map((credential) => credential.id)).toEqual(["cred-old"]);
    await save();
    expect(mocks.updateAgent.mock.lastCall?.[1]).toMatchObject({ credentialId: "cred-old" });
    expect(mocks.updateAgent.mock.lastCall?.[1]).not.toHaveProperty("provider");
  });

  it("goes back to Instafy AI for a person without connections", async () => {
    mocks.listCredentials.mockResolvedValue({ success: true, credentials: [] });
    mocks.listAgents.mockResolvedValue({ success: true, agents: [OCTO, agent({ provider: "claude-code" })] });
    await renderAgents();
    await open("bots-edit-agent-1");
    expect(choiceIds()).toEqual(["instafy-ai", "claude-code"]);
    expect(mocks.agentProfileProps?.providerOptions?.[0]?.label).toBe("Instafy AI");
    await choose("instafy-ai");
    expect(mocks.agentProfileProps?.providerId).toBe("instafy-ai");
    await save();
    expect(mocks.updateAgent.mock.lastCall?.[1]).toMatchObject({ credentialId: null });
    expect(mocks.updateAgent.mock.lastCall?.[1]).not.toHaveProperty("provider");
  });

  it("creates an agent that uses Claude Code with a handle and no connection or model", async () => {
    await renderAgents();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="bots-create"]')!.click();
      await flush();
    });
    expect(mocks.agentProfileProps?.mode).toBe("create");
    await choose("claude-code");
    expect(mocks.agentProfileProps?.handleRequired).toBe(true);
    expect(mocks.agentProfileProps?.subtitle).toBe("Powered by Claude Code.");
    await act(async () => mocks.agentProfileProps!.onHandleChange("@builder"));
    await save();
    const body = mocks.createAgent.mock.lastCall?.[0];
    expect(body).toMatchObject({ provider: "claude-code", handle: "builder" });
    expect(body).not.toHaveProperty("credentialId");
    expect(body).not.toHaveProperty("model");
  });

  it("says why when the controller refuses Claude Code for this person", async () => {
    mocks.updateAgent.mockResolvedValue({
      success: false,
      error: "claude code turns are not enabled for this user",
      code: "claude_code_turn_not_allowed",
      details: null,
    });
    await renderAgents();
    await open("bots-edit-agent-1");
    await choose("claude-code");
    await save();
    expect(mocks.showStatus).toHaveBeenLastCalledWith("Claude Code turns aren't on for your account.", "error", 4500);
    expect(mocks.agentProfileProps?.isOpen).toBe(true);
  });

  // docs/Settings-UI.md, Bot profiles: the engine's own fields under its
  // choice, such as which of the person's Claude Code logins the agent uses.
  it("sends what the engine's own fields set with the agent's AI, and never in place of the editor's", async () => {
    mocks.listAgents.mockResolvedValue({ success: true, agents: [OCTO, agent({ provider: "claude-code", claudeCodeLoginId: null })] });
    await renderAgents();
    await open("bots-edit-agent-1");
    expect(engineFields()?.props.agent?.id).toBe("agent-1");
    expect(engineFields()?.props.fields).toBeNull();
    expect(mocks.agentProfileProps?.dirty).toBe(false);

    await setEngineFields({ claudeCodeLoginId: WORK_LOGIN.id, provider: "openai", handle: "someone-else" });
    expect(mocks.agentProfileProps?.dirty).toBe(true);
    expect(engineFields()?.props.fields).toMatchObject({ claudeCodeLoginId: WORK_LOGIN.id });
    await save();
    const body = mocks.updateAgent.mock.lastCall?.[1];
    expect(body).toMatchObject({ claudeCodeLoginId: WORK_LOGIN.id, handle: "reviewer" });
    // The AI stays the one chosen: the editor sends no provider for an unchanged one.
    expect(body).not.toHaveProperty("provider");
  });

  it("sends the engine's fields when the agent is made, and drops them once another AI is chosen", async () => {
    await renderAgents();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="bots-create"]')!.click();
      await flush();
    });
    expect(engineFields()).toBeNull();
    await choose("claude-code");
    expect(engineFields()?.props.agent).toBeNull();
    await setEngineFields({ claudeCodeLoginId: WORK_LOGIN.id });
    await act(async () => mocks.agentProfileProps!.onHandleChange("@builder"));
    await save();
    expect(mocks.createAgent.mock.lastCall?.[0]).toMatchObject({
      provider: "claude-code",
      handle: "builder",
      claudeCodeLoginId: WORK_LOGIN.id,
    });

    mocks.listAgents.mockResolvedValue({ success: true, agents: [OCTO, agent({ provider: "claude-code" })] });
    await renderAgents();
    await open("bots-edit-agent-1");
    await setEngineFields({ claudeCodeLoginId: WORK_LOGIN.id });
    await choose("openai");
    expect(engineFields()).toBeNull();
    await choose("claude-code");
    expect(engineFields()?.props.fields).toBeNull();
    await choose("openai");
    await save();
    expect(mocks.updateAgent.mock.lastCall?.[1]).toMatchObject({ credentialId: "cred-old" });
    expect(mocks.updateAgent.mock.lastCall?.[1]).not.toHaveProperty("claudeCodeLoginId");
  });

  it("names the login an agent uses in the list once the person has more than one", async () => {
    mocks.listAgents.mockResolvedValue({
      success: true,
      agents: [
        { ...OCTO, provider: "claude-code", claudeCodeLoginId: null },
        agent({ provider: "claude-code", claudeCodeLoginId: WORK_LOGIN.id }),
      ],
    });
    await renderAgents();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("Reviewer · Claude Code (Work)");
    // An agent that names no login runs on the first one, and reads as before.
    expect(container.textContent).toContain("Octo · Claude Code");
    expect(container.textContent).not.toContain("Octo · Claude Code (");
  });

  it("asks nothing of a space's status where no space is open", async () => {
    mocks.projectId = null;
    await renderAgents();
    await open("bots-edit-agent-1");
    expect(mocks.fetchStatus).not.toHaveBeenCalled();
    expect(choiceIds()).not.toContain("claude-code");
  });
});
