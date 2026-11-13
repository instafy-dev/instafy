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
  controllerClient: { credentials: controllerMocks },
}));

vi.mock("../desktopCodexAuthJson", () => ({ connectDesktopCodexAuthJson: vi.fn() }));

type HookOptions = Parameters<typeof useChatCredentialGate>[0];

let captured: ReturnType<typeof useChatCredentialGate> | null = null;

function Harness({ options }: { options: HookOptions }) {
  captured = useChatCredentialGate(options);
  return null;
}

function options(messages: HookOptions["messages"]): HookOptions {
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
    messages,
    onInputChange: () => undefined,
    pinAiOnboardingToBottom: () => undefined,
    pendingCredentialAutoSubmitRef: { current: false },
    refreshAvailableAgents: () => undefined,
    runtimeControllerEnabled: true,
    showStatus: () => undefined,
  };
}

// Text that reads like the person's own AI connection needs signing in again.
const EXPIRED =
  "unexpected status 424 Failed Dependency: Upstream credentials could not be refreshed., url: http://proxy:8789/v1/responses";

describe("the expired-credential prompt and turn-engine turns", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    window.localStorage.clear();
    controllerMocks.getRequirements.mockResolvedValue({
      success: true,
      requiresUserCredentials: true,
      proxyBackend: "openai",
      hasDefaultCredential: false,
      managedAi: null,
      error: null,
    });
    controllerMocks.list.mockResolvedValue({ success: true, credentials: [] });
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

  it("never opens on its own for a turn that ran on the sender's own engine", async () => {
    await act(async () =>
      root.render(
        <Harness
          options={options([
            {
              id: "lane-failure",
              role: "assistant",
              content: EXPIRED,
              timestamp: Date.now(),
              metadata: { source: "agent", outcome: "failed", aiAccessMode: "claude-code", claudeCodeFailure: "not_signed_in" },
            },
          ])}
        />,
      ),
    );
    expect(captured?.aiOnboardingOpen).toBe(false);
  });

  it("still opens for the same failure on the person's own AI connection", async () => {
    await act(async () =>
      root.render(
        <Harness
          options={options([
            {
              id: "own-ai-failure",
              role: "assistant",
              content: EXPIRED,
              timestamp: Date.now(),
              metadata: { source: "agent", outcome: "failed", aiAccessMode: "byoc" },
            },
          ])}
        />,
      ),
    );
    expect(captured?.aiOnboardingOpen).toBe(true);
  });
});
