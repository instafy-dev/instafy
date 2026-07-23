export const CHAT_VOICE_REPLIES_ENABLED_STORAGE_KEY = "instafy:chat:voice-replies-enabled";
export const CHAT_VOICE_INTERACTION_MODE_STORAGE_KEY = "instafy:chat:voice-interaction-mode";
export const CHAT_WAKE_WORD_ARMED_STORAGE_KEY = "instafy:chat:wake-word-armed";
export type ChatVoiceInteractionMode = "hold" | "tap" | "continuous";

function getProjectScopedStorageKey(baseKey: string, projectId?: string | null) {
  const normalizedProjectId =
    typeof projectId === "string" && projectId.trim().length > 0 ? projectId.trim() : null;
  return normalizedProjectId ? `${baseKey}:${normalizedProjectId}` : baseKey;
}

export function getChatVoiceRepliesEnabledStorageKey(projectId?: string | null) {
  return getProjectScopedStorageKey(CHAT_VOICE_REPLIES_ENABLED_STORAGE_KEY, projectId);
}

export function readChatVoiceRepliesEnabledPreference(
  storage: Pick<Storage, "getItem"> | null | undefined,
  projectId?: string | null,
) {
  if (!storage) {
    return false;
  }
  return storage.getItem(getChatVoiceRepliesEnabledStorageKey(projectId)) === "true";
}

export function hasChatVoiceRepliesEnabledPreference(
  storage: Pick<Storage, "getItem"> | null | undefined,
  projectId?: string | null,
) {
  if (!storage) {
    return false;
  }
  return storage.getItem(getChatVoiceRepliesEnabledStorageKey(projectId)) !== null;
}

export function writeChatVoiceRepliesEnabledPreference(
  storage: Pick<Storage, "setItem" | "removeItem"> | null | undefined,
  enabled: boolean,
  projectId?: string | null,
) {
  if (!storage) {
    return;
  }
  const key = getChatVoiceRepliesEnabledStorageKey(projectId);
  storage.setItem(key, enabled ? "true" : "false");
}

export function getChatVoiceInteractionModeStorageKey(projectId?: string | null) {
  return getProjectScopedStorageKey(CHAT_VOICE_INTERACTION_MODE_STORAGE_KEY, projectId);
}

export function readChatVoiceInteractionModePreference(
  storage: Pick<Storage, "getItem"> | null | undefined,
  projectId?: string | null,
): ChatVoiceInteractionMode {
  if (!storage) {
    return "hold";
  }
  const storedValue = storage.getItem(getChatVoiceInteractionModeStorageKey(projectId))?.trim();
  return storedValue === "tap" || storedValue === "continuous" ? storedValue : "hold";
}

export function writeChatVoiceInteractionModePreference(
  storage: Pick<Storage, "setItem" | "removeItem"> | null | undefined,
  mode: ChatVoiceInteractionMode,
  projectId?: string | null,
) {
  if (!storage) {
    return;
  }
  const key = getChatVoiceInteractionModeStorageKey(projectId);
  if (mode === "hold") {
    storage.removeItem(key);
    return;
  }
  storage.setItem(key, mode);
}

export function getChatWakeWordArmedStorageKey(projectId?: string | null) {
  return getProjectScopedStorageKey(CHAT_WAKE_WORD_ARMED_STORAGE_KEY, projectId);
}

export function readChatWakeWordArmedPreference(
  storage: Pick<Storage, "getItem"> | null | undefined,
  projectId?: string | null,
) {
  if (!storage) {
    return false;
  }
  return storage.getItem(getChatWakeWordArmedStorageKey(projectId)) === "true";
}

export function writeChatWakeWordArmedPreference(
  storage: Pick<Storage, "setItem" | "removeItem"> | null | undefined,
  enabled: boolean,
  projectId?: string | null,
) {
  if (!storage) {
    return;
  }
  const key = getChatWakeWordArmedStorageKey(projectId);
  if (!enabled) {
    storage.removeItem(key);
    return;
  }
  storage.setItem(key, "true");
}
