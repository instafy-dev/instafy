// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatCredentialGate } from "../useChatCredentialGate";

const controllerMocks = vi.hoisted(() => ({
  createCodex: vi.fn(),
  getRequirements: vi.fn(),
  list: vi.fn(),
  setDefault: vi.fn(),
}));

vi.mock("../../../../sdk/instafy", () => ({
  controllerBaseUrl: "http://controller.test",
  runtimeControllerEnabled: true,
  controllerClient: {
    credentials: controllerMocks,
  },
}));

vi.mock("../desktopCodexAuthJson", () => ({
  connectDesktopCodexAuthJson: vi.fn(),
}));

type HookOptions = Parameters<typeof useChatCredentialGate>[0];
type HookResult = ReturnType<typeof useChatCredentialGate>;

const managedAi = {
  enabled: true,
  available: true,
  label: "Instafy AI",
  creditBurnAmount: 1,
  dailyPromptLimit: 20,
  dailyPromptsUsed: 0,
  remainingPrompts: 20,
};

function baseOptions(overrides: Partial<HookOptions> = {}): HookOptions {
  return {
    activeConversationId: "conv-1",
    activeProjectId: "project-a",
    aiConnectWizardStorageKey: null,
    canUseDesktopConnect: false,
    currentUserId: "user-1",
    focusInput: () => undefined,
    hasUser: true,
    inputEditorState: null,
    inputRequiresAi: false,
    inputValue: "",
    messages: [],
    onInputChange: () => undefined,
    pinAiOnboardingToBottom: () => undefined,
    pendingCredentialAutoSubmitRef: { current: false },
    refreshAvailableAgents: () => undefined,
    runtimeControllerEnabled: true,
    showStatus: () => undefined,
    ...overrides,
  };
}

let captured: HookResult | null = null;

function Harness({ options }: { options: HookOptions }) {
  captured = useChatCredentialGate(options);
  return null;
}

function resolvedRequirements() {
  controllerMocks.getRequirements.mockResolvedValue({
    success: true,
    requiresUserCredentials: true,
    proxyBackend: "openai",
    hasDefaultCredential: false,
    managedAi,
    error: null,
  });
  controllerMocks.list.mockResolvedValue({ success: true, credentials: [] });
}

function pendingRequirements() {
  controllerMocks.getRequirements.mockReturnValue(new Promise(() => undefined));
  controllerMocks.list.mockReturnValue(new Promise(() => undefined));
}

describe("useChatCredentialGate cache seeding across spaces", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    window.localStorage.clear();
    captured = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function remount(options: HookOptions) {
    await act(async () => root.unmount());
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<Harness options={options} />));
  }

  it("opens a new space on the same user's resolved answer instead of a cold check", async () => {
    resolvedRequirements();
    await act(async () => root.render(<Harness options={baseOptions()} />));
    expect(captured?.credentialRequirements.requiresUserCredentials).toBe(true);
    expect(captured?.credentialRequirements.managedAi?.label).toBe("Instafy AI");
    expect(captured?.credentialInventoryStatus).toBe("missing");

    pendingRequirements();
    await remount(baseOptions({ activeProjectId: "project-b", activeConversationId: "conv-2" }));

    // Nothing has resolved for project-b; the seed carries the user's answer
    // so the getting-started card goes straight to its choice, and the
    // confirming list fetch runs silently instead of flipping to "loading".
    expect(controllerMocks.list).toHaveBeenCalled();
    expect(captured?.credentialRequirements.requiresUserCredentials).toBe(true);
    expect(captured?.credentialRequirements.managedAi?.label).toBe("Instafy AI");
    expect(captured?.credentialInventoryStatus).toBe("missing");
  });

  it("does not seed another user from that cache", async () => {
    pendingRequirements();
    await act(async () => {
      root.render(<Harness options={baseOptions({ currentUserId: "user-2", activeProjectId: "project-b" })} />);
    });
    expect(captured?.credentialRequirements.requiresUserCredentials).toBeNull();
    expect(captured?.credentialInventoryStatus).toBe("loading");
  });
});
