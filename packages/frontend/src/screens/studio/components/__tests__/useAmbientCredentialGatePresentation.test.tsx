/** @vitest-environment jsdom */

import { act, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveChatComposerAffordances } from "../chatComposerAffordances";
import { useAmbientCredentialGatePresentation } from "../useAmbientCredentialGatePresentation";

type HookOptions = Parameters<typeof useAmbientCredentialGatePresentation>[0];
type HookResult = ReturnType<typeof useAmbientCredentialGatePresentation>;

function Harness({
  options,
  resultRef,
}: {
  options: HookOptions;
  resultRef: MutableRefObject<HookResult | null>;
}) {
  resultRef.current = useAmbientCredentialGatePresentation(options);
  return null;
}

function resolveOutOfCreditsSendDisabled(result: HookResult | null) {
  return resolveChatComposerAffordances({
    composerGhostSuggestionRemainder: null,
    credentialsReady: true,
    activeConversationControllerId: "controller-1",
    imageAttachmentCount: 0,
    deferAiGatesForAmbientParticipation:
      result?.deferAiGatesForAmbientParticipation ?? false,
    inputRequiresAi: true,
    inputValue: "How does this API work?",
    onboardingInputLocked: false,
    outOfCredits: true,
    runtimeControllerEnabled: true,
    queueStatusLabel: null,
    sendingAttachment: false,
    submissionPending: false,
    totalQueuedCount: 0,
    voiceHoldActive: false,
    voiceInputListening: false,
    voiceInputStarting: false,
    voiceInputTranscribing: false,
  }).sendButtonDisabled;
}

describe("useAmbientCredentialGatePresentation", () => {
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

  it("does not reveal an old draft's credential gate after the draft changes", async () => {
    const pinCredentialGateToBottom = vi.fn();
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    const options: HookOptions = {
      activeConversationId: "conversation-1",
      credentialGateState: "missing",
      credentialGateStateForBubble: "missing",
      fallbackSuggestion: null,
      inputCanRunAmbientParticipationPreflight: true,
      inputValue: "Taylor, what do you think?",
      pinCredentialGateToBottom,
    };

    await act(async () => {
      root.render(<Harness options={options} resultRef={resultRef} />);
    });
    const oldDraftShowCredentialsGate = resultRef.current?.showCredentialsGate;

    await act(async () => {
      root.render(
        <Harness
          options={{ ...options, inputValue: "@octo explain this error" }}
          resultRef={resultRef}
        />,
      );
    });
    await act(async () => {
      oldDraftShowCredentialsGate?.();
    });

    expect(pinCredentialGateToBottom).not.toHaveBeenCalled();
    expect(resultRef.current?.credentialGateState).toBeNull();
    expect(resultRef.current?.credentialGateStateForBubble).toBeNull();
  });

  it("reveals the gate only for the current ambient draft", async () => {
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    const options: HookOptions = {
      activeConversationId: "conversation-1",
      credentialGateState: "missing",
      credentialGateStateForBubble: "missing",
      fallbackSuggestion: null,
      inputCanRunAmbientParticipationPreflight: true,
      inputValue: "How does this API work?",
      pinCredentialGateToBottom: vi.fn(),
    };

    await act(async () => {
      root.render(<Harness options={options} resultRef={resultRef} />);
    });
    expect(resultRef.current?.credentialGateStateForBubble).toBeNull();
    expect(resultRef.current?.deferAiGatesForAmbientParticipation).toBe(true);

    await act(async () => {
      resultRef.current?.showCredentialsGate();
    });

    expect(resultRef.current?.credentialGateState).toBe("missing");
    expect(resultRef.current?.credentialGateStateForBubble).toBe("missing");
    expect(resultRef.current?.deferAiGatesForAmbientParticipation).toBe(false);
  });

  it("keeps an unchanged out-of-credits ambient draft revealed and disabled", async () => {
    const pinCredentialGateToBottom = vi.fn();
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    const options: HookOptions = {
      activeConversationId: "conversation-1",
      credentialGateState: null,
      credentialGateStateForBubble: null,
      fallbackSuggestion: null,
      inputCanRunAmbientParticipationPreflight: true,
      inputValue: "How does this API work?",
      pinCredentialGateToBottom,
    };

    await act(async () => {
      root.render(<Harness options={options} resultRef={resultRef} />);
    });
    expect(resolveOutOfCreditsSendDisabled(resultRef.current)).toBe(false);

    await act(async () => {
      expect(resultRef.current?.revealAiGatesForCurrentDraft()).toBe(true);
    });

    expect(resultRef.current?.deferAiGatesForAmbientParticipation).toBe(false);
    expect(resolveOutOfCreditsSendDisabled(resultRef.current)).toBe(true);
    expect(pinCredentialGateToBottom).not.toHaveBeenCalled();

    await act(async () => {
      root.render(<Harness options={options} resultRef={resultRef} />);
    });
    expect(resultRef.current?.deferAiGatesForAmbientParticipation).toBe(false);
    expect(resolveOutOfCreditsSendDisabled(resultRef.current)).toBe(true);

    await act(async () => {
      root.render(
        <Harness
          options={{ ...options, inputValue: "What changed in this other draft?" }}
          resultRef={resultRef}
        />,
      );
    });
    expect(resultRef.current?.deferAiGatesForAmbientParticipation).toBe(true);
    expect(resolveOutOfCreditsSendDisabled(resultRef.current)).toBe(false);
  });

  it("does not inherit a reveal across ghost suggestions or conversations", async () => {
    const pinCredentialGateToBottom = vi.fn();
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    const options: HookOptions = {
      activeConversationId: "conversation-1",
      credentialGateState: "missing",
      credentialGateStateForBubble: "missing",
      fallbackSuggestion: "Ask Taylor for a decision",
      inputCanRunAmbientParticipationPreflight: true,
      inputValue: "",
      pinCredentialGateToBottom,
    };

    await act(async () => {
      root.render(<Harness options={options} resultRef={resultRef} />);
    });
    const oldSuggestionShowCredentialsGate = resultRef.current?.showCredentialsGate;

    await act(async () => {
      root.render(
        <Harness
          options={{
            ...options,
            activeConversationId: "conversation-2",
            fallbackSuggestion: "Explain the failing build",
          }}
          resultRef={resultRef}
        />,
      );
    });
    await act(async () => {
      oldSuggestionShowCredentialsGate?.();
    });

    expect(pinCredentialGateToBottom).not.toHaveBeenCalled();
    expect(resultRef.current?.credentialGateState).toBeNull();
    expect(resultRef.current?.credentialGateStateForBubble).toBeNull();
  });
});
