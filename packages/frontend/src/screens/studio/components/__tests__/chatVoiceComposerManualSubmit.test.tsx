// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatVoiceComposerController } from "../useChatVoiceComposerController";

// A dictated turn into an empty composer is sent by itself, with its words as
// an override. ChatPanel sets `manualSubmitOnly` while an engine is chosen for
// the next message (docs/Local-Engine-Turns.md 5.2), because such a send never
// carries the choice: the words then stay in the composer for the person's own
// Send, which the engine routes or blocks. The capture itself is faked here;
// every hook it needs returns stable functions, as the real ones do.

const TRANSCRIPT = "fix the failing login test";

const voice = vi.hoisted(() => {
  const state = {
    starting: false,
    listening: false,
    transcribing: false,
    liveTranscript: "",
    completedTranscript: "",
  };
  return {
    state,
    start: async () => {
      state.listening = true;
      return true;
    },
    stop: async () => "",
    cancel: () => {},
    clearTranscript: () => {
      state.liveTranscript = "";
      state.completedTranscript = "";
    },
  };
});

vi.mock("../../../../voice/useVoiceTurnController", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../voice/useVoiceTurnController")>()),
  useVoiceTurnController: () => ({
    supported: true,
    hostedCaptureSupported: false,
    effectiveMode: "device",
    useHostedVoiceCapture: false,
    capture: "device",
    backendKind: "browser",
    backendLabel: null,
    backendConfigPresent: false,
    mediaRecorderSupported: false,
    backendResolutionStatus: "ready",
    backendResolutionError: null,
    state: voice.state.listening ? "listening" : "idle",
    starting: voice.state.starting,
    listening: voice.state.listening,
    transcribing: voice.state.transcribing,
    error: null,
    liveTranscript: voice.state.liveTranscript,
    completedTranscript: voice.state.completedTranscript,
    hostedTestCaptureConfigured: false,
    start: voice.start,
    stop: voice.stop,
    cancel: voice.cancel,
    clearTranscript: voice.clearTranscript,
    isBenignNoSpeechError: () => false,
  }),
}));

const stable = vi.hoisted(() => ({
  noop: () => {},
  falseValue: () => false,
  setMode: () => {},
  emptyQueue: [] as never[],
  debugState: {},
}));

vi.mock("../../../../voice/useChatVoicePreferencesState", () => ({
  useChatVoicePreferencesState: () => ({
    voiceRepliesEnabled: false,
    chatVoiceInteractionMode: "hold",
    chatWakeWordArmed: false,
    setVoiceRepliesEnabled: stable.noop,
    setChatVoiceInteractionMode: stable.setMode,
    setChatWakeWordArmed: stable.noop,
    enableVoiceRepliesIfUnconfigured: stable.noop,
  }),
}));

vi.mock("../../../../voice/useContinuousVoiceSession", () => ({
  useContinuousVoiceSession: () => ({
    continuousConversationActive: false,
    continuousAwaitingAssistantReply: false,
    continuousPauseMessage: null,
    clearPauseMessage: stable.noop,
    markTurnStarted: stable.noop,
    markTurnStartFailed: stable.noop,
    reset: stable.noop,
    pause: stable.noop,
    markAwaitingAssistantReply: stable.noop,
    hasAssistantReplyReady: stable.falseValue,
    consumeAssistantReplyIfReady: stable.noop,
    shouldResumeOnForeground: stable.falseValue,
    clearForegroundResume: stable.noop,
  }),
}));

vi.mock("../../../../voice/useVoiceTurnRecovery", () => ({ useVoiceTurnRecovery: () => {} }));

vi.mock("../../../../voice/voiceDebugState", () => ({
  appendVoiceDebugEvent: () => {},
  usePublishVoiceDebugState: () => {},
  useVoiceDebugState: () => stable.debugState,
}));

vi.mock("../../../../audio/useHostAudioDiagnostics", () => ({ useHostAudioDiagnostics: () => ({ value: null }) }));
vi.mock("../../../../audio/useHostAudioSessionState", () => ({ useHostAudioSessionState: () => ({ value: null }) }));

vi.mock("../../../../extensions/providerTriggerQueue", () => ({
  useProviderTriggerQueue: () => stable.emptyQueue,
  clearProviderTriggerQueue: () => {},
  dismissProviderTriggerCandidate: () => {},
}));

type Controller = ReturnType<typeof useChatVoiceComposerController>;

describe("a dictated turn into an empty composer", () => {
  let container: HTMLDivElement;
  let root: Root;
  let controller: Controller | null;
  let invokeSubmitMessage: ReturnType<typeof vi.fn>;
  let onInputChange: ReturnType<typeof vi.fn>;
  let latestInputValueRef: { current: string };

  function Harness({ manualSubmitOnly }: { manualSubmitOnly: boolean }) {
    controller = useChatVoiceComposerController({
      activeConversationId: "conversation-1",
      activeProjectId: "project-1",
      chatInputRef: { current: null },
      imageAttachmentCount: 0,
      inputValue: latestInputValueRef.current,
      invokeSubmitMessage: invokeSubmitMessage as never,
      manualSubmitOnly,
      isAssistantTyping: false,
      latestInputValueRef,
      messages: [],
      onInputChange: onInputChange as never,
      scheduleSubmitMessage: () => {},
      sendingAttachment: false,
      showStatus: () => {},
      touchLikeInput: false,
    });
    return null;
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.assign(voice.state, {
      starting: false,
      listening: false,
      transcribing: false,
      liveTranscript: "",
      completedTranscript: "",
    });
    controller = null;
    invokeSubmitMessage = vi.fn(async () => true);
    onInputChange = vi.fn();
    latestInputValueRef = { current: "" };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function dictate(manualSubmitOnly: boolean) {
    const render = () => root.render(<Harness manualSubmitOnly={manualSubmitOnly} />);
    await act(async () => render());
    // Press and hold the mic, then let go.
    await act(async () => controller?.handleChatVoiceTap());
    await act(async () => render());
    expect(controller?.voiceInputListening).toBe(true);
    await act(async () => controller?.handleChatVoiceTap());
    // The capture ends with the words heard.
    voice.state.listening = false;
    voice.state.completedTranscript = TRANSCRIPT;
    await act(async () => render());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("goes out by itself as usual when nothing holds it for the composer", async () => {
    await dictate(false);
    expect(invokeSubmitMessage).toHaveBeenCalledExactlyOnceWith(
      { message: TRANSCRIPT, editorState: null },
      { allowWhileBusy: false },
    );
  });

  it("stays in the composer for the person's own Send while the composer holds sends for review", async () => {
    await dictate(true);
    expect(invokeSubmitMessage).not.toHaveBeenCalled();
    expect(onInputChange).toHaveBeenLastCalledWith("conversation-1", TRANSCRIPT, null);
    expect(latestInputValueRef.current).toBe(TRANSCRIPT);
  });
});
