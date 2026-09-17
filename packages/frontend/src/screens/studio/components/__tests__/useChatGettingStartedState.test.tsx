// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ONBOARDING_PATHS } from "../onboardingPlaybook";
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
      <span data-testid="collapsed">{String(captured.gettingStartedCollapsed)}</span>
      <span data-testid="placeholder">{captured.gettingStartedComposerPlaceholder ?? ""}</span>
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
  function collapsed() {
    return container.querySelector('[data-testid="collapsed"]')?.textContent;
  }
  function placeholder() {
    return container.querySelector('[data-testid="placeholder"]')?.textContent;
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

  it("collapses the card to its one-line row while a draft exists and restores it when the draft clears", async () => {
    const onInputChange = vi.fn();
    await act(async () => {
      root.render(<Harness options={baseOptions({ onInputChange })} />);
    });
    expect(show()).toBe("true");
    expect(collapsed()).toBe("false");

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
    // Still shown, folded: the options stay reachable while typing.
    expect(show()).toBe("true");
    expect(collapsed()).toBe("true");
    expect(captured?.projectHasConversationHistory).toBe(false);
    expect(onInputChange).not.toHaveBeenCalled();

    // Whitespace is not a draft.
    await act(async () => {
      root.render(<Harness options={baseOptions({ inputValue: "   ", onInputChange })} />);
    });
    expect(collapsed()).toBe("false");

    await act(async () => {
      root.render(<Harness options={baseOptions({ onInputChange })} />);
    });
    expect(show()).toBe("true");
    expect(collapsed()).toBe("false");
  });

  it("keeps the credential gate, history loading, dismissal and history ahead of the collapsed row", async () => {
    await act(async () => {
      root.render(<Harness options={baseOptions({ inputValue: "hello", credentialGateState: "missing" })} />);
    });
    expect(show()).toBe("false");
    expect(collapsed()).toBe("false");

    await act(async () => {
      root.render(<Harness options={baseOptions({ inputValue: "hello", isHistoryLoading: true })} />);
    });
    expect(show()).toBe("false");

    await act(async () => {
      root.render(<Harness options={baseOptions({ inputValue: "hello" })} />);
    });
    expect(collapsed()).toBe("true");
    await act(async () => {
      captured?.dismissGettingStarted();
    });
    expect(show()).toBe("false");
    expect(collapsed()).toBe("false");

    // History (remembered per space) hides the row for good, draft or not.
    window.localStorage.clear();
    await act(async () => {
      root.render(
        <Harness options={baseOptions({ inputValue: "hello", displayedMessageCount: 2 })} />,
      );
    });
    expect(show()).toBe("false");
    expect(collapsed()).toBe("false");
  });

  it("keeps the GitHub mode open over a draft instead of folding it", async () => {
    await act(async () => {
      root.render(<Harness options={baseOptions({ inputValue: "hello" })} />);
    });
    expect(collapsed()).toBe("true");

    await act(async () => {
      captured?.handleGettingStartedModeChange("github");
    });
    expect(show()).toBe("true");
    expect(collapsed()).toBe("false");
    expect(mode()).toBe("github");

    await act(async () => {
      captured?.handleGettingStartedModeChange("root");
    });
    expect(collapsed()).toBe("true");
  });

  it("turns Start from scratch into a composer question: no template, nothing inserted, composer focused", async () => {
    const onInputChange = vi.fn();
    const composer = document.createElement("textarea");
    composer.id = "studio-chat-input";
    document.body.appendChild(composer);
    try {
      await act(async () => {
        root.render(<Harness options={baseOptions({ onInputChange })} />);
      });
      expect(placeholder()).toBe("");

      const scratch = ONBOARDING_PATHS.find((path) => path.id === "coding")!.actions.find(
        (action) => action.id === "start-from-scratch",
      )!;
      expect(scratch.kind).toBe("compose");
      expect(scratch.prompt).toBeUndefined();
      await act(async () => {
        captured?.handleGettingStartedAction(scratch);
      });

      // The composer stays empty (so send stays disabled) and asks instead.
      expect(onInputChange).not.toHaveBeenCalled();
      expect(placeholder()).toBe("What do you want to build? One sentence is enough.");
      expect(placeholder()).not.toContain("describe it here");
      expect(document.activeElement).toBe(composer);
      expect(show()).toBe("true");
      expect(collapsed()).toBe("false");
      expect(mode()).toBe("root");

      // Typing folds the card; the question stays until the message is sent.
      await act(async () => {
        root.render(<Harness options={baseOptions({ inputValue: "A habit tracker", onInputChange })} />);
      });
      expect(collapsed()).toBe("true");
      expect(placeholder()).toBe("What do you want to build? One sentence is enough.");

      // Sent: the card is gone and the usual placeholder returns.
      await act(async () => {
        root.render(<Harness options={baseOptions({ displayedMessageCount: 1, onInputChange })} />);
      });
      expect(show()).toBe("false");
      expect(placeholder()).toBe("");
    } finally {
      composer.remove();
    }
  });

  it("drops the Start from scratch question when the conversation changes", async () => {
    await act(async () => {
      root.render(<Harness options={baseOptions()} />);
    });
    const scratch = ONBOARDING_PATHS.find((path) => path.id === "coding")!.actions.find(
      (action) => action.id === "start-from-scratch",
    )!;
    await act(async () => {
      captured?.handleGettingStartedAction(scratch);
    });
    expect(placeholder()).not.toBe("");

    await act(async () => {
      root.render(<Harness options={baseOptions({ activeConversationId: "conv-2" })} />);
    });
    expect(placeholder()).toBe("");
  });

  it("selects an existing draft when Start from scratch is pressed from the collapsed row", async () => {
    const onInputChange = vi.fn();
    const focusComposer = vi.fn();
    const scratch = ONBOARDING_PATHS.find((path) => path.id === "coding")!.actions.find(
      (action) => action.id === "start-from-scratch",
    )!;

    await act(async () => {
      root.render(
        <Harness options={baseOptions({ inputValue: "A habit tracker", onInputChange, focusComposer })} />,
      );
    });
    expect(collapsed()).toBe("true");
    await act(async () => {
      captured?.handleGettingStartedAction(scratch);
    });
    // The draft is selected (typing replaces it), never rewritten by the hook.
    expect(focusComposer).toHaveBeenCalledTimes(1);
    expect(focusComposer).toHaveBeenCalledWith({ selectAll: true });
    expect(onInputChange).not.toHaveBeenCalled();
    expect(placeholder()).toBe("What do you want to build? One sentence is enough.");

    // An empty composer is plainly focused: nothing to select.
    focusComposer.mockClear();
    await act(async () => {
      root.render(<Harness options={baseOptions({ onInputChange, focusComposer })} />);
    });
    await act(async () => {
      captured?.handleGettingStartedAction(scratch);
    });
    expect(focusComposer).toHaveBeenCalledWith({ selectAll: false });
    expect(onInputChange).not.toHaveBeenCalled();
  });

  it("still prefills the composer for a prompt action", async () => {
    const onInputChange = vi.fn();
    await act(async () => {
      root.render(<Harness options={baseOptions({ onInputChange })} />);
    });
    const buildWithCode = ONBOARDING_PATHS.find((path) => path.id === "coding")!.actions.find(
      (action) => action.id === "build-with-code",
    )!;
    await act(async () => {
      captured?.handleGettingStartedAction(buildWithCode);
    });
    expect(onInputChange).toHaveBeenCalledWith("conv-1", buildWithCode.prompt, null);
    expect(placeholder()).toBe("");
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
