import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildGithubImportFollowupMessage,
  consumeGithubImportFollowups,
  GITHUB_IMPORT_FOLLOWUP_EVENT,
} from "../../../conversations/githubImportFollowup";
import type { StatusIntent } from "../../../status/useStatus";
import type { ChatMessage } from "../types";
import { useDeviceAuthFlow } from "./device-auth/useDeviceAuthFlow";
import {
  executeGithubProjectImport,
  formatGithubImportSuccessMessage,
} from "./githubImport";
import { deriveGithubImportTargetPath } from "../../../services/runtimeController/githubImportPath";
import { buildGithubImportRetryIdentity } from "./githubImportRetryRegistry";

type ShowStatus = (message: string, intent?: StatusIntent, durationMs?: number) => void;
type AppendMessages = (conversationId: string, messages: ChatMessage[]) => void;
type RecordMessage = (
  conversationId: string,
  content: string,
  metadata?: Record<string, unknown> | null,
  role?: ChatMessage["role"],
) => Promise<ChatMessage | null>;

type UseChatGithubImportFlowOptions = {
  activeConversationId: string | null;
  activeProjectId: string | null;
  appendMessages: AppendMessages;
  onImportSuccess: () => void;
  onRecordMessage?: RecordMessage;
  showStatus: ShowStatus;
};

export function useChatGithubImportFlow({
  activeConversationId,
  activeProjectId,
  appendMessages,
  onImportSuccess,
  onRecordMessage,
  showStatus,
}: UseChatGithubImportFlowOptions) {
  const activeScopeKey = useMemo(
    () => `${activeProjectId ?? "no-project"}:${activeConversationId ?? "no-conversation"}`,
    [activeConversationId, activeProjectId],
  );
  const activeScopeKeyRef = useRef(activeScopeKey);
  activeScopeKeyRef.current = activeScopeKey;
  const deviceAuthScopeKeyRef = useRef<string | null>(null);
  const handleDeviceAuthCompleted = useCallback(async () => {
    if (deviceAuthScopeKeyRef.current !== activeScopeKeyRef.current) {
      return { success: true as const };
    }
    showStatus("GitHub connected.", "success", 3000);
    return { success: true as const };
  }, [showStatus]);
  const [githubRepoDraft, setGithubRepoDraft] = useState("");
  const [githubRefDraft, setGithubRefDraft] = useState("");
  const [githubImportBusy, setGithubImportBusy] = useState(false);
  const [githubImportElapsedSeconds, setGithubImportElapsedSeconds] = useState(0);
  const [githubImportError, setGithubImportError] = useState<string | null>(null);

  const githubDeviceAuth = useDeviceAuthFlow({
    onCompleted: handleDeviceAuthCompleted,
  });
  const githubDeviceAuthSession = githubDeviceAuth.session;
  const githubDeviceAuthError = githubDeviceAuth.error;
  const beginGithubDeviceAuthFlow = githubDeviceAuth.begin;
  const cancelGithubDeviceAuthFlow = githubDeviceAuth.cancel;
  const clearGithubDeviceAuthError = githubDeviceAuth.clearError;
  const resetGithubDeviceAuthFlow = githubDeviceAuth.reset;
  const previousScopeKeyRef = useRef(activeScopeKey);

  useEffect(() => {
    if (previousScopeKeyRef.current === activeScopeKey) {
      return;
    }
    previousScopeKeyRef.current = activeScopeKey;
    deviceAuthScopeKeyRef.current = null;
    resetGithubDeviceAuthFlow();
    setGithubRepoDraft("");
    setGithubRefDraft("");
    setGithubImportBusy(false);
    setGithubImportElapsedSeconds(0);
    setGithubImportError(null);
  }, [activeScopeKey, resetGithubDeviceAuthFlow]);

  const clearGithubImportUi = useCallback(() => {
    setGithubImportError(null);
    clearGithubDeviceAuthError();
  }, [clearGithubDeviceAuthError]);

  const handleGithubRepoDraftChange = useCallback((value: string) => {
    setGithubRepoDraft(value);
    setGithubImportError(null);
  }, []);

  const handleGithubRefDraftChange = useCallback((value: string) => {
    setGithubRefDraft(value);
    setGithubImportError(null);
  }, []);

  const beginGithubDeviceAuth = useCallback(async () => {
    if (githubImportBusy) {
      return;
    }
    deviceAuthScopeKeyRef.current = activeScopeKey;
    clearGithubImportUi();
    await beginGithubDeviceAuthFlow({ provider: "github" });
  }, [activeScopeKey, beginGithubDeviceAuthFlow, clearGithubImportUi, githubImportBusy]);

  const cancelGithubDeviceAuthSession = useCallback(async () => {
    clearGithubDeviceAuthError();
    await cancelGithubDeviceAuthFlow();
  }, [cancelGithubDeviceAuthFlow, clearGithubDeviceAuthError]);

  useEffect(() => {
    if (!githubImportBusy) {
      setGithubImportElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setGithubImportElapsedSeconds(0);
    const intervalId = window.setInterval(() => {
      setGithubImportElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [githubImportBusy]);

  const handleImportGithub = useCallback(async () => {
    if (!activeProjectId) {
      setGithubImportError("Pick a space first.");
      return false;
    }
    if (githubImportBusy) {
      return false;
    }
    const repo = githubRepoDraft.trim();
    if (!repo) {
      setGithubImportError("Paste a GitHub repo URL (or owner/repo).");
      return false;
    }
    const operationScopeKey = activeScopeKey;
    const operationProjectId = activeProjectId;
    setGithubImportError(null);
    setGithubImportBusy(true);
    try {
      const gitRef = githubRefDraft.trim() || null;
      const targetPath = deriveGithubImportTargetPath(repo);
      const importIdentity = buildGithubImportRetryIdentity({
        projectId: operationProjectId,
        sourceMessageId: `onboarding:${activeConversationId ?? "new-conversation"}`,
        repo,
        ref: gitRef,
        targetPath,
      });
      const importResult = await executeGithubProjectImport({
        projectId: operationProjectId,
        repo,
        ref: gitRef,
        targetPath,
        githubDeviceAuthSessionId:
          githubDeviceAuthSession?.status === "completed" ? githubDeviceAuthSession.sessionId : null,
        idempotencyKey: importIdentity.idempotencyKey,
      });
      if (activeScopeKeyRef.current !== operationScopeKey) {
        return importResult.success;
      }
      if (!importResult.success) {
        setGithubImportError(importResult.error ?? "GitHub import failed.");
        return false;
      }
      showStatus(
        formatGithubImportSuccessMessage({
          repo,
          fileCount: importResult.fileCount ?? null,
          targetPath: importResult.targetPath ?? null,
        }),
        "success",
        3500,
      );
      onImportSuccess();
      return true;
    } catch (error) {
      if (activeScopeKeyRef.current !== operationScopeKey) {
        return false;
      }
      const message = error instanceof Error ? error.message : String(error);
      setGithubImportError(message);
      return false;
    } finally {
      if (activeScopeKeyRef.current === operationScopeKey) {
        setGithubImportBusy(false);
      }
    }
  }, [
    activeScopeKey,
    activeConversationId,
    activeProjectId,
    githubDeviceAuthSession,
    githubImportBusy,
    githubRefDraft,
    githubRepoDraft,
    onImportSuccess,
    showStatus,
  ]);

  const flushGithubImportFollowups = useCallback(() => {
    if (!activeProjectId || !activeConversationId) {
      return;
    }
    const records = consumeGithubImportFollowups(activeProjectId);
    if (records.length === 0) {
      return;
    }
    void Promise.all(
      records.map(async (record) => {
        const message = buildGithubImportFollowupMessage(record);
        const recordedMessage = onRecordMessage
          ? await onRecordMessage(
              activeConversationId,
              message.content,
              (message.metadata as Record<string, unknown> | null) ?? null,
              "assistant",
            ).catch(() => null)
          : null;
        appendMessages(activeConversationId, [recordedMessage ?? message]);
      }),
    );
  }, [activeConversationId, activeProjectId, appendMessages, onRecordMessage]);

  useEffect(() => {
    flushGithubImportFollowups();
  }, [flushGithubImportFollowups]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handler = () => {
      flushGithubImportFollowups();
    };
    window.addEventListener(GITHUB_IMPORT_FOLLOWUP_EVENT, handler as EventListener);
    return () => {
      window.removeEventListener(GITHUB_IMPORT_FOLLOWUP_EVENT, handler as EventListener);
    };
  }, [flushGithubImportFollowups]);

  return {
    beginGithubDeviceAuth,
    cancelGithubDeviceAuthSession,
    clearGithubImportUi,
    githubDeviceAuthError,
    githubDeviceAuthSession,
    githubImportBusy,
    githubImportElapsedSeconds,
    githubImportError,
    githubRepoDraft,
    githubRefDraft,
    handleGithubRepoDraftChange,
    handleGithubRefDraftChange,
    handleImportGithub,
  };
}
