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

  it.each([
    ["byoc", true],
    [null, true],
    ["managed", false],
  ] as const)(
    "opens credential setup for the proxy's plain 424 sentence only off Instafy AI: %s",
    async (aiAccessMode, opens) => {
      resolvedRequirements();
      const options = baseOptions({
        messages: [
          {
            id: "refresh-424",
            role: "assistant",
            content:
              "unexpected status 424 Failed Dependency: Upstream credentials could not be refreshed., url: http://proxy:8789/v1/responses",
            timestamp: Date.now(),
            metadata: { source: "agent", outcome: "failed", ...(aiAccessMode ? { aiAccessMode } : {}) },
          },
        ],
      });
      await act(async () => root.render(<Harness options={options} />));
      expect(captured?.aiOnboardingOpen).toBe(opens);
    },
  );

  it("leaves the wizard closed when the newest sign-in failure ran on Instafy AI", async () => {
    resolvedRequirements();
    const refused =
      "unexpected status 424 Failed Dependency: Upstream credentials could not be refreshed., url: http://proxy:8789/v1/responses";
    const options = baseOptions({
      messages: [
        { id: "own-ai", role: "assistant", content: refused, timestamp: Date.now() - 60_000, metadata: { aiAccessMode: "byoc" } },
        { id: "instafy-ai", role: "assistant", content: refused, timestamp: Date.now(), metadata: { aiAccessMode: "managed" } },
      ],
    });
    await act(async () => root.render(<Harness options={options} />));
    expect(captured?.aiOnboardingOpen).toBe(false);
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

describe("useChatCredentialGate once today's hosted AI messages are used up", () => {
  let container: HTMLDivElement;
  let root: Root;
  const start = Date.parse("2026-10-26T09:00:00Z");

  function usedUpRequirements(nextAvailableAt: string) {
    return {
      success: true,
      requiresUserCredentials: true,
      proxyBackend: "openai",
      hasDefaultCredential: false,
      managedAi: {
        ...managedAi,
        available: false,
        dailyPromptsUsed: 20,
        remainingPrompts: 0,
        nextAvailableAt,
      },
      error: null,
    };
  }

  const availableAgain = {
    success: true,
    requiresUserCredentials: false,
    proxyBackend: "openai",
    hasDefaultCredential: false,
    managedAi: { ...managedAi, dailyPromptsUsed: 19, remainingPrompts: 1 },
    error: null,
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(start);
    window.localStorage.clear();
    captured = null;
    controllerMocks.list.mockResolvedValue({ success: true, credentials: [] });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("asks again when the stated time arrives and lifts the gate", async () => {
    controllerMocks.getRequirements
      .mockResolvedValueOnce(usedUpRequirements(new Date(start + 10 * 60_000).toISOString()))
      .mockResolvedValue(availableAgain);
    await act(async () => {
      root.render(
        <Harness options={baseOptions({ currentUserId: "user-allowance-1", inputRequiresAi: true })} />,
      );
    });
    expect(controllerMocks.getRequirements).toHaveBeenCalledTimes(1);
    expect(captured?.credentialGateState).toBe("missing");

    // Nothing re-asks before the time the gate names.
    await advance(10 * 60_000 - 1_000);
    expect(controllerMocks.getRequirements).toHaveBeenCalledTimes(1);
    expect(captured?.credentialGateState).toBe("missing");

    await advance(4_000);
    expect(controllerMocks.getRequirements).toHaveBeenCalledTimes(2);
    expect(captured?.credentialsReady).toBe(true);
    expect(captured?.credentialGateState).toBeNull();
  });

  it("keeps asking while the controller still reports a time that has passed", async () => {
    // A browser clock ahead of the controller's: the stated time looks past.
    const stale = usedUpRequirements(new Date(start - 30_000).toISOString());
    controllerMocks.getRequirements
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(stale)
      .mockResolvedValue(availableAgain);
    await act(async () => {
      root.render(
        <Harness options={baseOptions({ currentUserId: "user-allowance-2", inputRequiresAi: true })} />,
      );
    });
    expect(controllerMocks.getRequirements).toHaveBeenCalledTimes(1);

    await advance(59_000);
    expect(controllerMocks.getRequirements).toHaveBeenCalledTimes(1);
    await advance(2_000);
    expect(controllerMocks.getRequirements).toHaveBeenCalledTimes(2);
    expect(captured?.credentialGateState).toBe("missing");

    await advance(60_000);
    expect(controllerMocks.getRequirements).toHaveBeenCalledTimes(3);
    expect(captured?.credentialGateState).toBeNull();

    // Once hosted AI answers again nothing more is scheduled.
    await advance(10 * 60_000);
    expect(controllerMocks.getRequirements).toHaveBeenCalledTimes(3);
  });

  it("schedules nothing when the person already has their own AI", async () => {
    controllerMocks.getRequirements.mockResolvedValue(
      usedUpRequirements(new Date(start + 10 * 60_000).toISOString()),
    );
    controllerMocks.list.mockResolvedValue({
      success: true,
      credentials: [
        {
          id: "cred-own",
          kind: "codex_auth_json",
          label: "Codex",
          isDefault: true,
          revokedAt: null,
        },
      ],
    });
    await act(async () => {
      root.render(
        <Harness options={baseOptions({ currentUserId: "user-allowance-3", inputRequiresAi: true })} />,
      );
    });
    expect(captured?.credentialsReady).toBe(true);

    await advance(20 * 60_000);
    expect(controllerMocks.getRequirements).toHaveBeenCalledTimes(1);
  });
});

describe("useChatCredentialGate connecting your own AI from chat", () => {
  // Connecting in the chat's AI step is choosing that AI to answer. The
  // controller no longer makes a new connection the default by itself while
  // Instafy AI can run the person's turns, so chat asks for it.
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    window.localStorage.clear();
    captured = null;
    controllerMocks.createCodex.mockResolvedValue({ success: true, credentialId: "credential-1" });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("makes the connection the default over Instafy AI", async () => {
    resolvedRequirements();
    await act(async () => root.render(<Harness options={baseOptions({ currentUserId: "user-choice" })} />));
    await act(async () => {
      await captured?.saveApiKey("unit-test-value", "openai");
    });
    expect(controllerMocks.createCodex).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", makeDefault: true }),
    );
  });

  it("keeps the old rules when the person's own AI is already the default", async () => {
    controllerMocks.getRequirements.mockResolvedValue({
      success: true,
      requiresUserCredentials: false,
      proxyBackend: "openai",
      hasDefaultCredential: true,
      managedAi,
      error: null,
    });
    controllerMocks.list.mockResolvedValue({
      success: true,
      credentials: [{ id: "credential-0", kind: "codex_auth_json", isDefault: true, revokedAt: null }],
    });
    await act(async () => root.render(<Harness options={baseOptions({ currentUserId: "user-own" })} />));
    await act(async () => {
      await captured?.saveApiKey("unit-test-value", "openai");
    });
    expect(controllerMocks.createCodex.mock.calls[0]?.[0]).not.toHaveProperty("makeDefault");
  });
});
