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

  it.each([
    [401, "upstream_authentication_error", "assistant", true],
    [424, "upstream_credential_refresh_failed", "assistant", true],
    [424, "upstream_configuration_error", "assistant", false],
    [401, "upstream_authentication_error", "user", false],
  ] as const)("opens credential setup only for assistant credential failures: %s %s %s", async (status, code, role, opens) => {
    resolvedRequirements();
    const diagnostic = `unexpected status ${status}: ${JSON.stringify({
      error: { type: "upstream_error", code, message: "Safe proxy failure." },
    })}`;
    const options = baseOptions({
      messages: [{ id: "safe-proxy-error", role, content: diagnostic, timestamp: Date.now() }],
    });
    await act(async () => root.render(<Harness options={options} />));
    expect(captured?.aiOnboardingOpen).toBe(opens);
  });

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

  const TTL_MS = 5 * 60_000;

  it("keeps a seed on its source clock so it cannot outlive the TTL through later spaces", async () => {
    const start = 1_700_000_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    try {
      resolvedRequirements();
      await act(async () => root.render(<Harness options={baseOptions({ currentUserId: "user-3" })} />));
      expect(captured?.credentialInventoryStatus).toBe("missing");

      // Just inside the TTL the answer still seeds a new space, but it must
      // not be re-recorded under that space with a fresh clock.
      now.mockReturnValue(start + TTL_MS - 1_000);
      pendingRequirements();
      await remount(baseOptions({ currentUserId: "user-3", activeProjectId: "project-b", activeConversationId: "conv-2" }));
      expect(captured?.credentialRequirements.requiresUserCredentials).toBe(true);
      expect(captured?.credentialInventoryStatus).toBe("missing");

      // Two seconds later the only live answer is older than the TTL.
      now.mockReturnValue(start + TTL_MS + 1_000);
      await remount(baseOptions({ currentUserId: "user-3", activeProjectId: "project-c", activeConversationId: "conv-3" }));
      expect(captured?.credentialRequirements.requiresUserCredentials).toBeNull();
      expect(captured?.credentialInventoryStatus).toBe("loading");
    } finally {
      now.mockRestore();
    }
  });

  it("never records the previous space's answer under the next space's key", async () => {
    const start = 1_700_000_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    try {
      resolvedRequirements();
      await act(async () => root.render(<Harness options={baseOptions({ currentUserId: "user-4" })} />));
      expect(captured?.credentialInventoryStatus).toBe("missing");

      // A space switch reaches the mounted hook one commit before the tab
      // strip tears the chat down, so the key changes in place while the
      // state still belongs to project-a.
      now.mockReturnValue(start + TTL_MS - 1_000);
      pendingRequirements();
      await act(async () => {
        root.render(
          <Harness options={baseOptions({ currentUserId: "user-4", activeProjectId: "project-b", activeConversationId: "conv-2" })} />,
        );
      });
      expect(captured?.credentialRequirements.requiresUserCredentials).toBe(true);

      now.mockReturnValue(start + TTL_MS + 1_000);
      await remount(baseOptions({ currentUserId: "user-4", activeProjectId: "project-c", activeConversationId: "conv-3" }));
      expect(captured?.credentialRequirements.requiresUserCredentials).toBeNull();
      expect(captured?.credentialInventoryStatus).toBe("loading");
    } finally {
      now.mockRestore();
    }
  });

  it("still refreshes the clock when this space resolves the answer live", async () => {
    const start = 1_700_000_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    try {
      resolvedRequirements();
      await act(async () => root.render(<Harness options={baseOptions({ currentUserId: "user-5" })} />));
      expect(captured?.credentialInventoryStatus).toBe("missing");

      // project-b resolves live just inside the TTL, which is a real answer.
      now.mockReturnValue(start + TTL_MS - 1_000);
      await remount(baseOptions({ currentUserId: "user-5", activeProjectId: "project-b", activeConversationId: "conv-2" }));
      expect(captured?.credentialInventoryStatus).toBe("missing");

      now.mockReturnValue(start + TTL_MS + 1_000);
      pendingRequirements();
      await remount(baseOptions({ currentUserId: "user-5", activeProjectId: "project-c", activeConversationId: "conv-3" }));
      expect(captured?.credentialRequirements.requiresUserCredentials).toBe(true);
      expect(captured?.credentialInventoryStatus).toBe("missing");
    } finally {
      now.mockRestore();
    }
  });
});
