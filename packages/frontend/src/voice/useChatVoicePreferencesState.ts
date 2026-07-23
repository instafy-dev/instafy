import { useCallback, useEffect, useLayoutEffect, useRef, useState, type SetStateAction } from "react";
import {
  hasChatVoiceRepliesEnabledPreference,
  readChatVoiceInteractionModePreference,
  readChatVoiceRepliesEnabledPreference,
  readChatWakeWordArmedPreference,
  type ChatVoiceInteractionMode,
  writeChatVoiceInteractionModePreference,
  writeChatVoiceRepliesEnabledPreference,
  writeChatWakeWordArmedPreference,
} from "./chatSpeechReplyPreference";

function getChatVoicePreferenceStorage() {
  return typeof window !== "undefined" ? window.localStorage : null;
}

export type ChatVoicePreferencesState = {
  voiceRepliesEnabled: boolean;
  chatVoiceInteractionMode: ChatVoiceInteractionMode;
  chatWakeWordArmed: boolean;
  setVoiceRepliesEnabled: (enabled: SetStateAction<boolean>) => void;
  setChatVoiceInteractionMode: (mode: ChatVoiceInteractionMode) => void;
  setChatWakeWordArmed: (enabled: boolean) => void;
  enableVoiceRepliesIfUnconfigured: () => void;
};

export function useChatVoicePreferencesState(
  projectId: string | null | undefined,
): ChatVoicePreferencesState {
  const [voiceRepliesEnabled, setVoiceRepliesEnabledState] = useState(false);
  const [chatVoiceInteractionMode, setChatVoiceInteractionModeState] =
    useState<ChatVoiceInteractionMode>("hold");
  const [chatWakeWordArmed, setChatWakeWordArmedState] = useState(false);
  const voiceRepliesPreferenceTouchedRef = useRef(false);

  useEffect(() => {
    const storage = getChatVoicePreferenceStorage();
    voiceRepliesPreferenceTouchedRef.current = hasChatVoiceRepliesEnabledPreference(storage, projectId);
    setVoiceRepliesEnabledState(readChatVoiceRepliesEnabledPreference(storage, projectId));
  }, [projectId]);

  useLayoutEffect(() => {
    const storage = getChatVoicePreferenceStorage();
    setChatVoiceInteractionModeState(readChatVoiceInteractionModePreference(storage, projectId));
    setChatWakeWordArmedState(readChatWakeWordArmedPreference(storage, projectId));
  }, [projectId]);

  useEffect(() => {
    const storage = getChatVoicePreferenceStorage();
    if (!voiceRepliesPreferenceTouchedRef.current) {
      return;
    }
    writeChatVoiceRepliesEnabledPreference(storage, voiceRepliesEnabled, projectId);
  }, [projectId, voiceRepliesEnabled]);

  useEffect(() => {
    const storage = getChatVoicePreferenceStorage();
    writeChatVoiceInteractionModePreference(storage, chatVoiceInteractionMode, projectId);
  }, [chatVoiceInteractionMode, projectId]);

  useEffect(() => {
    const storage = getChatVoicePreferenceStorage();
    writeChatWakeWordArmedPreference(storage, chatWakeWordArmed, projectId);
  }, [chatWakeWordArmed, projectId]);

  const setVoiceRepliesEnabled = useCallback((enabled: SetStateAction<boolean>) => {
    voiceRepliesPreferenceTouchedRef.current = true;
    setVoiceRepliesEnabledState(enabled);
  }, []);

  const setChatVoiceInteractionMode = useCallback((mode: ChatVoiceInteractionMode) => {
    setChatVoiceInteractionModeState(mode);
  }, []);

  const setChatWakeWordArmed = useCallback((enabled: boolean) => {
    setChatWakeWordArmedState(enabled);
  }, []);

  const enableVoiceRepliesIfUnconfigured = useCallback(() => {
    if (voiceRepliesPreferenceTouchedRef.current) {
      return;
    }
    voiceRepliesPreferenceTouchedRef.current = true;
    setVoiceRepliesEnabledState(true);
  }, []);

  return {
    voiceRepliesEnabled,
    chatVoiceInteractionMode,
    chatWakeWordArmed,
    setVoiceRepliesEnabled,
    setChatVoiceInteractionMode,
    setChatWakeWordArmed,
    enableVoiceRepliesIfUnconfigured,
  };
}
