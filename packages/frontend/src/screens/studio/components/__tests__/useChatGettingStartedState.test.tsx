// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatGettingStartedState } from "../useChatGettingStartedState";

type HookOptions = Parameters<typeof useChatGettingStartedState>[0];

function baseOptions(overrides: Partial<HookOptions> = {}): HookOptions {
  return {
    activeConversationId: "conv-1",
    activeProjectId: "proj-1",
    aiOnboardingOpen: false,
    anyAgentsEnabled: true,
    clearGithubImportUi: () => undefined,
    conversations: [],
    conversationsProjectKey: "proj-1",
    credentialGateState: null,
    credentialsReady: true,
    currentUserId: "user-1",
    displayedMessageCount: 0,
    githubImportBusy: false,
    gettingStartedContextRelevant: true,
    gettingStartedContextResolved: true,
    hasMoreHistory: false,
    inputValue: "",
    isHistoryLoading: false,
    onInputChange: () => undefined,
    remoteHistoryPresenceResolved: true,
    runtimeControllerEnabled: true,
    ...overrides,
  };
}

let captured: ReturnType<typeof useChatGettingStartedState> | null = null;

function Harness({ options }: { options: HookOptions }) {
  captured = useChatGettingStartedState(options);
  return (
    <div>
      <span data-testid="show">{String(captured.shouldShowGettingStarted)}</span>
      <span data-testid="mode">{captured.gettingStartedMode}</span>
      <span data-testid="managed-ai-selected">
        {String(captured.gettingStartedManagedAiSelected)}
      </span>
    </div>
  );
}

describe("useChatGettingStartedState", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    captured = null;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  function show() {
    return container.querySelector('[data-testid="show"]')?.textContent;
  }
  function mode() {
    return container.querySelector('[data-testid="mode"]')?.textContent;
  }
  function managedAiSelected() {
    return container.querySelector('[data-testid="managed-ai-selected"]')?.textContent;
  }

  it("keeps the large discovery card out of a human-only shared conversation", async () => {
    await act(async () => {
      root.render(
        <Harness
          options={baseOptions({
            anyAgentsEnabled: false,
            gettingStartedContextRelevant: false,
          })}
        />,
      );
    });

    expect(show()).toBe("false");
    expect(captured?.onboardingInputLocked).toBe(false);
  });

  it("does not flash discovery while shared participants are resolving", async () => {
    await act(async () => {
      root.render(
        <Harness
          options={baseOptions({
            anyAgentsEnabled: false,
            gettingStartedContextRelevant: false,
            gettingStartedContextResolved: false,
          })}
        />,
      );
    });
    expect(show()).toBe("false");

    await act(async () => {
      root.render(
        <Harness
          options={baseOptions({
            anyAgentsEnabled: false,
            gettingStartedContextRelevant: true,
            gettingStartedContextResolved: true,
          })}
        />,
      );
    });
    expect(show()).toBe("true");
  });

  it("keeps explicit GitHub import reachable from a human-only conversation", async () => {
    await act(async () => {
      root.render(
        <Harness
          options={baseOptions({
            anyAgentsEnabled: false,
            gettingStartedContextRelevant: false,
          })}
        />,
      );
    });
    expect(show()).toBe("false");

    await act(async () => {
      captured?.beginGithubImport();
    });
    expect(show()).toBe("true");
    expect(mode()).toBe("github");
  });

  it("persists an explicit managed AI selection", async () => {
    await act(async () => {
      root.render(<Harness options={baseOptions()} />);
    });

    await act(async () => {
      captured?.selectGettingStartedManagedAi();
    });

    expect(managedAiSelected()).toBe("true");
    expect(show()).toBe("true");
    expect(
      window.localStorage.getItem("instafy.onboarding.managedAiSelected:user-1:proj-1"),
    ).toBe("1");
  });

  it("resets transient paths and reads the next space's scoped AI choice", async () => {
    await act(async () => {
      root.render(<Harness options={baseOptions()} />);
    });
    await act(async () => {
      captured?.selectGettingStartedManagedAi();
      captured?.handleGettingStartedModeChange("github");
    });
    expect(mode()).toBe("github");
    expect(managedAiSelected()).toBe("true");

    await act(async () => {
      root.render(
        <Harness
          options={baseOptions({
            activeConversationId: "conv-2",
            activeProjectId: "proj-2",
            conversationsProjectKey: "proj-2",
          })}
        />,
      );
    });

    expect(mode()).toBe("root");
    expect(managedAiSelected()).toBe("false");
    expect(show()).toBe("true");
  });

  it("forces the card open in github mode even when the conversation has history", async () => {
    await act(async () => {
      root.render(<Harness options={baseOptions({ displayedMessageCount: 8 })} />);
    });
    // History present -> card normally hidden.
    expect(show()).toBe("false");

    await act(async () => {
      captured?.beginGithubImport();
    });
    expect(show()).toBe("true");
    expect(mode()).toBe("github");
  });

  it("re-opens the card in github mode after it was dismissed", async () => {
    await act(async () => {
      root.render(<Harness options={baseOptions()} />);
    });
    expect(show()).toBe("true");

    await act(async () => {
      captured?.dismissGettingStarted();
    });
    expect(show()).toBe("false");

    await act(async () => {
      captured?.beginGithubImport();
    });
    expect(show()).toBe("true");
    expect(mode()).toBe("github");
  });

  it("returns Back to root when import was launched from the composer menu", async () => {
    await act(async () => {
      root.render(<Harness options={baseOptions()} />);
    });
    await act(async () => {
      captured?.beginGithubImport();
    });
    expect(mode()).toBe("github");
  });

  it("reopens the AI choice when the user clears the managed selection", async () => {
    await act(async () => {
      root.render(<Harness options={baseOptions()} />);
    });
    await act(async () => {
      captured?.selectGettingStartedManagedAi();
    });
    expect(managedAiSelected()).toBe("true");

    await act(async () => {
      captured?.clearGettingStartedManagedAiSelection();
    });
    expect(managedAiSelected()).toBe("false");
    expect(mode()).toBe("root");
    expect(
      window.localStorage.getItem("instafy.onboarding.managedAiSelected:user-1:proj-1"),
    ).toBe("0");
  });

  it("does not reinterpret a legacy personal-AI completion as a managed selection", async () => {
    window.localStorage.setItem("instafy.onboarding.aiChoiceSettled:user-1:proj-1", "1");

    await act(async () => {
      root.render(<Harness options={baseOptions()} />);
    });

    expect(managedAiSelected()).toBe("false");
    expect(
      window.localStorage.getItem("instafy.onboarding.managedAiSelected:user-1:proj-1"),
    ).toBeNull();
  });

  it("clears the forced import when the user navigates to another mode", async () => {
    await act(async () => {
      root.render(<Harness options={baseOptions({ displayedMessageCount: 8 })} />);
    });
    await act(async () => {
      captured?.beginGithubImport();
    });
    expect(show()).toBe("true");

    await act(async () => {
      captured?.handleGettingStartedModeChange("root");
    });
    // Leaving github mode drops the override; with history the card hides again.
    expect(show()).toBe("false");
  });

  it("does not treat an empty controller-backed conversation as project history", async () => {
    const conversations = [{ controllerId: "controller-1", messages: [] }];
    await act(async () => {
      root.render(
        <Harness
          options={baseOptions({
            conversations,
            isHistoryLoading: true,
          })}
        />,
      );
    });
    expect(show()).toBe("false");

    await act(async () => {
      root.render(
        <Harness
          options={baseOptions({
            conversations,
            isHistoryLoading: false,
          })}
        />,
      );
    });
    expect(captured?.projectHasConversationHistory).toBe(false);
    expect(show()).toBe("true");
  });

  it("does not flash onboarding while remote history presence is unresolved", async () => {
    const unresolvedConversation = {
      controllerId: "controller-1",
      hasRemoteMessages: false,
      messages: [],
    };
    await act(async () => {
      root.render(
        <Harness
          options={baseOptions({
            conversations: [unresolvedConversation],
            remoteHistoryPresenceResolved: false,
          })}
        />,
      );
    });
    expect(show()).toBe("false");

    await act(async () => {
      root.render(
        <Harness
          options={baseOptions({
            conversations: [unresolvedConversation],
            remoteHistoryPresenceResolved: true,
          })}
        />,
      );
    });
    expect(captured?.projectHasConversationHistory).toBe(false);
    expect(show()).toBe("true");

    await act(async () => {
      root.render(
        <Harness
          options={baseOptions({
            conversations: [{ ...unresolvedConversation, hasRemoteMessages: true }],
            remoteHistoryPresenceResolved: true,
          })}
        />,
      );
    });
    expect(captured?.projectHasConversationHistory).toBe(true);
    expect(show()).toBe("false");
  });

  it("uses the controller message summary for unhydrated conversations on a fresh device", async () => {
    await act(async () => {
      root.render(
        <Harness
          options={baseOptions({
            conversations: [
              {
                controllerId: "controller-1",
                hasRemoteMessages: false,
                messages: [],
              },
              {
                controllerId: "controller-2",
                hasRemoteMessages: true,
                messages: [],
              },
            ],
          })}
        />,
      );
    });

    expect(captured?.projectHasConversationHistory).toBe(true);
    expect(show()).toBe("false");
  });

  it("does not persist the previous project's history under the next project during store handoff", async () => {
    const previousProjectConversation = {
      controllerId: "controller-1",
      messages: [
        {
          id: "message-1",
          role: "user",
          content: "Existing project history",
          timestamp: Date.now(),
        } as never,
      ],
    };
    await act(async () => {
      root.render(
        <Harness
          options={baseOptions({
            conversations: [previousProjectConversation],
            displayedMessageCount: 1,
          })}
        />,
      );
    });
    expect(window.localStorage.getItem("instafy.onboarding.projectHasMessages:user-1:proj-1")).toBe("1");

    await act(async () => {
      root.render(
        <Harness
          options={baseOptions({
            activeConversationId: "conv-2",
            activeProjectId: "proj-2",
            conversationsProjectKey: "proj-1",
            conversations: [previousProjectConversation],
            displayedMessageCount: 1,
          })}
        />,
      );
    });

    expect(show()).toBe("false");
    expect(captured?.projectHasConversationHistory).toBe(false);
    expect(
      window.localStorage.getItem("instafy.onboarding.projectHasMessages:user-1:proj-2"),
    ).toBeNull();

    await act(async () => {
      root.render(
        <Harness
          options={baseOptions({
            activeConversationId: "conv-2",
            activeProjectId: "proj-2",
            conversationsProjectKey: "proj-2",
            conversations: [{ controllerId: "controller-2", messages: [] }],
            displayedMessageCount: 0,
          })}
        />,
      );
    });

    expect(captured?.projectHasConversationHistory).toBe(false);
    expect(show()).toBe("true");
    expect(
      window.localStorage.getItem("instafy.onboarding.projectHasMessages:user-1:proj-2"),
    ).toBeNull();
  });

  it("remembers hydrated history after switching to an empty conversation", async () => {
    await act(async () => {
      root.render(<Harness options={baseOptions({ displayedMessageCount: 1 })} />);
    });
    expect(show()).toBe("false");

    await act(async () => {
      root.render(<Harness options={baseOptions({ displayedMessageCount: 0 })} />);
    });
    expect(captured?.projectHasConversationHistory).toBe(true);
    expect(show()).toBe("false");
  });

  it("lets a power-user draft collapse discovery without completing it", async () => {
    const onInputChange = vi.fn();
    await act(async () => {
      root.render(<Harness options={baseOptions({ onInputChange })} />);
    });
    expect(show()).toBe("true");

    await act(async () => {
      root.render(
        <Harness
          options={baseOptions({
            inputValue: "Refactor the payments flow",
            onInputChange,
          })}
        />,
      );
    });
    expect(show()).toBe("false");
    expect(captured?.projectHasConversationHistory).toBe(false);
    expect(onInputChange).not.toHaveBeenCalled();

    await act(async () => {
      root.render(<Harness options={baseOptions({ onInputChange })} />);
    });
    expect(show()).toBe("true");
  });

  it("treats a visible message as completed project onboarding", async () => {
    await act(async () => {
      root.render(
        <Harness
          options={baseOptions({
            conversations: [
              {
                controllerId: "controller-1",
                messages: [
                  {
                    id: "message-1",
                    role: "user",
                    content: "Ship the smallest useful version.",
                    timestamp: Date.now(),
                  } as never,
                ],
              },
            ],
          })}
        />,
      );
    });
    expect(captured?.projectHasConversationHistory).toBe(true);
    expect(show()).toBe("false");
  });

  it("keeps discovery visible and the composer unlocked while AI requirements load", async () => {
    await act(async () => {
      root.render(
        <Harness
          options={baseOptions({
            credentialGateState: "checking",
            credentialsReady: false,
          })}
        />,
      );
    });

    expect(show()).toBe("true");
    expect(captured?.onboardingInputLocked).toBe(false);
  });
});
