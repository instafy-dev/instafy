import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { ChatMessage } from "../types";
import type { AiCredentialsGateState } from "./AiCredentialsStatusBubble";
import { shouldDisplayChatMessage } from "./chatMessagePresentation";

const GETTING_STARTED_DISMISSED_KEY = "instafy.onboarding.gettingStartedDismissed";
const GETTING_STARTED_MANAGED_AI_SELECTED_KEY = "instafy.onboarding.managedAiSelected";
const PROJECT_HAS_MESSAGES_KEY = "instafy.onboarding.projectHasMessages";

type ConversationLike = {
  controllerId?: string | null;
  hasRemoteMessages?: boolean;
  messages?: ChatMessage[] | null;
} | null;

type UseChatGettingStartedStateOptions = {
  activeConversationId: string | null;
  activeProjectId: string | null;
  aiOnboardingOpen: boolean;
  anyAgentsEnabled: boolean;
  clearGithubImportUi: () => void;
  conversations: ConversationLike[] | null | undefined;
  conversationsProjectKey: string;
  credentialGateState: AiCredentialsGateState | null;
  credentialsReady: boolean;
  currentUserId: string | null;
  displayedMessageCount: number;
  githubImportBusy: boolean;
  gettingStartedContextRelevant: boolean;
  gettingStartedContextResolved: boolean;
  hasMoreHistory: boolean;
  inputValue: string;
  isHistoryLoading: boolean;
  remoteHistoryPresenceResolved: boolean;
  runtimeControllerEnabled: boolean;
};

function buildScopedStorageKey(prefix: string, userId: string | null, projectId: string | null): string {
  const project = projectId ?? "unknown-project";
  const user = userId ?? "unknown-user";
  return `${prefix}:${user}:${project}`;
}

function readLocalStorageBoolean(key: string): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeLocalStorageBoolean(key: string, value: boolean) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // ignore storage failures
  }
}

export function useChatGettingStartedState({
  activeConversationId,
  activeProjectId,
  aiOnboardingOpen,
  anyAgentsEnabled,
  clearGithubImportUi,
  conversations,
  conversationsProjectKey,
  credentialGateState,
  credentialsReady,
  currentUserId,
  displayedMessageCount,
  githubImportBusy,
  gettingStartedContextRelevant,
  gettingStartedContextResolved,
  hasMoreHistory,
  inputValue,
  isHistoryLoading,
  remoteHistoryPresenceResolved,
  runtimeControllerEnabled,
}: UseChatGettingStartedStateOptions) {
  const gettingStartedKey = useMemo(
    () => buildScopedStorageKey(GETTING_STARTED_DISMISSED_KEY, currentUserId, activeProjectId),
    [activeProjectId, currentUserId],
  );
  const managedAiSelectedKey = useMemo(
    () => buildScopedStorageKey(GETTING_STARTED_MANAGED_AI_SELECTED_KEY, currentUserId, activeProjectId),
    [activeProjectId, currentUserId],
  );
  const projectHistoryKey = useMemo(
    () => buildScopedStorageKey(PROJECT_HAS_MESSAGES_KEY, currentUserId, activeProjectId),
    [activeProjectId, currentUserId],
  );

  const [gettingStartedDismissedState, setGettingStartedDismissedState] = useState(() => ({
    key: gettingStartedKey,
    value: readLocalStorageBoolean(gettingStartedKey),
  }));
  const [gettingStartedManagedAiSelectedState, setGettingStartedManagedAiSelectedState] = useState(() => ({
    key: managedAiSelectedKey,
    value: readLocalStorageBoolean(managedAiSelectedKey),
  }));
  const [gettingStartedMode, setGettingStartedMode] = useState<"root" | "github">("root");
  const [projectHasStoredHistoryState, setProjectHasStoredHistoryState] = useState(() => ({
    key: projectHistoryKey,
    value: readLocalStorageBoolean(projectHistoryKey),
  }));
  // Explicit "Import GitHub repo" entry (e.g. from the composer "+" menu) forces
  // the getting-started card open in github mode even after it was dismissed or
  // once the conversation has history, so repo import is never buried or lost.
  const [forceGithubImport, setForceGithubImport] = useState(false);

  const gettingStartedDismissed =
    gettingStartedDismissedState.key === gettingStartedKey
      ? gettingStartedDismissedState.value
      : readLocalStorageBoolean(gettingStartedKey);
  const gettingStartedManagedAiSelected =
    gettingStartedManagedAiSelectedState.key === managedAiSelectedKey
      ? gettingStartedManagedAiSelectedState.value
      : readLocalStorageBoolean(managedAiSelectedKey);
  const projectHasStoredHistory =
    projectHasStoredHistoryState.key === projectHistoryKey
      ? projectHasStoredHistoryState.value
      : readLocalStorageBoolean(projectHistoryKey);
  const conversationScopeAligned =
    Boolean(activeProjectId) && conversationsProjectKey === activeProjectId;

  useLayoutEffect(() => {
    setGettingStartedDismissedState({
      key: gettingStartedKey,
      value: readLocalStorageBoolean(gettingStartedKey),
    });
    setGettingStartedManagedAiSelectedState({
      key: managedAiSelectedKey,
      value: readLocalStorageBoolean(managedAiSelectedKey),
    });
    setProjectHasStoredHistoryState({
      key: projectHistoryKey,
      value: readLocalStorageBoolean(projectHistoryKey),
    });
    setForceGithubImport(false);
    setGettingStartedMode("root");
    clearGithubImportUi();
  }, [activeConversationId, clearGithubImportUi, gettingStartedKey, managedAiSelectedKey, projectHistoryKey]);

  const projectHasObservedHistory = useMemo(() => {
    if (!conversationScopeAligned) {
      return false;
    }
    return (conversations ?? []).some((conversation) => {
      if (!conversation) {
        return false;
      }
      if (conversation.hasRemoteMessages === true) {
        return true;
      }
      const conversationMessages = Array.isArray(conversation.messages) ? conversation.messages : [];
      return conversationMessages.some((message) => shouldDisplayChatMessage(message));
    });
  }, [conversationScopeAligned, conversations]);

  useEffect(() => {
    if (!conversationScopeAligned || !projectHasObservedHistory || projectHasStoredHistory) {
      return;
    }
    writeLocalStorageBoolean(projectHistoryKey, true);
    setProjectHasStoredHistoryState({ key: projectHistoryKey, value: true });
  }, [conversationScopeAligned, projectHasObservedHistory, projectHasStoredHistory, projectHistoryKey]);

  useEffect(() => {
    if (!conversationScopeAligned || displayedMessageCount <= 0 || projectHasStoredHistory) {
      return;
    }
    writeLocalStorageBoolean(projectHistoryKey, true);
    setProjectHasStoredHistoryState({ key: projectHistoryKey, value: true });
  }, [conversationScopeAligned, displayedMessageCount, projectHasStoredHistory, projectHistoryKey]);

  useEffect(() => {
    if (!conversationScopeAligned || !hasMoreHistory || projectHasStoredHistory) {
      return;
    }
    writeLocalStorageBoolean(projectHistoryKey, true);
    setProjectHasStoredHistoryState({ key: projectHistoryKey, value: true });
  }, [conversationScopeAligned, hasMoreHistory, projectHasStoredHistory, projectHistoryKey]);

  const projectHasConversationHistory =
    conversationScopeAligned &&
    (projectHasStoredHistory || projectHasObservedHistory || displayedMessageCount > 0);

  const onboardingInputLocked = useMemo(() => {
    return (
      runtimeControllerEnabled &&
      conversationScopeAligned &&
      Boolean(activeProjectId) &&
      anyAgentsEnabled &&
      !projectHasConversationHistory &&
      Boolean(credentialGateState) &&
      credentialGateState !== "checking" &&
      !credentialsReady
    );
  }, [
    activeProjectId,
    anyAgentsEnabled,
    conversationScopeAligned,
    credentialGateState,
    credentialsReady,
    projectHasConversationHistory,
    runtimeControllerEnabled,
  ]);

  // "full" is the card; "collapsed" is its one-line row of workspace actions,
  // shown while a draft is in the composer instead of unmounting the card.
  // Dismissal, history and the credential gate hide both.
  const gettingStartedPresentation = useMemo((): "full" | "collapsed" | null => {
    if (!activeProjectId) {
      return null;
    }
    if (!conversationScopeAligned) {
      return null;
    }
    // An explicit repo-import request overrides dismissal, history, and
    // context-relevance gates so repo import is never buried or lost.
    if (forceGithubImport && gettingStartedMode === "github" && !aiOnboardingOpen) {
      return "full";
    }
    if (!gettingStartedContextResolved || !gettingStartedContextRelevant) {
      return null;
    }
    if (gettingStartedDismissed) {
      return null;
    }
    if (runtimeControllerEnabled && !remoteHistoryPresenceResolved) {
      return null;
    }
    if ((credentialGateState && credentialGateState !== "checking") || aiOnboardingOpen) {
      return null;
    }
    if (gettingStartedMode === "github" && githubImportBusy) {
      return "full";
    }
    if (projectHasConversationHistory || displayedMessageCount > 0) {
      return null;
    }
    if (hasMoreHistory || isHistoryLoading) {
      return null;
    }
    if (inputValue.trim().length > 0) {
      // The GitHub mode was asked for explicitly (from the row or the menu),
      // so it stays open over a draft; the root card folds to its row.
      return gettingStartedMode === "github" ? "full" : "collapsed";
    }
    return "full";
  }, [
    activeProjectId,
    aiOnboardingOpen,
    conversationScopeAligned,
    credentialGateState,
    displayedMessageCount,
    forceGithubImport,
    gettingStartedDismissed,
    gettingStartedContextRelevant,
    gettingStartedContextResolved,
    gettingStartedMode,
    githubImportBusy,
    hasMoreHistory,
    inputValue,
    isHistoryLoading,
    projectHasConversationHistory,
    remoteHistoryPresenceResolved,
    runtimeControllerEnabled,
  ]);
  const shouldShowGettingStarted = gettingStartedPresentation !== null;
  const gettingStartedCollapsed = gettingStartedPresentation === "collapsed";

  const handleGettingStartedModeChange = useCallback(
    (mode: "root" | "github") => {
      setGettingStartedMode(mode);
      if (mode !== "github") {
        setForceGithubImport(false);
      }
      clearGithubImportUi();
    },
    [clearGithubImportUi],
  );

  const beginGithubImport = useCallback(() => {
    writeLocalStorageBoolean(gettingStartedKey, false);
    setGettingStartedDismissedState({ key: gettingStartedKey, value: false });
    setForceGithubImport(true);
    setGettingStartedMode("github");
    clearGithubImportUi();
  }, [clearGithubImportUi, gettingStartedKey]);

  const dismissGettingStarted = useCallback(() => {
    writeLocalStorageBoolean(gettingStartedKey, true);
    setGettingStartedDismissedState({ key: gettingStartedKey, value: true });
    setForceGithubImport(false);
    setGettingStartedMode("root");
    clearGithubImportUi();
  }, [clearGithubImportUi, gettingStartedKey]);

  const selectGettingStartedManagedAi = useCallback(() => {
    writeLocalStorageBoolean(managedAiSelectedKey, true);
    setGettingStartedManagedAiSelectedState({ key: managedAiSelectedKey, value: true });
    setForceGithubImport(false);
    setGettingStartedMode("root");
    clearGithubImportUi();
  }, [clearGithubImportUi, managedAiSelectedKey]);

  const clearGettingStartedManagedAiSelection = useCallback(() => {
    writeLocalStorageBoolean(managedAiSelectedKey, false);
    setGettingStartedManagedAiSelectedState({ key: managedAiSelectedKey, value: false });
    setGettingStartedMode("root");
    clearGithubImportUi();
  }, [clearGithubImportUi, managedAiSelectedKey]);

  // Nothing on the card prefills or focuses the composer any more: the card
  // points at it in one line and the composer's own placeholder does the
  // asking, so there is no second voice and no placeholder to plumb.
  return {
    beginGithubImport,
    clearGettingStartedManagedAiSelection,
    dismissGettingStarted,
    gettingStartedCollapsed,
    gettingStartedManagedAiSelected,
    gettingStartedMode,
    handleGettingStartedModeChange,
    onboardingInputLocked,
    projectHasConversationHistory,
    selectGettingStartedManagedAi,
    shouldShowGettingStarted,
  };
}
