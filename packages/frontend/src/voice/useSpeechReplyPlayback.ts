import { useCallback, useEffect, useRef, useState } from "react";
import {
  readSpeechPlaybackDebugSnapshot,
  speakTextWithSpeechService,
  subscribeSpeechPlaybackDebug,
  type SpeechSynthesisBackendPreference,
  type SpeechPlaybackDebugSnapshot,
} from "./speechService";

export type SpeechReplyMessage = {
  id: string;
  content: string;
  playbackKey?: string | null;
} | null;

export function selectSpeechReplyBackendPreference(
  route: "provider" | "device",
): SpeechSynthesisBackendPreference {
  return route === "device" ? "browser" : "provider";
}

export function buildSpeechReplyUnavailableMessage() {
  return "No speech playback is available on this device.";
}

export function useSpeechReplyPlayback(options: {
  enabled: boolean;
  latestReply?: SpeechReplyMessage;
  voice?: string | null;
  language?: string | null;
  rate?: number;
  pitch?: number;
  volume?: number;
  backendPreference?: SpeechSynthesisBackendPreference;
  onError?: (message: string) => void;
  projectId?: string | null;
  accessToken?: string | null;
}) {
  const {
    accessToken = null,
    backendPreference,
    enabled,
    latestReply,
    language,
    onError,
    pitch,
    projectId = null,
    rate,
    voice,
    volume,
  } = options;
  const lastSpokenReplyKeyRef = useRef<string | null>(null);
  const speakingReplyKeyRef = useRef<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastBackend, setLastBackend] = useState<"provider" | "http" | "browser" | "none" | null>(null);
  const [lastBackendLabel, setLastBackendLabel] = useState<string | null>(null);
  const [lastAttemptedReplyId, setLastAttemptedReplyId] = useState<string | null>(null);
  const [lastSpokenReplyId, setLastSpokenReplyId] = useState<string | null>(null);
  const [playbackDebug, setPlaybackDebug] = useState<SpeechPlaybackDebugSnapshot>(() =>
    readSpeechPlaybackDebugSnapshot(),
  );

  const speakText = useCallback(
    async (
      text: string,
      overrides?: {
        replyId?: string | null;
        replyKey?: string | null;
      },
    ) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return {
          spoken: false,
          backend: "none" as const,
          label: null,
        };
      }

      setSpeaking(true);
      setLastError(null);
      setLastAttemptedReplyId(overrides?.replyId ?? null);
      try {
        const result = await speakTextWithSpeechService({
          text: trimmed,
          voice,
          language,
          rate,
          pitch,
          volume,
          backendPreference,
          projectId,
          accessToken,
        });
        setLastBackend(result.backend);
        setLastBackendLabel(result.label);
        if (result.spoken) {
          const resolvedReplyKey =
            typeof overrides?.replyKey === "string" && overrides.replyKey.trim()
              ? overrides.replyKey.trim()
              : overrides?.replyId ?? null;
          if (resolvedReplyKey) {
            lastSpokenReplyKeyRef.current = resolvedReplyKey;
          }
          if (overrides?.replyId) {
            setLastSpokenReplyId(overrides.replyId);
          }
          return result;
        }
        const message = buildSpeechReplyUnavailableMessage();
        setLastError(message);
        onError?.(message);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setLastError(message);
        onError?.(message);
        throw error;
      } finally {
        setSpeaking(false);
      }
    },
    [
      accessToken,
      backendPreference,
      language,
      onError,
      pitch,
      projectId,
      rate,
      voice,
      volume,
    ],
  );

  useEffect(() => {
    return subscribeSpeechPlaybackDebug((snapshot) => {
      setPlaybackDebug(snapshot);
    });
  }, []);

  useEffect(() => {
    if (!enabled || !latestReply) {
      return;
    }
    const nextReply = latestReply;
    const nextReplyKey =
      typeof nextReply.playbackKey === "string" && nextReply.playbackKey.trim()
        ? nextReply.playbackKey.trim()
        : nextReply.id;
    if (!nextReply.content.trim()) {
      return;
    }
    if (
      nextReplyKey === lastSpokenReplyKeyRef.current ||
      nextReplyKey === speakingReplyKeyRef.current
    ) {
      return;
    }
    speakingReplyKeyRef.current = nextReplyKey;
    void speakText(nextReply.content, {
      replyId: nextReply.id,
      replyKey: nextReplyKey,
    }).finally(() => {
      if (speakingReplyKeyRef.current === nextReplyKey) {
        speakingReplyKeyRef.current = null;
      }
    });
  }, [enabled, latestReply, speakText]);

  return {
    speakText,
    speaking,
    lastError,
    lastBackend,
    lastBackendLabel,
    lastAttemptedReplyId,
    lastSpokenReplyId,
    playbackDebug,
  };
}
