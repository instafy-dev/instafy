import { Capacitor } from "@capacitor/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useConversation, Button, useProject } from "@instafy/frontend/feature-api/ui";
import {
  getDefaultEmbodiedAgentHandle,
} from "../robot";
import { getKnoshRuntimeAdapter } from "../robot/knoshRuntimeAdapter";
import { setNativeKnoshKeepScreenOn } from "../robot/nativeKnoshDiagnosticsBridge";
import { applyPageMeta, useStatus } from "@instafy/frontend/feature-api/ui";
import {
  HostHandsFreeVoiceNotice,
  HostMicrophonePermissionNotice,
  isBenignNoSpeechVoiceInputError,
  shouldShowHostMicrophonePermissionNotice,
  useHostAudioDiagnostics,
  useHostMicrophonePermissionAction,
} from "@instafy/frontend/feature-api/voice";
import {
  inferKnoshRuntimeOrientation,
  KNOSH_RUNTIME_ONBOARDING_STORAGE_KEY,
  readKnoshVoiceInteractionMode,
  selectKnoshFaceMood,
  type KnoshRuntimeInteractionMode,
  type KnoshRuntimeOrientation,
  type KnoshVoiceInteractionMode,
  writeKnoshVoiceInteractionMode,
} from "./knoshRuntimeState";
import type { ProjectSpeechMode } from "@instafy/frontend/feature-api/voice";
import {
  useProjectSpeechCapabilityState,
  useProjectSpeechPreferencesState,
  useVoiceTurnController,
  useVoiceTurnRecovery,
} from "@instafy/frontend/feature-api/voice";
import {
  usePublishVoiceDebugState,
} from "@instafy/frontend/feature-api/voice";
import {
  selectSpeechReplyBackendPreference,
  useSpeechReplyPlayback,
} from "@instafy/frontend/feature-api/voice";
import {
  findLatestDisplayableAssistantReply,
  findLatestSpeakableAssistantReply,
  resolveSpeechReplyPlaybackKey,
} from "@instafy/frontend/feature-api/voice";
import {
  useContinuousVoiceSession,
  useVoiceConversationLoop,
  VoiceDiagnosticsDisclosure,
  useVoiceSurfaceState,
} from "@instafy/frontend/feature-api/voice";
import {
  installVoiceScenarioWindowApi,
  type VisionObservation,
} from "../robot/voiceScenarioDriver";
import { subscribeVisionObservations } from "@instafy/frontend/feature-api/runtime";
import { KnoshFaceCanvas } from "./knosh-runtime/KnoshFaceCanvas";
import { useKnoshRuntimeActionController } from "./knosh-runtime/useKnoshRuntimeActionController";
import { useKnoshRuntimeHardwareState } from "./knosh-runtime/useKnoshRuntimeHardwareState";
import { useKnoshSpeechBootstrapState } from "./knosh-runtime/useKnoshSpeechBootstrapState";
import {
  KnoshTransportStatusNotice,
  resolveKnoshTransportAlert,
} from "./knosh-runtime/KnoshTransportStatusNotice";
import { KNOSH_ROBOT_LAB_ENABLED } from "../developmentFlags";

type RuntimeActionPreset = {
  label: string;
  prompt: string;
};

const QUICK_ACTIONS: RuntimeActionPreset[] = [
  { label: "Wake up", prompt: "wake up" },
  { label: "Look at me", prompt: "look at me" },
  { label: "Sleep", prompt: "sleep" },
  { label: "Stop", prompt: "stop" },
];

function getViewportOrientation(): KnoshRuntimeOrientation {
  if (typeof window === "undefined") {
    return "portrait";
  }
  return inferKnoshRuntimeOrientation(window.innerWidth, window.innerHeight);
}

export function KnoshRuntimePage() {
  const { activeProjectId, activeProjectName } = useProject();
  const { showStatus } = useStatus();
  const defaultEmbodiedHandle = getDefaultEmbodiedAgentHandle();
  const runtimeAdapter = useMemo(() => getKnoshRuntimeAdapter(Capacitor.getPlatform()), []);
  const [orientation, setOrientation] = useState<KnoshRuntimeOrientation>(getViewportOrientation);
  const [voiceRepliesEnabled, setVoiceRepliesEnabled] = useState(true);
  const [interactionMode, setInteractionMode] = useState<KnoshRuntimeInteractionMode>("conversation");
  const [voiceInteractionMode, setVoiceInteractionMode] =
    useState<KnoshVoiceInteractionMode>("hold");
  const [showOnboardingGuide, setShowOnboardingGuide] = useState(false);
  const setActionErrorRef = useRef<(message: string | null) => void>(() => undefined);
  const setRuntimeStatusTextRef = useRef<(message: string) => void>(() => undefined);
  const {
    activeConversationId,
    messages,
    onSubmit: submitConversationPrompt,
    isAssistantTyping,
    isWorkspaceSettingUp,
  } = useConversation();
  const { value: hostAudioDiagnostics, refresh: refreshHostAudioDiagnostics } = useHostAudioDiagnostics({
    enabled: true,
    refreshIntervalMs: 15000,
  });
  const {
    requesting: microphonePermissionRequesting,
    error: microphonePermissionRequestError,
    requestPermission: requestMicrophonePermission,
  } = useHostMicrophonePermissionAction({
    refresh: refreshHostAudioDiagnostics,
  });
  const {
    mode: speechMode,
    providerVoiceId,
    deviceVoiceId,
    setMode: setProjectSpeechMode,
  } = useProjectSpeechPreferencesState(activeProjectId);
  const {
    speechDependencyStatus,
    setSpeechDependencyStatus,
    refresh: refreshSpeechDependencies,
  } = useProjectSpeechCapabilityState({
    projectId: activeProjectId,
    enabled: true,
    providerVoiceId,
    deviceVoiceId,
  });
  const {
    connected,
    deviceStatus,
    powerStatus,
    providerRuntimeStatus,
    refreshHardware,
    runtimeError,
  } = useKnoshRuntimeHardwareState(runtimeAdapter);

  useEffect(() => {
    applyPageMeta({
      title: "Knosh Runtime",
      description: "Mounted-phone runtime surface for Knosh with voice control, power state, and an animated face.",
      url: "/knosh-runtime",
    });
  }, []);

  useEffect(() => {
    // A mounted Knosh phone is a kiosk: keep the screen on while this runtime
    // surface is active, and release the flag when the page unmounts.
    if (!Capacitor.isNativePlatform()) {
      return;
    }
    void setNativeKnoshKeepScreenOn(true);
    return () => {
      void setNativeKnoshKeepScreenOn(false);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      const dismissed = window.localStorage.getItem(KNOSH_RUNTIME_ONBOARDING_STORAGE_KEY);
      setShowOnboardingGuide(dismissed === "show");
    } catch {
      setShowOnboardingGuide(false);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      setVoiceInteractionMode("hold");
      return;
    }
    try {
      setVoiceInteractionMode(readKnoshVoiceInteractionMode(window.localStorage, activeProjectId));
    } catch {
      setVoiceInteractionMode("hold");
    }
  }, [activeProjectId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      writeKnoshVoiceInteractionMode(window.localStorage, voiceInteractionMode, activeProjectId);
    } catch {
      // ignore storage failures
    }
  }, [activeProjectId, voiceInteractionMode]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handleResize = () => {
      setOrientation(getViewportOrientation());
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    window.addEventListener("orientationchange", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("orientationchange", handleResize);
    };
  }, []);

  const latestAssistantMessage = useMemo(() => findLatestSpeakableAssistantReply(messages), [messages]);
  const latestDisplayAssistantMessage = useMemo(
    () => findLatestDisplayableAssistantReply(messages),
    [messages],
  );

  const handleVoiceInputError = useCallback(
    (message: string) => {
      setActionErrorRef.current(message);
      setRuntimeStatusTextRef.current(message);
      if (!isBenignNoSpeechVoiceInputError(message)) {
        showStatus(message, "error", 3500);
      }
    },
    [showStatus],
  );

  const voiceTurn = useVoiceTurnController({
    mode: speechMode,
    preferHostedCapture: interactionMode === "conversation",
    onError: handleVoiceInputError,
    projectId: activeProjectId,
  });

  const transcriptionBackendLabel = voiceTurn.backendLabel;
  const useHostedVoiceCapture = voiceTurn.useHostedVoiceCapture;
  const voiceSupported = voiceTurn.supported;
  const supportsContinuousVoiceMode =
    interactionMode === "conversation" && useHostedVoiceCapture && voiceSupported;
  const voiceStarting = voiceTurn.starting;
  const voiceListening = voiceTurn.listening;
  const voiceError = voiceTurn.error;
  const effectiveSpeechMode = voiceTurn.effectiveMode;
  const hostedVoiceTranscribing = voiceTurn.transcribing;
  const voiceState = voiceTurn.state;
  const voiceLiveTranscript = voiceTurn.liveTranscript;
  const voiceCompletedTranscript = voiceTurn.completedTranscript;
  const clearVoiceTurnTranscript = voiceTurn.clearTranscript;
  const startVoiceTurn = voiceTurn.start;
  const stopVoiceTurn = voiceTurn.stop;
  const runtimeReplyPlayback = useSpeechReplyPlayback({
    enabled: voiceRepliesEnabled,
    latestReply: latestAssistantMessage
      ? {
          id: latestAssistantMessage.id,
          content: latestAssistantMessage.content,
          playbackKey: resolveSpeechReplyPlaybackKey(latestAssistantMessage),
        }
      : null,
    rate: 1.02,
    pitch: 1.08,
    volume: 0.92,
    voice: effectiveSpeechMode === "device" ? deviceVoiceId : providerVoiceId,
    backendPreference: selectSpeechReplyBackendPreference(effectiveSpeechMode),
    projectId: activeProjectId,
    onError: (message) => {
      showStatus(message, "error", 3500);
    },
  });
  const speakRuntimeReplyText = runtimeReplyPlayback.speakText;
  const speakRuntimeReply = useCallback(
    async (text: string) => {
      const result = await speakRuntimeReplyText(text);
      return result.spoken;
    },
    [speakRuntimeReplyText],
  );
  const voiceSurfaceState = useVoiceSurfaceState({
    route: effectiveSpeechMode,
    capture: useHostedVoiceCapture ? "hosted" : "device",
    state: voiceState,
    supported: voiceSupported,
    transcriptionBackend: {
      kind: voiceTurn.backendKind,
      label: transcriptionBackendLabel,
      providerId: null,
    },
    speechMode,
    interactionMode,
    speechDependencyStatus,
    hostAudioDiagnostics,
    currentError: voiceError ?? runtimeError,
    voiceRepliesEnabled,
    latestReplyContent: latestAssistantMessage?.content ?? null,
    replyPlaybackLastBackend: runtimeReplyPlayback.lastBackend,
    replyPlaybackLastBackendLabel: runtimeReplyPlayback.lastBackendLabel,
  });
  usePublishVoiceDebugState("knoshRuntime", voiceSurfaceState.voiceDebugState);

  const speechTranscriptionReady = speechDependencyStatus?.transcription?.ready === true;
  const speechSynthesisReady = speechDependencyStatus?.synthesis?.ready === true;
  const primarySpeechAction =
    speechDependencyStatus?.actions?.find((action) => action.required) ??
    speechDependencyStatus?.actions?.[0];
  const continuousSession = useContinuousVoiceSession();
  const {
    continuousConversationActive,
    continuousAwaitingAssistantReply,
    continuousPauseMessage,
  } = continuousSession;
  const showKnoshMicrophonePermissionNotice = shouldShowHostMicrophonePermissionNotice(
    hostAudioDiagnostics?.capture.microphonePermission,
  );
  const showKnoshHandsFreeNotice =
    !showKnoshMicrophonePermissionNotice &&
    voiceSurfaceState.handsFreeAvailability.state !== "foreground_only";
  const knoshInteractionSummary =
    interactionMode === "actions"
      ? "Actions mode sends direct robot commands."
      : "Conversation mode keeps the assistant thread active.";
  const knoshSpeechRouteLabel =
    speechMode === "auto"
      ? `Auto · ${effectiveSpeechMode === "provider" ? "Speech provider" : "This device"}`
      : speechMode === "provider"
        ? "Speech provider"
        : "This device";
  const knoshVoiceInteractionLabel =
    voiceInteractionMode === "continuous"
      ? "Continuous"
      : voiceInteractionMode === "tap"
        ? "Tap to talk"
        : "Hold to talk";
  const knoshVoiceStatusMessage =
    voiceInteractionMode === "continuous" && continuousPauseMessage
      ? continuousPauseMessage
      : hostedVoiceTranscribing
        ? "Sending this turn to Knosh."
      : voiceSupported
        ? voiceInteractionMode === "continuous"
          ? continuousAwaitingAssistantReply
            ? "Waiting for Knosh to reply."
            : voiceListening || voiceStarting
              ? "Speak naturally. Instafy will stop after a pause."
              : "Continuous voice is ready."
          : voiceListening || voiceStarting
            ? voiceInteractionMode === "tap"
              ? "Tap again when you are done."
              : "Release when you are done."
            : interactionMode === "conversation"
              ? voiceInteractionMode === "tap"
                ? "Tap once to start talking to Knosh."
                : "Hold to talk to Knosh."
              : voiceInteractionMode === "tap"
                ? "Tap once to send a direct command."
                : "Hold to send a direct command."
        : speechMode === "provider"
          ? "The speech provider is selected, but no reachable provider speech path is available yet."
          : speechMode === "device"
            ? "This device is selected, but speech input is not available yet."
            : "Speech input is not available on this device yet.";
  const {
    activeLearningSession,
    actionBusy,
    actionError,
    clearActionError,
    conversationSubmitting,
    executePrompt,
    lastPrompt,
    lastResponse,
    lastTranscript,
    runtimeStatusText,
    setActionError,
    setLastTranscript,
    setRuntimeStatusText,
    submitConversationTurn,
  } = useKnoshRuntimeActionController({
    activeProjectId,
    activeConversationId,
    defaultEmbodiedHandle,
    showStatus,
    refreshHardware,
    voiceRepliesEnabled,
    speakRuntimeReply,
    submitConversationPrompt: (conversationId, prompt) =>
      submitConversationPrompt(conversationId, prompt),
    isAssistantTyping,
    latestAssistantContent: latestDisplayAssistantMessage?.content ?? null,
  });

  // Automation seam: __KNOSH_VOICE_SCENARIO__.run(scenario) plays a
  // knosh.voice_scenario.v1 file against this live page — the same JSON the
  // simulator gate and Unity twin consume — injecting transcripts through
  // the hosted voice-capture test seam and driving the embodied behaviors.
  const scenarioSpeakingRef = useRef(false);
  scenarioSpeakingRef.current = runtimeReplyPlayback.speaking;
  const scenarioHooksRef = useRef({
    startTurn: () => voiceTurn.start().then(() => undefined),
    stopTurn: () => voiceTurn.stop().then(() => undefined),
    executePrompt: (prompt: string) => executePrompt(prompt, "voice"),
  });
  scenarioHooksRef.current = {
    startTurn: () => voiceTurn.start().then(() => undefined),
    stopTurn: () => voiceTurn.stop().then(() => undefined),
    executePrompt: (prompt: string) => executePrompt(prompt, "voice"),
  };
  // Vision observation bus → scenario driver hook. camera_capture events in a
  // scenario are pure observation windows: the driver polls the latest record
  // here while the camera-observation capability does the capture/classify
  // work — the driver never issues camera commands itself.
  const latestVisionObservationRef = useRef<VisionObservation | null>(null);
  // Voicing the vision answer in CONVERSATION mode: the conversation flow
  // records the capability answer as a 'status' message
  // (localCapabilityConversationFlow), which the speakable-reply scan
  // (isSpeakableAssistantReplyMessage) intentionally skips — so without this
  // page-level hook the answer is never spoken and scenario reply_speech
  // windows observe silence. ACTIONS mode already speaks capability responses
  // through useKnoshRuntimeActionController.executePrompt, so it is excluded
  // here to avoid double-speaking the same answer. Dedupe by observation atMs
  // guards against re-published records: each observation is voiced at most
  // once, through the SAME playback machinery actions mode uses, so
  // runtimeReplyPlayback.speaking (and the scenario driver's isSpeaking hook)
  // reflects it.
  const lastSpokenVisionObservationAtMsRef = useRef<number>(Number.NEGATIVE_INFINITY);
  const speakVisionObservationRef = useRef<(observation: VisionObservation) => void>(
    () => undefined,
  );
  speakVisionObservationRef.current = (observation) => {
    if (observation.atMs <= lastSpokenVisionObservationAtMsRef.current) {
      return;
    }
    // Mark the observation handled before the mode/toggle checks: in actions
    // mode the action controller speaks it, and with replies off it stays
    // intentionally silent — neither should be voiced later.
    lastSpokenVisionObservationAtMsRef.current = observation.atMs;
    if (interactionMode !== "conversation" || !voiceRepliesEnabled) {
      return;
    }
    if (!observation.answer.trim()) {
      return;
    }
    void speakRuntimeReply(observation.answer);
  };
  useEffect(
    () =>
      subscribeVisionObservations((observation) => {
        latestVisionObservationRef.current = observation;
        speakVisionObservationRef.current(observation);
      }),
    [],
  );
  useEffect(() => {
    return installVoiceScenarioWindowApi({
      configureTranscript: (text) => {
        const runtimeWindow = window as typeof window & {
          __INSTAFY_HOSTED_VOICE_CAPTURE_TEST__?: {
            configure: (options: { transcriptText: string }) => Promise<boolean>;
          };
        };
        const controller = runtimeWindow.__INSTAFY_HOSTED_VOICE_CAPTURE_TEST__;
        if (!controller) {
          throw new Error(
            "Hosted voice-capture test seam is unavailable on this build.",
          );
        }
        void controller.configure({ transcriptText: text });
      },
      startTurn: () => scenarioHooksRef.current.startTurn(),
      stopTurn: () => scenarioHooksRef.current.stopTurn(),
      executePrompt: (prompt) => scenarioHooksRef.current.executePrompt(prompt),
      isSpeaking: () => scenarioSpeakingRef.current,
      getLatestVisionObservation: () => latestVisionObservationRef.current,
    });
  }, []);
  const transportAlert = useMemo(
    () =>
      resolveKnoshTransportAlert({
        providerRuntimeStatus,
        runtimeError,
        actionError,
      }),
    [actionError, providerRuntimeStatus, runtimeError],
  );

  useEffect(() => {
    setActionErrorRef.current = setActionError;
    setRuntimeStatusTextRef.current = setRuntimeStatusText;
  }, [setActionError, setRuntimeStatusText]);

  const conversationBusy = conversationSubmitting || isAssistantTyping || isWorkspaceSettingUp;
  const knoshSpeechRouteHealthy = voiceSurfaceState.speechRouteSummary.badgeTone === "success";
  const showKnoshTechnicalSummary =
    Boolean(voiceError || actionError || runtimeError) ||
    showKnoshMicrophonePermissionNotice ||
    !voiceSupported ||
    !knoshSpeechRouteHealthy;
  const knoshDiagnosticsModeSummary =
    interactionMode === "conversation"
      ? activeConversationId
        ? "Conversation thread is active."
        : "Conversation thread starts on first prompt."
      : "Actions mode sends direct commands.";
  const knoshDiagnosticsRouteHint = useHostedVoiceCapture
    ? voiceSurfaceState.speechRouteSummary.detail
    : speechMode === "device"
      ? "Speech is pinned to this device."
      : speechMode === "provider"
        ? "Speech is pinned to the provider path."
        : "Speech will prefer the provider path when it is ready.";

  useVoiceTurnRecovery({
    scope: "knoshRuntime",
    sessionState: voiceSurfaceState.hostAudioSession,
    voiceState,
    interactionMode: voiceInteractionMode,
    continuousSessionActive: continuousConversationActive || continuousAwaitingAssistantReply,
    cancelVoiceTurn: voiceTurn.cancel,
    onNotice: (notice) => {
      if (voiceInteractionMode === "continuous") {
        continuousSession.pause(notice.message, {
          resumeOnForeground: notice.kind === "background_pause",
        });
      }
      setRuntimeStatusText(notice.message);
      showStatus(notice.message, notice.tone, notice.tone === "warning" ? 4200 : 2800);
    },
  });

  useEffect(() => {
    if (voiceInteractionMode === "continuous" && !supportsContinuousVoiceMode) {
      setVoiceInteractionMode("tap");
    }
  }, [supportsContinuousVoiceMode, voiceInteractionMode]);

  const { speechBootstrapBusy, speechBootstrapResult, runSpeechBootstrap } =
    useKnoshSpeechBootstrapState({
      setSpeechDependencyStatus,
      refreshSpeechDependencies,
      showStatus,
    });
  const speechBootstrapHealthy =
    Boolean(speechDependencyStatus) &&
    speechTranscriptionReady &&
    speechSynthesisReady &&
    voiceSurfaceState.speechServiceReachable &&
    !speechBootstrapBusy &&
    !speechBootstrapResult?.error;
  const knoshSpeechBootstrapSummary = speechDependencyStatus
    ? speechBootstrapHealthy
      ? "Speech provider is live for mounted transcription and reply playback."
      : speechTranscriptionReady && speechSynthesisReady
        ? "Speech backend is installed, but the provider host still needs attention."
        : speechTranscriptionReady
          ? "Transcription is installed. Start or point the speech service at a synthesis backend."
          : "Speech provider is surfaced, but the local backend still needs host setup."
    : "Checking the local speech backend…";
  const knoshSpeechBootstrapDetail =
    speechBootstrapHealthy
      ? voiceSurfaceState.speechProviderSummary.detail
      : speechBootstrapResult?.error ||
        voiceSurfaceState.speechProviderSummary.detail ||
        (useHostedVoiceCapture
          ? "Mounted runtime will use the speech provider when it is reachable from this device."
          : "When the speech provider is ready, conversation mode can switch from device speech to the hosted provider path.");
  const showKnoshSpeechBootstrapGuidance = !speechBootstrapHealthy;

  const faceMood = useMemo(
    () =>
      selectKnoshFaceMood({
        voiceStarting,
        voiceListening,
        speaking: runtimeReplyPlayback.speaking,
        actionBusy: actionBusy || conversationBusy || hostedVoiceTranscribing,
        connected,
        error: actionError ?? voiceError ?? runtimeError,
        lastPrompt,
      }),
    [
      actionBusy,
      actionError,
      connected,
      conversationBusy,
      hostedVoiceTranscribing,
      lastPrompt,
      runtimeError,
      runtimeReplyPlayback.speaking,
      voiceError,
      voiceListening,
      voiceStarting,
    ],
  );
  const [faceFullscreen, setFaceFullscreen] = useState(false);

  const handleSpeechModeSelection = useCallback(
    async (nextMode: ProjectSpeechMode) => {
      const result = await setProjectSpeechMode(nextMode);
      if (!result.success) {
        showStatus(
          result.error?.trim().length
            ? `${result.error} Saved on this device only for now.`
            : "Unable to save the shared speech setting right now. Saved on this device only.",
          "warning",
          4200,
        );
      }
    },
    [setProjectSpeechMode, showStatus],
  );
  const handleRequestMicrophonePermission = useCallback(async () => {
    const permission = await requestMicrophonePermission();
    if (permission === "granted") {
      clearActionError();
      setRuntimeStatusText("Microphone permission granted. Press and hold to talk.");
      showStatus("Microphone permission granted. Press and hold to talk.", "success", 3200);
      return;
    }
    if (permission === "denied") {
      const message = "Microphone permission is still denied on this device.";
      setActionError(message);
      setRuntimeStatusText(message);
      showStatus(message, "warning", 3600);
      return;
    }
    if (permission === "prompt") {
      const message = "Approve the microphone prompt on the device, then try again.";
      setActionError(message);
      setRuntimeStatusText(message);
      showStatus(message, "warning", 3600);
      return;
    }
    if (permission === "unsupported") {
      const message = "This client cannot request microphone permission automatically.";
      setActionError(message);
      setRuntimeStatusText(message);
      showStatus(message, "warning", 3600);
    }
  }, [clearActionError, requestMicrophonePermission, setActionError, setRuntimeStatusText, showStatus]);
  const {
    handleVoicePressEnd,
    handleVoicePressStart,
    handleVoiceTap,
  } = useVoiceConversationLoop({
    continuousSession,
    voiceInteractionMode,
    debugScope: "knoshRuntime",
    voiceSupported,
    voiceCapture: useHostedVoiceCapture ? "hosted" : "device",
    useHostedVoiceCapture,
    voiceStarting,
    voiceListening,
    voiceTranscribing: hostedVoiceTranscribing,
    voiceCompletedTranscript,
    voiceError,
    busy: actionBusy || conversationBusy,
    latestAssistantId: latestAssistantMessage?.id ?? null,
    replyPlaybackSpeaking: runtimeReplyPlayback.speaking,
    hostAudioSession: voiceSurfaceState.hostAudioSession,
    startVoiceTurn,
    stopVoiceTurn,
    cancelVoiceTurn: voiceTurn.cancel,
    clearVoiceTurnTranscript,
    onSubmitTranscript: async (trimmedTranscript) => {
      if (interactionMode === "conversation") {
        return submitConversationTurn(trimmedTranscript, "voice");
      }
      await executePrompt(trimmedTranscript, "voice");
      return true;
    },
    onTranscriptResolved: setLastTranscript,
    onStatusChange: setRuntimeStatusText,
    onClearError: clearActionError,
    showStatus,
    pressStartStatusText: "Listening for Knosh…",
    continuousStartStatusText:
      "Listening for Knosh… Speak naturally and Instafy will stop after a pause.",
    hostedPressEndStatusText: "Transcribing your voice…",
    devicePressEndStatusText: "Finishing the transcript…",
    stopAfterCurrentTurnStatusText: "Finishing the current voice turn…",
    continuousStoppedStatusText: "Continuous voice stopped.",
  });

  const dismissOnboardingGuide = useCallback(() => {
    setShowOnboardingGuide(false);
    if (typeof window === "undefined") {
      return;
    }
    try {
      window.localStorage.setItem(KNOSH_RUNTIME_ONBOARDING_STORAGE_KEY, "hidden");
    } catch {
      // ignore storage failures
    }
  }, []);

  const showOnboardingAgain = useCallback(() => {
    setShowOnboardingGuide(true);
    if (typeof window === "undefined") {
      return;
    }
    try {
      window.localStorage.setItem(KNOSH_RUNTIME_ONBOARDING_STORAGE_KEY, "show");
    } catch {
      // ignore storage failures
    }
  }, []);

  const continuousVoiceLoopActive = continuousConversationActive || continuousAwaitingAssistantReply;
  const voiceButtonDisabled =
    !activeProjectId ||
    !voiceSupported ||
    actionBusy ||
    (voiceInteractionMode === "continuous"
      ? conversationBusy && !continuousVoiceLoopActive && !voiceListening && !voiceStarting && !hostedVoiceTranscribing
      : conversationBusy || hostedVoiceTranscribing);
  const screenClass =
    orientation === "portrait"
      ? "h-[27rem] w-[15rem] rounded-[2.2rem]"
      : "h-[16rem] w-[29rem] rounded-[2.4rem]";

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,#10325b_0%,#071423_42%,#020712_100%)] text-white">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-4 py-6 sm:px-6">
        <style>{`
          @keyframes knosh-runtime-pulse {
            0%, 100% { transform: scale(1); opacity: 0.72; }
            50% { transform: scale(1.04); opacity: 1; }
          }
        `}</style>
        {faceFullscreen ? (
          <div
            className="fixed inset-0 z-[70] bg-[#0A0908]"
            data-testid="knosh-face-fullscreen"
            role="button"
            aria-label="Exit face mode"
            tabIndex={0}
            onClick={() => setFaceFullscreen(false)}
            onKeyDown={(event) => {
              if (event.key === "Escape" || event.key === "Enter") {
                setFaceFullscreen(false);
              }
            }}
          >
            <KnoshFaceCanvas mood={faceMood} className="h-full w-full" />
            <div className="pointer-events-none absolute inset-x-0 bottom-4 text-center text-[10px] uppercase tracking-[0.3em] text-white/20">
              tap to exit
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xxs font-semibold uppercase tracking-[0.32em] text-cyan-200/75">
              Mounted Runtime
            </div>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">
              Knosh face + voice loop
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-300">
              Mounted face, voice controls, and direct Knosh behavior routing on the current
              client.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            {!showOnboardingGuide ? (
              <button
                type="button"
                onClick={showOnboardingAgain}
                className="rounded-full border border-white/12 bg-white/6 px-4 py-2 text-slate-200 transition hover:border-white/25 hover:bg-white/10"
              >
                Show guide
              </button>
            ) : null}
            <Link
              to="/studio"
              className="rounded-full border border-white/12 bg-white/6 px-4 py-2 text-slate-200 transition hover:border-white/25 hover:bg-white/10"
            >
              Back to Studio
            </Link>
            {KNOSH_ROBOT_LAB_ENABLED ? (
              <Link
                to="/robot-lab"
                className="rounded-full border border-white/12 bg-white/6 px-4 py-2 text-slate-200 transition hover:border-white/25 hover:bg-white/10"
              >
                Open Robot Lab
              </Link>
            ) : null}
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <span
            className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-xs font-medium text-cyan-50"
            data-testid="knosh-runtime-connection-summary"
          >
            {connected ? "Knosh connected" : "Waiting for Knosh"}
          </span>
          <span className="rounded-full border border-white/10 bg-white/6 px-3 py-1 text-xs text-slate-200">
            {orientation === "portrait" ? "Portrait mount" : "Landscape mount"}
          </span>
          {hostAudioDiagnostics?.devices.preferredOutputLabel ? (
            <span className="rounded-full border border-white/10 bg-white/6 px-3 py-1 text-xs text-slate-200">
              {hostAudioDiagnostics.devices.preferredOutputLabel}
            </span>
          ) : null}
          {activeProjectId ? (
            <span className="rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-1 text-xs text-emerald-100">
              {activeProjectName?.trim() || activeProjectId}
            </span>
          ) : (
            <span className="rounded-full border border-amber-300/20 bg-amber-300/10 px-3 py-1 text-xs text-amber-100">
              Open a Studio project to route live robot actions
            </span>
          )}
        </div>

        {showOnboardingGuide ? (
          <section className="mt-5 rounded-[2rem] border border-cyan-300/16 bg-[linear-gradient(180deg,rgba(125,211,252,0.14),rgba(8,18,32,0.78))] p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="max-w-3xl">
                <div className="text-xxs font-semibold uppercase tracking-[0.3em] text-cyan-100/75">
                  Mounted Runtime Guide
                </div>
                <h2 className="mt-2 text-xl font-semibold text-white">
                  How this screen is meant to be used on the robot
                </h2>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-slate-200">
                    <div className="font-medium text-white">1. Attach and connect first</div>
                    <div className="mt-2 text-slate-300">
                      Save the Knosh device in Extensions, confirm BLE is connected, then move to this runtime screen.
                    </div>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-slate-200">
                    <div className="font-medium text-white">2. Mount in portrait by default</div>
                    <div className="mt-2 text-slate-300">
                      Portrait gives the clearest face. Landscape still works, but portrait is the intended phone-on-head presentation.
                    </div>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-slate-200">
                    <div className="font-medium text-white">3. Use Conversation for talking</div>
                    <div className="mt-2 text-slate-300">
                      Conversation mode routes speech into Instafy’s normal `@knosh` assistant flow so you can actually talk to the robot.
                    </div>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-slate-200">
                    <div className="font-medium text-white">4. Use Actions for deterministic control</div>
                    <div className="mt-2 text-slate-300">
                      Actions mode is the faster path for movement commands like wake up, look at me, stop, and sleep.
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                {KNOSH_ROBOT_LAB_ENABLED ? (
                  <Link
                    to="/robot-lab"
                    className="rounded-full border border-white/12 bg-white/8 px-4 py-2 text-slate-100 transition hover:border-white/25 hover:bg-white/12"
                  >
                    Open Robot Lab
                  </Link>
                ) : null}
                <button
                  type="button"
                  onClick={dismissOnboardingGuide}
                  className="rounded-full border border-white/12 bg-transparent px-4 py-2 text-slate-200 transition hover:border-white/25 hover:bg-white/8"
                >
                  Dismiss guide
                </button>
              </div>
            </div>
          </section>
        ) : null}

        <div className="mt-8 grid flex-1 gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(21rem,0.8fr)]">
          <section className="relative overflow-hidden rounded-[2.4rem] border border-white/12 bg-[linear-gradient(180deg,rgba(9,23,39,0.94),rgba(4,10,18,0.98))] px-5 py-6 sm:px-8">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_18%,rgba(125,211,252,0.18),rgba(2,6,23,0)_36%)]" />
            <div className="relative flex h-full min-h-[34rem] flex-col justify-between">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs uppercase tracking-[0.3em] text-cyan-200/70">
                    Phone face
                  </div>
                  <div className="mt-2 text-sm text-slate-300">
                    {runtimeStatusText}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setFaceFullscreen(true)}
                    data-testid="knosh-face-fullscreen-toggle"
                    className="rounded-full border border-white/12 bg-white/6 px-3 py-1 text-xs font-medium text-slate-300 transition hover:bg-white/12"
                  >
                    Face mode
                  </button>
                  <button
                    type="button"
                    onClick={() => setVoiceRepliesEnabled((value) => !value)}
                    className={[
                      "rounded-full border px-3 py-1 text-xs font-medium transition",
                      voiceRepliesEnabled
                        ? "border-emerald-300/30 bg-emerald-300/12 text-emerald-100"
                        : "border-white/12 bg-white/6 text-slate-300",
                    ].join(" ")}
                  >
                    {voiceRepliesEnabled ? "Voice replies on" : "Voice replies off"}
                  </button>
                </div>
              </div>

              <div className="relative mx-auto mt-8 flex w-full max-w-[30rem] flex-1 items-center justify-center">
                <div
                  className="absolute h-64 w-64 rounded-full bg-cyan-400/12 blur-[90px]"
                  style={{ animation: "knosh-runtime-pulse 5.2s ease-in-out infinite" }}
                  aria-hidden="true"
                />
                <div
                  className={[
                    "relative border border-white/12 bg-[linear-gradient(180deg,#08111f_0%,#0b1d33_100%)] p-4 shadow-modal",
                    screenClass,
                  ].join(" ")}
                >
                  <div className="absolute inset-[10px] rounded-[1.8rem] bg-[radial-gradient(circle_at_50%_18%,rgba(125,211,252,0.18),rgba(6,10,20,0.95)_50%)]" />
                  <div className="relative flex h-full flex-col items-center justify-center overflow-hidden rounded-[1.8rem] bg-[#0A0908]">
                    <KnoshFaceCanvas
                      mood={faceMood}
                      className="min-h-0 w-full flex-1"
                      data-testid="knosh-face-canvas"
                    />
                    <div className="pb-4 text-center">
                      <div className="text-sm font-medium text-white/90">
                        {connected ? "Knosh is here." : "Waiting for Knosh."}
                      </div>
                      <div className="mt-2 text-xs tracking-[0.22em] text-amber-100/60 uppercase">
                        {faceMood === "listening"
                          ? "Listening"
                          : faceMood === "speaking"
                            ? "Speaking"
                            : faceMood === "thinking"
                              ? "Thinking"
                              : faceMood === "sleeping"
                                ? "Resting"
                                : faceMood === "error"
                                  ? "Needs attention"
                                  : faceMood === "acting"
                                    ? "Moving"
                                    : "Idle"}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-8 flex flex-wrap justify-center gap-3">
                {QUICK_ACTIONS.map((action) => (
                  <Button
                    key={action.prompt}
                    variant={action.prompt === "stop" ? "danger" : "secondary"}
                    size="sm"
                    onPress={() => void executePrompt(action.prompt, "tap")}
                    isDisabled={actionBusy || conversationBusy || !activeProjectId}
                    className="bg-white/8 text-white hover:bg-white/12 data-[hovered]:bg-white/12"
                  >
                    {action.label}
                  </Button>
                ))}
              </div>
            </div>
          </section>

          <aside className="flex flex-col gap-4">
            <section className="rounded-[2rem] border border-white/12 bg-white/6 p-5">
              <div className="text-xs uppercase tracking-[0.28em] text-cyan-200/70">
                Voice session
              </div>
              <h2 className="mt-2 text-xl font-semibold text-white">
                {interactionMode === "actions"
                  ? "Direct voice control for Knosh"
                  : voiceInteractionMode === "continuous"
                    ? "Continuous voice with Knosh"
                    : voiceInteractionMode === "tap"
                      ? "Tap to talk to Knosh"
                      : "Hold to talk to Knosh"}
              </h2>
              <p
                className="mt-2 text-sm text-slate-300"
                data-testid="knosh-runtime-voice-session-summary"
              >
                {knoshInteractionSummary}
              </p>

              <div className="mt-4 inline-flex rounded-full border border-white/12 bg-black/20 p-1">
                {(["conversation", "actions"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    data-testid={`knosh-runtime-interaction-mode-${mode}`}
                    onClick={() => setInteractionMode(mode)}
                    className={[
                      "rounded-full px-4 py-2 text-xs font-medium uppercase tracking-[0.22em] transition",
                      interactionMode === mode
                        ? "bg-cyan-300/18 text-cyan-50"
                        : "text-slate-300 hover:text-white",
                    ].join(" ")}
                  >
                    {mode === "conversation" ? "Conversation" : "Actions"}
                  </button>
                ))}
              </div>

              <div className="mt-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xxs uppercase tracking-[0.24em] text-slate-400">
                    Speech route
                  </div>
                  <div className="text-xxs text-slate-400">{knoshSpeechRouteLabel}</div>
                </div>
                <div className="mt-2 inline-flex rounded-full border border-white/12 bg-black/20 p-1">
                  {([
                    ["auto", "Auto"],
                    ["provider", "Speech provider"],
                    ["device", "This device"],
                  ] as const).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      data-testid={`knosh-runtime-speech-mode-${mode}`}
                      onClick={() => void handleSpeechModeSelection(mode)}
                      className={[
                        "rounded-full px-4 py-2 text-xxs font-medium uppercase tracking-[0.18em] transition",
                        speechMode === mode
                          ? "bg-cyan-300/18 text-cyan-50"
                          : "text-slate-300 hover:text-white",
                      ].join(" ")}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xxs uppercase tracking-[0.24em] text-slate-400">
                    Voice interaction
                  </div>
                  <div className="text-xxs text-slate-400">{knoshVoiceInteractionLabel}</div>
                </div>
                <div className="mt-2 inline-flex rounded-full border border-white/12 bg-black/20 p-1">
                  {([
                    ["hold", "Hold to talk"],
                    ["tap", "Tap to talk"],
                    ["continuous", "Continuous"],
                  ] as const).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      data-testid={`knosh-runtime-voice-interaction-mode-${mode}`}
                      onClick={() => setVoiceInteractionMode(mode)}
                      disabled={mode === "continuous" && !supportsContinuousVoiceMode}
                      className={[
                        "rounded-full px-4 py-2 text-xxs font-medium uppercase tracking-[0.18em] transition",
                        voiceInteractionMode === mode
                          ? "bg-cyan-300/18 text-cyan-50"
                          : mode === "continuous" && !supportsContinuousVoiceMode
                            ? "cursor-not-allowed text-slate-500"
                            : "text-slate-300 hover:text-white",
                      ].join(" ")}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {voiceInteractionMode === "continuous" && !supportsContinuousVoiceMode ? (
                  <div className="mt-2 text-xs text-amber-200/80">
                    Continuous mode needs conversation mode plus a reachable hosted speech path.
                  </div>
                ) : null}
              </div>

              <button
                type="button"
                data-testid="knosh-runtime-voice-button"
                data-voice-route={voiceSurfaceState.voiceDebugState.route}
                data-voice-capture={voiceSurfaceState.voiceDebugState.capture}
                data-voice-state={voiceSurfaceState.voiceDebugState.state}
                onPointerDown={() => {
                  if (voiceInteractionMode === "hold") {
                    void handleVoicePressStart();
                  }
                }}
                onPointerUp={() => {
                  if (voiceInteractionMode === "hold") {
                    void handleVoicePressEnd();
                  }
                }}
                onPointerCancel={() => {
                  if (voiceInteractionMode === "hold") {
                    void handleVoicePressEnd();
                  }
                }}
                onPointerLeave={() => {
                  if (voiceInteractionMode === "hold") {
                    void handleVoicePressEnd();
                  }
                }}
                onClick={() => {
                  if (voiceInteractionMode !== "hold") {
                    void handleVoiceTap();
                  }
                }}
                onKeyDown={(event) => {
                  if (voiceInteractionMode === "hold" && (event.key === " " || event.key === "Enter")) {
                    event.preventDefault();
                    void handleVoicePressStart();
                  }
                }}
                onKeyUp={(event) => {
                  if (voiceInteractionMode === "hold" && (event.key === " " || event.key === "Enter")) {
                    event.preventDefault();
                    void handleVoicePressEnd();
                  }
                }}
                disabled={voiceButtonDisabled}
                className={[
                  "mt-5 w-full rounded-[1.8rem] border px-4 py-5 text-left transition",
                  voiceListening || voiceStarting || continuousVoiceLoopActive
                    ? "border-cyan-300/40 bg-cyan-300/14 text-cyan-50 shadow-[0_0_0_1px_rgba(125,211,252,0.15)]"
                    : "border-white/12 bg-white/8 text-white hover:border-white/20 hover:bg-white/10",
                  voiceButtonDisabled ? "opacity-60" : "",
                ].join(" ")}
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold" data-testid="knosh-runtime-voice-cta">
                      {hostedVoiceTranscribing
                        ? "Transcribing…"
                        : voiceInteractionMode === "continuous" && continuousAwaitingAssistantReply
                          ? "Waiting for Knosh reply"
                          : voiceListening || voiceStarting
                            ? voiceInteractionMode === "continuous"
                              ? "Tap to finish this turn"
                              : voiceInteractionMode === "tap"
                                ? "Tap again to send"
                                : "Release to send"
                            : voiceInteractionMode === "continuous"
                              ? "Start continuous voice"
                              : voiceInteractionMode === "tap"
                                ? "Tap to talk"
                            : "Press and hold"}
                    </div>
                    <div
                      className="mt-1 text-xs text-slate-300"
                      data-testid="knosh-runtime-voice-status"
                    >
                      {knoshVoiceStatusMessage}
                    </div>
                  </div>
                  <div
                    className="rounded-full border border-white/14 bg-white/8 px-3 py-1 text-xs uppercase tracking-[0.24em] text-cyan-100/80"
                    data-testid="knosh-runtime-voice-badge"
                  >
                    {hostedVoiceTranscribing
                      ? "Speech"
                      : continuousAwaitingAssistantReply
                        ? "Waiting"
                        : voiceListening
                          ? "Live"
                          : voiceStarting
                            ? "Starting"
                            : useHostedVoiceCapture
                              ? "Hosted"
                              : "Voice"}
                  </div>
                </div>
              </button>

              {showKnoshMicrophonePermissionNotice ? (
                <HostMicrophonePermissionNotice
                  permission={hostAudioDiagnostics?.capture.microphonePermission}
                  requesting={microphonePermissionRequesting}
                  error={microphonePermissionRequestError}
                  onRequest={handleRequestMicrophonePermission}
                  className="mt-3"
                  testIdPrefix="knosh-runtime-mic"
                />
              ) : null}
              {showKnoshHandsFreeNotice ? (
                <HostHandsFreeVoiceNotice
                  availability={voiceSurfaceState.handsFreeAvailability}
                  className="mt-3"
                  testIdPrefix="knosh-runtime-hands-free"
                  variant="inverse"
                />
              ) : null}

              {(voiceError || actionError || runtimeError) && (
                <div className="mt-4 rounded-2xl border border-rose-300/20 bg-rose-300/10 p-4 text-sm text-rose-100">
                  {actionError || voiceError || runtimeError}
                </div>
              )}

              {showKnoshTechnicalSummary && !(voiceError || actionError || runtimeError) && !showKnoshMicrophonePermissionNotice ? (
                <div className="mt-4 rounded-2xl border border-white/10 bg-white/6 p-4 text-sm text-slate-200">
                  <div className="font-semibold text-white">
                    {!voiceSupported ? "Voice support is unavailable" : "Speech route needs attention"}
                  </div>
                  <div className="mt-1 text-xs text-slate-400">
                    {voiceSurfaceState.speechRouteSummary.detail}
                  </div>
                </div>
              ) : null}

              <VoiceDiagnosticsDisclosure
                title="Advanced diagnostics and setup"
                description="Route, bootstrap, and provider speech details."
                variant="inverse"
                className="mt-4"
                testIdPrefix="knosh-runtime-advanced-diagnostics"
              >
                <div className="text-xs text-slate-300" data-testid="knosh-runtime-voice-debug">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <div className="text-slate-400">State</div>
                      <div className="text-white" data-testid="knosh-runtime-voice-state">
                        {voiceSurfaceState.voiceDebugState.state}
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-400">Capture</div>
                      <div className="text-white" data-testid="knosh-runtime-voice-capture">
                        {voiceSurfaceState.voiceDebugState.capture}
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-400">Route</div>
                      <div className="text-white" data-testid="knosh-runtime-voice-route">
                        {voiceSurfaceState.voiceDebugState.route}
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-400">Supported</div>
                      <div className="text-white" data-testid="knosh-runtime-voice-supported">
                        {voiceSupported ? "yes" : "no"}
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-400">Backend</div>
                      <div className="text-white" data-testid="knosh-runtime-voice-backend">
                        {transcriptionBackendLabel || (useHostedVoiceCapture ? "provider" : "device")}
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-400">Speech host</div>
                      <div className="text-white" data-testid="knosh-runtime-voice-provider-health">
                        {voiceSurfaceState.speechRouteSummary.badgeLabel}
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-400">Session</div>
                      <div className="text-white" data-testid="knosh-runtime-voice-session-state">
                        {voiceSurfaceState.hostAudioSession?.phase ?? "unknown"}
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-400">Mic permission</div>
                      <div className="text-white" data-testid="knosh-runtime-voice-mic-permission">
                        {hostAudioDiagnostics?.capture.microphonePermission ?? "unknown"}
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-400">Audio output</div>
                      <div className="text-white" data-testid="knosh-runtime-voice-output-route">
                        {hostAudioDiagnostics?.devices.preferredOutputLabel ??
                          (hostAudioDiagnostics
                            ? hostAudioDiagnostics.devices.outputCount > 0
                              ? `${hostAudioDiagnostics.devices.outputCount} outputs`
                              : "none visible"
                            : "unknown")}
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-400">Continuous voice</div>
                      <div>
                        {continuousConversationActive
                          ? "active"
                          : continuousAwaitingAssistantReply
                            ? "waiting"
                            : continuousPauseMessage
                              ? "paused"
                              : "ready"}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3">
                    <div className="text-slate-400">Latest error</div>
                    <div className="text-white" data-testid="knosh-runtime-voice-error">
                      {voiceSurfaceState.voiceDebugState.lastError || "none"}
                    </div>
                  </div>
                  <div className="mt-3">
                    <div className="text-slate-400">Host audio</div>
                    <div className="text-white" data-testid="knosh-runtime-host-audio-summary">
                      {voiceSurfaceState.hostAudioSummary}
                    </div>
                  </div>
                  <div
                    className="mt-4 rounded-2xl border border-white/10 bg-white/6 p-4 text-sm text-slate-300"
                    data-testid="knosh-runtime-diagnostics-mode-route"
                  >
                    <div className="text-xxs uppercase tracking-[0.24em] text-slate-400">
                      Mode + route
                    </div>
                    <div className="mt-2 text-sm text-white">
                      {knoshDiagnosticsModeSummary}
                    </div>
                    <div className="mt-2 text-xs text-slate-400">
                      {knoshDiagnosticsRouteHint}
                    </div>
                  </div>
                  <div className="mt-4 rounded-2xl border border-white/10 bg-white/6 p-4 text-sm text-slate-300">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-xxs uppercase tracking-[0.24em] text-slate-400">
                          Speech provider bootstrap
                        </div>
                        <div
                          className="mt-2 text-sm text-white"
                          data-testid="knosh-runtime-speech-bootstrap-summary"
                        >
                          {knoshSpeechBootstrapSummary}
                        </div>
                      </div>
                      <div
                        className="rounded-full border border-white/14 bg-white/8 px-3 py-1 text-xs uppercase tracking-[0.24em] text-cyan-100/80"
                        data-testid="knosh-runtime-speech-bootstrap-status"
                      >
                        {speechBootstrapBusy
                          ? "Working"
                          : speechBootstrapHealthy
                            ? "Live"
                            : voiceSurfaceState.speechServiceReachable
                            ? "Live"
                            : speechTranscriptionReady
                              ? "Ready"
                              : "Setup"}
                      </div>
                    </div>

                    <div
                      className="mt-3 text-xs text-slate-400"
                      data-testid="knosh-runtime-speech-bootstrap-detail"
                    >
                      {knoshSpeechBootstrapDetail}
                    </div>

                    {showKnoshSpeechBootstrapGuidance && speechDependencyStatus?.nextSteps?.length ? (
                      <div className="mt-3 space-y-2">
                        {speechDependencyStatus.nextSteps.slice(0, 3).map((step) => (
                          <div
                            key={step}
                            className="rounded-xl border border-white/8 bg-white/6 px-3 py-2 text-xs text-slate-200"
                          >
                            {step}
                          </div>
                        ))}
                      </div>
                    ) : null}

                    {showKnoshSpeechBootstrapGuidance && speechDependencyStatus?.actions?.length ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onPress={() => void runSpeechBootstrap("check", true)}
                          isDisabled={speechBootstrapBusy}
                        >
                          Check speech host
                        </Button>
                        {!speechTranscriptionReady ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            onPress={() => void runSpeechBootstrap("install_transcription")}
                            isDisabled={speechBootstrapBusy}
                          >
                            Install speech dependencies
                          </Button>
                        ) : null}
                      </div>
                    ) : null}

                    {showKnoshSpeechBootstrapGuidance && primarySpeechAction?.command ? (
                      <div className="mt-3 rounded-xl border border-white/8 bg-white/6 px-3 py-2 text-xs text-slate-300">
                        Recommended install command: <code>{primarySpeechAction.command}</code>
                      </div>
                    ) : null}

                    {showKnoshSpeechBootstrapGuidance && speechDependencyStatus?.localService?.command ? (
                      <div className="mt-2 rounded-xl border border-white/8 bg-white/6 px-3 py-2 text-xs text-slate-300">
                        Start the local service with <code>{speechDependencyStatus.localService.command}</code>
                      </div>
                    ) : null}
                  </div>
                </div>
              </VoiceDiagnosticsDisclosure>
            </section>

            <section className="rounded-[2rem] border border-white/12 bg-white/6 p-5">
              <div className="text-xs uppercase tracking-[0.28em] text-cyan-200/70">
                Conversation memory
              </div>
              <h2 className="mt-2 text-xl font-semibold text-white">Last heard / Last reply</h2>
              <div className="mt-4 grid gap-3">
                <div
                  className="rounded-2xl border border-white/10 bg-black/20 p-4"
                  data-testid="knosh-runtime-last-heard-panel"
                >
                  <div className="text-xxs uppercase tracking-[0.24em] text-slate-400">
                    Last heard
                  </div>
                  <div className="mt-2 min-h-[2.75rem] text-sm text-white" data-testid="knosh-runtime-last-heard">
                    {voiceLiveTranscript.trim() ||
                      voiceCompletedTranscript.trim() ||
                      lastTranscript ||
                      "Nothing yet"}
                  </div>
                </div>
                <div
                  className="rounded-2xl border border-white/10 bg-black/20 p-4"
                  data-testid="knosh-runtime-last-reply-panel"
                >
                  <div className="text-xxs uppercase tracking-[0.24em] text-slate-400">
                    Last reply
                  </div>
                  <div className="mt-2 min-h-[2.75rem] text-sm text-white" data-testid="knosh-runtime-last-reply">
                    {lastResponse || "Knosh is idle."}
                  </div>
                </div>
              </div>
            </section>

            <section className="rounded-[2rem] border border-white/12 bg-white/6 p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs uppercase tracking-[0.28em] text-cyan-200/70">
                    Runtime health
                  </div>
                  <h2 className="mt-2 text-xl font-semibold text-white">
                    Knosh transport + power
                  </h2>
                </div>
                <Button variant="outline" size="sm" onPress={() => void refreshHardware()}>
                  Refresh
                </Button>
              </div>

              <div className="mt-4 grid gap-3">
                <KnoshTransportStatusNotice
                  providerRuntimeStatus={providerRuntimeStatus}
                  runtimeError={runtimeError}
                  actionError={actionError}
                  projectId={activeProjectId}
                />
                <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                  <div className="text-xxs uppercase tracking-[0.24em] text-slate-400">
                    Current client
                  </div>
                  <div className="mt-2 text-sm text-white">
                    {deviceStatus
                      ? `${deviceStatus.platform} · ${deviceStatus.connection.ready ? "ready" : deviceStatus.connection.connected ? "connected" : "idle"}`
                      : "Checking runtime…"}
                  </div>
                </div>
                {!transportAlert ? (
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                    <div className="text-xxs uppercase tracking-[0.24em] text-slate-400">
                      Provider runtime
                    </div>
                    <div className="mt-2 text-sm text-white">
                      {providerRuntimeStatus?.configured_runtime_backend_id ||
                        providerRuntimeStatus?.preferred_runtime_backend_id ||
                        "No runtime backend surfaced yet"}
                    </div>
                  </div>
                ) : null}
                <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                  <div className="text-xxs uppercase tracking-[0.24em] text-slate-400">
                    Battery + watchdog
                  </div>
                  <div className="mt-2 text-sm text-white">
                    {typeof powerStatus?.battery_voltage_v === "number"
                      ? `${powerStatus.battery_voltage_v.toFixed(2)}V · ${powerStatus.watchdog_state ?? "watchdog unknown"}`
                      : powerStatus?.reason || "Power status unavailable"}
                  </div>
                </div>
              </div>

              {activeLearningSession && (
                <div className="mt-4 rounded-2xl border border-amber-300/20 bg-amber-300/10 p-4 text-sm text-amber-50">
                  Active learning session: {activeLearningSession.goal}
                </div>
              )}
            </section>
          </aside>
        </div>
      </div>
    </main>
  );
}
