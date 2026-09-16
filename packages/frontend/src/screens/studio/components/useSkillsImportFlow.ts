import { useCallback, useEffect, useRef, useState } from "react";
import type { SubmitConversationOptions } from "../../../conversations/conversationSubmitTypes";
import {
  buildSkillImportMessage,
  deriveSkillSourceLabel,
} from "../../../conversations/skillCommands";
import type { StatusToastOptions } from "../../../status/StatusProvider";

type ImportTaskParams = {
  source: string;
  skillName?: string | null;
  overwrite: boolean;
  /** Optional toast label ("Connecting <label>."); the tiles pass the product name. */
  label?: string;
};

type UseSkillsImportFlowParams = {
  /** Read at send time through a ref so a stale closure cannot send into a previous conversation. */
  activeConversationId: string | null;
  assistantEnabled: boolean;
  onSubmit: (
    conversationId: string | null,
    text: string,
    options?: SubmitConversationOptions,
  ) => Promise<unknown>;
  showStatus: (
    message: string,
    intent?: "info" | "success" | "warning" | "error",
    durationMs?: number,
    options?: StatusToastOptions,
  ) => void;
  loadSkills?: () => Promise<void>;
  /** Only ever invoked by the toast's "Open chat" action, never by the flow itself. */
  onOpenChat?: () => void;
};

// Every surface (Connect sheet, "Other" modal, Settings > Skills Import and a
// catalogue Install) sends exactly one line, in place, as a new turn:
// `/skills import <source>[ --name <name>][ --overwrite] --start` with
// `expectedLaneIdle: true`. The hook never creates a conversation, opens a
// tab, switches panels or pushes a URL.
export function useSkillsImportFlow({
  activeConversationId,
  assistantEnabled,
  onSubmit,
  showStatus,
  loadSkills,
  onOpenChat,
}: UseSkillsImportFlowParams) {
  const [importSource, setImportSource] = useState("");
  const [importName, setImportName] = useState("");
  const [importOverwrite, setImportOverwrite] = useState(false);
  const [importPending, setImportPending] = useState(false);
  const [addSkillModalOpen, setAddSkillModalOpen] = useState(false);

  const refreshTimeoutRef = useRef<number[]>([]);
  const activeConversationIdRef = useRef(activeConversationId);
  const assistantEnabledRef = useRef(assistantEnabled);
  const onSubmitRef = useRef(onSubmit);
  const loadSkillsRef = useRef(loadSkills);
  const onOpenChatRef = useRef(onOpenChat);

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    assistantEnabledRef.current = assistantEnabled;
  }, [assistantEnabled]);

  useEffect(() => {
    onSubmitRef.current = onSubmit;
  }, [onSubmit]);

  useEffect(() => {
    loadSkillsRef.current = loadSkills;
  }, [loadSkills]);

  useEffect(() => {
    onOpenChatRef.current = onOpenChat;
  }, [onOpenChat]);

  const clearRefreshTimeouts = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }
    for (const timeoutId of refreshTimeoutRef.current) {
      window.clearTimeout(timeoutId);
    }
    refreshTimeoutRef.current = [];
  }, []);

  useEffect(() => {
    return () => {
      clearRefreshTimeouts();
    };
  }, [clearRefreshTimeouts]);

  const queueSkillImportTask = useCallback(
    async (params: ImportTaskParams) => {
      const source = params.source.trim();
      if (!source) {
        return false;
      }
      if (!assistantEnabledRef.current) {
        showStatus("Turn on AI for this chat, then add skills.", "warning", 4000);
        return false;
      }

      setImportPending(true);
      try {
        const text = buildSkillImportMessage({
          source,
          skillName: params.skillName,
          overwrite: params.overwrite,
          start: true,
        });
        await onSubmitRef.current(activeConversationIdRef.current, text, {
          expectedLaneIdle: true,
        });
        clearRefreshTimeouts();
        const refresh = loadSkillsRef.current;
        if (refresh && typeof window !== "undefined") {
          refreshTimeoutRef.current = [
            window.setTimeout(() => {
              void refresh();
            }, 2000),
            window.setTimeout(() => {
              void refresh();
            }, 7000),
          ];
        }
        const openChat = onOpenChatRef.current;
        showStatus(
          params.label
            ? `Connecting ${params.label}.`
            : `Adding skills from ${deriveSkillSourceLabel(source)}.`,
          "info",
          3500,
          openChat ? { actionLabel: "Open chat", onAction: openChat } : undefined,
        );
        return true;
      } catch (queueError) {
        const message = queueError instanceof Error ? queueError.message : "Unable to add skills.";
        showStatus(message, "error", 4500);
        return false;
      } finally {
        setImportPending(false);
      }
    },
    [clearRefreshTimeouts, showStatus],
  );

  const handleSubmitImport = useCallback(
    async (options?: { closeModalOnSuccess?: boolean }) => {
      const source = importSource.trim();
      if (!source) {
        showStatus("Enter a skill source URL or path.", "warning", 3000);
        return;
      }

      const queued = await queueSkillImportTask({
        source,
        skillName: importName,
        overwrite: importOverwrite,
      });
      if (!queued) {
        return;
      }

      setImportSource("");
      setImportName("");
      setImportOverwrite(false);
      if (options?.closeModalOnSuccess) {
        setAddSkillModalOpen(false);
      }
    },
    [importName, importOverwrite, importSource, queueSkillImportTask, showStatus],
  );

  const handleOpenAddSkillModal = useCallback((prefill?: { source?: string; name?: string }) => {
    if (prefill?.source != null) {
      setImportSource(prefill.source);
    }
    if (prefill?.name != null) {
      setImportName(prefill.name);
    }
    setAddSkillModalOpen(true);
  }, []);

  return {
    importSource,
    setImportSource,
    importName,
    setImportName,
    importOverwrite,
    setImportOverwrite,
    importPending,
    addSkillModalOpen,
    setAddSkillModalOpen,
    queueSkillImportTask,
    handleSubmitImport,
    handleOpenAddSkillModal,
  };
}
