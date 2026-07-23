/** @vitest-environment jsdom */

import { act, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedPromptAgentSelection } from "../../../../conversations/assistantMentions";
import { useChatSubmitFlow } from "../useChatSubmitFlow";

type HookOptions = Parameters<typeof useChatSubmitFlow>[0];
type HookResult = ReturnType<typeof useChatSubmitFlow>;

const OCTO_SELECTION: ResolvedPromptAgentSelection = {
  activeHandles: ["octo"],
  explicitMentionedHandles: [],
  mentionedHandles: [],
  targetHandles: ["octo"],
  nextStickyMentionedAgent: null,
  usesDefaultAssistantOnly: true,
};

function Harness({
  options,
  resultRef,
}: {
  options: HookOptions;
  resultRef: MutableRefObject<HookResult | null>;
}) {
  resultRef.current = useChatSubmitFlow(options);
  return null;
}

function createOptions(
  overrides: Partial<HookOptions> = {},
): HookOptions {
  return {
    activeConversationEntry: {
      controllerId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      visibility: "public",
    },
    activeConversationId: "conversation-local",
    activeConversationMessages: [],
    activeOrgId: null,
    activeProjectId: null,
    appendMessages: vi.fn(),
    broadcastTyping: vi.fn(),
    clearComposerAfterQueue: vi.fn(),
    clearComposerIfUnchanged: vi.fn(),
    clearPendingBrowserLaunchMode: vi.fn(),
    createConversation: vi.fn(() => ({ localId: "conversation-local" })),
    createOrgInvitation: vi.fn(),
    credentialsReady: false,
    currentUserId: "user-1",
    effectiveRuntimeId: null,
    enqueueChatSendQueueItem: vi.fn(),
    enqueueServerSendQueueItem: vi.fn(async () => true),
    fetchRuntimeStatus: vi.fn(async () => null),
    focusInput: vi.fn(),
    hasHiddenBrowserSession: false,
    browserSessionOpen: false,
    humanPeerContext: null,
    imageFiles: [],
    isAssistantTyping: true,
    inputEditorState: null,
    inputValue: "Marcus, should we choose option A?",
    interruptConversationRuns: vi.fn(async () => []),
    invitePrompt: null,
    listConversationParticipants: vi.fn(async () => []),
    localTypingStateRef: { current: { isTyping: false, lastSentAt: 0 } },
    onMaybeAutoTitleConversation: vi.fn(),
    onPreparedEmailInvite: vi.fn(),
    onRecordMessage: vi.fn(async () => null),
    openInvitePrompt: vi.fn(),
    openPanelTab: vi.fn(),
    outOfCredits: true,
    pendingBrowserLaunchMode: null,
    pendingTypingBroadcastRef: { current: null },
    performSubmit: vi.fn(async () => undefined),
    personalBrowserActive: false,
    personalBrowserAgentError: null,
    personalBrowserRuntimeOverride: null,
    preferredBrowserPage: null,
    preferredRuntimeId: null,
    revealAiGatesForCurrentDraft: vi.fn(() => true),
    requestRuntimeRecovery: vi.fn(),
    resolveGroupParticipationBeforeSubmit: vi.fn(async ({ metadata }) => ({
      mode: "record_only" as const,
      metadata: {
        ...(metadata ?? {}),
        groupParticipation: {
          decision: "silent",
          domain: "human_directed",
          reason: "directed_to_human",
          confidence: 99,
          participantCount: 2,
          policySkillPath: ".agents/skills/instafy-group-participation/SKILL.md",
        },
        groupParticipationPreflight: { status: "resolved" },
      },
    })),
    resolvePromptAgentTargets: vi.fn(() => OCTO_SELECTION),
    runtimeControllerEnabled: true,
    runtimeReady: false,
    scrollToBottom: vi.fn(),
    sendingAttachment: false,
    sharedBrowserActive: false,
    sharedBrowserRuntimeId: null,
    showCredentialsGate: vi.fn(),
    showStatus: vi.fn(),
    shouldAutoScrollRef: { current: false },
    softPrefillSuggestion: null,
    targetsOverlapActiveRuns: vi.fn(() => true),
    ...overrides,
  };
}

describe("useChatSubmitFlow group participation ordering", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("submits a silent ambient turn without AI gates, runtime recovery, or busy queueing", async () => {
    const options = createOptions();
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => {
      root.render(<Harness options={options} resultRef={resultRef} />);
    });

    await act(async () => {
      await expect(resultRef.current?.submitMessage()).resolves.toBe(true);
    });

    expect(options.resolveGroupParticipationBeforeSubmit).toHaveBeenCalledTimes(1);
    expect(options.requestRuntimeRecovery).not.toHaveBeenCalled();
    expect(options.enqueueServerSendQueueItem).not.toHaveBeenCalled();
    expect(options.enqueueChatSendQueueItem).not.toHaveBeenCalled();
    expect(options.openPanelTab).not.toHaveBeenCalled();
    expect(options.showCredentialsGate).not.toHaveBeenCalled();
    expect(options.onMaybeAutoTitleConversation).not.toHaveBeenCalled();
    expect(options.performSubmit).toHaveBeenCalledTimes(1);
    expect(options.performSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          groupParticipation: expect.objectContaining({ decision: "silent" }),
        }),
      }),
    );
  });

  it("forwards the human peer context to the participation preflight", async () => {
    const resolveParticipation = vi.fn(async ({ metadata }) => ({
      mode: "dispatch" as const,
      metadata: {
        ...(metadata ?? {}),
        groupParticipationPreflight: { status: "single_human" },
      },
    }));
    const options = createOptions({
      credentialsReady: true,
      humanPeerContext: { hasHumanPeer: false, resolved: true },
      isAssistantTyping: false,
      outOfCredits: false,
      resolveGroupParticipationBeforeSubmit: resolveParticipation,
      runtimeReady: true,
      targetsOverlapActiveRuns: vi.fn(() => false),
    });
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => {
      root.render(<Harness options={options} resultRef={resultRef} />);
    });

    await act(async () => {
      await expect(resultRef.current?.submitMessage()).resolves.toBe(true);
    });

    expect(resolveParticipation).toHaveBeenCalledWith(
      expect.objectContaining({
        humanPeerContext: { hasHumanPeer: false, resolved: true },
      }),
    );
    expect(options.performSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          groupParticipationPreflight: { status: "single_human" },
        }),
      }),
    );
  });

  it("keeps the normal AI preflight and submit path for a responding decision", async () => {
    const resolveParticipation = vi.fn(async ({ metadata }) => ({
      mode: "dispatch" as const,
      metadata: {
        ...(metadata ?? {}),
        groupParticipation: {
          decision: "respond",
          domain: "technical",
          reason: "open_technical_question",
          confidence: 99,
          participantCount: 2,
          policySkillPath: ".agents/skills/instafy-group-participation/SKILL.md",
        },
        groupParticipationPreflight: { status: "resolved" },
      },
    }));
    const options = createOptions({
      credentialsReady: true,
      isAssistantTyping: false,
      outOfCredits: false,
      resolveGroupParticipationBeforeSubmit: resolveParticipation,
      runtimeReady: true,
      targetsOverlapActiveRuns: vi.fn(() => false),
    });
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => {
      root.render(<Harness options={options} resultRef={resultRef} />);
    });

    await act(async () => {
      await expect(resultRef.current?.submitMessage()).resolves.toBe(true);
    });

    expect(resolveParticipation).toHaveBeenCalledTimes(1);
    expect(options.performSubmit).toHaveBeenCalledTimes(1);
  });

  it("gates a credentialless responding decision before probing or recovering a runtime", async () => {
    const resolveParticipation = vi.fn(async ({ metadata }) => ({
      mode: "dispatch" as const,
      metadata: {
        ...(metadata ?? {}),
        groupParticipation: {
          decision: "respond",
          domain: "technical",
          reason: "open_technical_question",
          confidence: 99,
          participantCount: 2,
          policySkillPath: ".agents/skills/instafy-group-participation/SKILL.md",
        },
        groupParticipationPreflight: { status: "resolved" },
      },
    }));
    const options = createOptions({
      activeProjectId: "project-1",
      credentialsReady: false,
      fetchRuntimeStatus: vi.fn(async () => ({
        preferredRuntimeId: null,
        runtimes: [],
      })),
      isAssistantTyping: false,
      outOfCredits: true,
      resolveGroupParticipationBeforeSubmit: resolveParticipation,
      runtimeReady: false,
      targetsOverlapActiveRuns: vi.fn(() => false),
    });
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => {
      root.render(<Harness options={options} resultRef={resultRef} />);
    });

    await act(async () => {
      await expect(resultRef.current?.submitMessage()).resolves.toBe(false);
    });

    expect(resolveParticipation).toHaveBeenCalledTimes(1);
    expect(options.showCredentialsGate).toHaveBeenCalledTimes(1);
    expect(options.openPanelTab).not.toHaveBeenCalled();
    expect(options.fetchRuntimeStatus).not.toHaveBeenCalled();
    expect(options.requestRuntimeRecovery).not.toHaveBeenCalled();
    expect(options.enqueueServerSendQueueItem).not.toHaveBeenCalled();
    expect(options.enqueueChatSendQueueItem).not.toHaveBeenCalled();
    expect(options.performSubmit).not.toHaveBeenCalled();
  });

  it("reveals AI gates for an out-of-credits responding decision before opening credits", async () => {
    const resolveParticipation = vi.fn(async ({ metadata }) => ({
      mode: "dispatch" as const,
      metadata: {
        ...(metadata ?? {}),
        groupParticipation: {
          decision: "respond",
          domain: "technical",
          reason: "open_technical_question",
          confidence: 99,
          participantCount: 2,
          policySkillPath: ".agents/skills/instafy-group-participation/SKILL.md",
        },
        groupParticipationPreflight: { status: "resolved" },
      },
    }));
    const options = createOptions({
      activeProjectId: "project-1",
      credentialsReady: true,
      isAssistantTyping: false,
      outOfCredits: true,
      resolveGroupParticipationBeforeSubmit: resolveParticipation,
      runtimeReady: false,
      targetsOverlapActiveRuns: vi.fn(() => false),
    });
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => {
      root.render(<Harness options={options} resultRef={resultRef} />);
    });

    await act(async () => {
      await expect(resultRef.current?.submitMessage()).resolves.toBe(false);
    });

    expect(resolveParticipation).toHaveBeenCalledTimes(1);
    expect(options.revealAiGatesForCurrentDraft).toHaveBeenCalledTimes(1);
    expect(options.openPanelTab).toHaveBeenCalledWith("credits", { activate: true });
    expect(options.fetchRuntimeStatus).not.toHaveBeenCalled();
    expect(options.requestRuntimeRecovery).not.toHaveBeenCalled();
    expect(options.performSubmit).not.toHaveBeenCalled();
  });

  it("coalesces repeated sends while ambient participation is resolving", async () => {
    let resolveParticipation:
      | ((value: Awaited<ReturnType<HookOptions["resolveGroupParticipationBeforeSubmit"]>>) => void)
      | null = null;
    const participationPromise = new Promise<
      Awaited<ReturnType<HookOptions["resolveGroupParticipationBeforeSubmit"]>>
    >((resolve) => {
      resolveParticipation = resolve;
    });
    const resolveGroupParticipationBeforeSubmit = vi.fn(() => participationPromise);
    const options = createOptions({ resolveGroupParticipationBeforeSubmit });
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => {
      root.render(<Harness options={options} resultRef={resultRef} />);
    });

    let firstSubmit: Promise<boolean> | undefined;
    await act(async () => {
      firstSubmit = resultRef.current?.submitMessage();
      await expect(resultRef.current?.submitMessage()).resolves.toBe(false);
    });

    expect(resultRef.current?.submissionPending).toBe(true);
    expect(resolveGroupParticipationBeforeSubmit).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveParticipation?.({
        mode: "record_only",
        metadata: {
          groupParticipation: {
            decision: "silent",
            domain: "human_directed",
            reason: "directed_to_human",
            confidence: 99,
            participantCount: 2,
            policySkillPath: ".agents/skills/instafy-group-participation/SKILL.md",
          },
          groupParticipationPreflight: { status: "resolved" },
        },
      });
      await expect(firstSubmit).resolves.toBe(true);
    });

    expect(resultRef.current?.submissionPending).toBe(false);
    expect(options.performSubmit).toHaveBeenCalledTimes(1);
  });

  it("queues a generic controller-deferred turn behind the active Octo run", async () => {
    const resolveParticipation = vi.fn(async ({ metadata }) => ({
      mode: "controller_deferred" as const,
      metadata: {
        ...(metadata ?? {}),
        groupParticipationPreflight: { status: "controller_deferred" },
      },
    }));
    const options = createOptions({
      resolveGroupParticipationBeforeSubmit: resolveParticipation,
    });
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => {
      root.render(<Harness options={options} resultRef={resultRef} />);
    });

    await act(async () => {
      await expect(resultRef.current?.submitMessage()).resolves.toBe(false);
    });

    expect(options.enqueueServerSendQueueItem).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAgentHandles: ["octo"],
        metadata: expect.objectContaining({
          groupParticipationPreflight: { status: "controller_deferred" },
        }),
      }),
    );
    expect(options.enqueueChatSendQueueItem).not.toHaveBeenCalled();
    expect(options.requestRuntimeRecovery).not.toHaveBeenCalled();
    expect(options.openPanelTab).not.toHaveBeenCalled();
    expect(options.performSubmit).not.toHaveBeenCalled();
  });

  it("dispatches a generic controller-deferred turn when no run is active", async () => {
    const resolveParticipation = vi.fn(async ({ metadata }) => ({
      mode: "controller_deferred" as const,
      metadata: {
        ...(metadata ?? {}),
        groupParticipationPreflight: { status: "controller_deferred" },
      },
    }));
    const options = createOptions({
      isAssistantTyping: false,
      resolveGroupParticipationBeforeSubmit: resolveParticipation,
      targetsOverlapActiveRuns: vi.fn(() => false),
    });
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => {
      root.render(<Harness options={options} resultRef={resultRef} />);
    });

    await act(async () => {
      await expect(resultRef.current?.submitMessage()).resolves.toBe(true);
    });

    expect(options.enqueueServerSendQueueItem).not.toHaveBeenCalled();
    expect(options.requestRuntimeRecovery).not.toHaveBeenCalled();
    expect(options.openPanelTab).not.toHaveBeenCalled();
    expect(options.performSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          groupParticipationPreflight: { status: "controller_deferred" },
        }),
      }),
    );
  });

  it("dispatches authoritative coverage immediately despite an active Octo run", async () => {
    const resolveParticipation = vi.fn(async ({ metadata }) => ({
      mode: "controller_coverage" as const,
      metadata: {
        ...(metadata ?? {}),
        groupParticipation: {
          decision: "silent",
          domain: "arithmetic",
          reason: "incorrect_arithmetic_follow_up_covered_by_active_octo",
          coveredRunId: "run-1",
          coveredJobId: "job-1",
          coverage: "await_active_octo",
        },
        groupParticipationPreflight: { status: "controller_coverage" },
      },
    }));
    const options = createOptions({
      resolveGroupParticipationBeforeSubmit: resolveParticipation,
    });
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => {
      root.render(<Harness options={options} resultRef={resultRef} />);
    });

    await act(async () => {
      await expect(resultRef.current?.submitMessage()).resolves.toBe(true);
    });

    expect(options.enqueueServerSendQueueItem).not.toHaveBeenCalled();
    expect(options.enqueueChatSendQueueItem).not.toHaveBeenCalled();
    expect(options.requestRuntimeRecovery).not.toHaveBeenCalled();
    expect(options.openPanelTab).not.toHaveBeenCalled();
    expect(options.performSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          groupParticipation: expect.objectContaining({
            coverage: "await_active_octo",
          }),
          groupParticipationPreflight: { status: "controller_coverage" },
        }),
      }),
    );
  });

  it("bypasses arbitration and preserves Personal Browser routing", async () => {
    const resolveParticipation = vi.fn(async ({ metadata, hasBrowserTask }) => ({
      mode: "unchanged" as const,
      metadata: {
        ...(metadata ?? {}),
        groupParticipationPreflight: {
          status: hasBrowserTask ? "bypassed" : "resolved",
        },
      },
    }));
    const runtimeOverride = {
      runtimeId: "desktop-runtime",
      runtimeDisplayName: "This Mac",
      preferRuntime: true,
    };
    const options = createOptions({
      activeProjectId: "project-1",
      credentialsReady: true,
      fetchRuntimeStatus: vi.fn(async () => ({
        preferredRuntimeId: "desktop-runtime",
        runtimes: [
          {
            runtimeId: "desktop-runtime",
            status: "ready",
            provider: "desktop",
            idleTtlSeconds: 3600,
            isLocal: true,
            isPreferred: true,
            health: "online" as const,
          },
        ],
      })),
      inputValue: "click the blue button",
      isAssistantTyping: false,
      outOfCredits: false,
      personalBrowserActive: true,
      personalBrowserRuntimeOverride: runtimeOverride,
      resolveGroupParticipationBeforeSubmit: resolveParticipation,
      runtimeReady: true,
      targetsOverlapActiveRuns: vi.fn(() => false),
    });
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => {
      root.render(<Harness options={options} resultRef={resultRef} />);
    });

    await act(async () => {
      await expect(resultRef.current?.submitMessage()).resolves.toBe(true);
    });

    expect(resolveParticipation).toHaveBeenCalledWith(
      expect.objectContaining({ hasBrowserTask: true }),
    );
    expect(options.performSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeOverride,
        metadata: expect.objectContaining({
          browserTransport: "desktop-personal",
          groupParticipationPreflight: { status: "bypassed" },
        }),
      }),
    );
  });

  it("bypasses arbitration and preserves Shared Browser routing", async () => {
    const resolveParticipation = vi.fn(async ({ metadata, hasBrowserTask }) => ({
      mode: "unchanged" as const,
      metadata: {
        ...(metadata ?? {}),
        groupParticipationPreflight: {
          status: hasBrowserTask ? "bypassed" : "resolved",
        },
      },
    }));
    const options = createOptions({
      activeProjectId: "project-1",
      credentialsReady: true,
      fetchRuntimeStatus: vi.fn(async () => ({
        preferredRuntimeId: "shared-runtime",
        runtimes: [
          {
            runtimeId: "shared-runtime",
            status: "ready",
            provider: "hosted",
            idleTtlSeconds: 3600,
            isLocal: false,
            isPreferred: true,
            health: "online" as const,
          },
        ],
      })),
      inputValue: "click the blue button",
      isAssistantTyping: false,
      outOfCredits: false,
      resolveGroupParticipationBeforeSubmit: resolveParticipation,
      runtimeReady: true,
      sharedBrowserActive: true,
      sharedBrowserRuntimeId: "shared-runtime",
      targetsOverlapActiveRuns: vi.fn(() => false),
    });
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => {
      root.render(<Harness options={options} resultRef={resultRef} />);
    });

    await act(async () => {
      await expect(resultRef.current?.submitMessage()).resolves.toBe(true);
    });

    expect(resolveParticipation).toHaveBeenCalledWith(
      expect.objectContaining({ hasBrowserTask: true }),
    );
    expect(options.performSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeOverride: expect.objectContaining({
          runtimeId: "shared-runtime",
          preferRuntime: true,
        }),
        metadata: expect.objectContaining({
          browserTransport: "shared",
          browserRuntimeId: "shared-runtime",
          groupParticipationPreflight: { status: "bypassed" },
        }),
      }),
    );
  });
});
