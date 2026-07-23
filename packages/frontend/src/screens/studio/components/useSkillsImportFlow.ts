import { useCallback, useEffect, useRef, useState } from "react";

type ImportTaskParams = {
  source: string;
  skillName?: string | null;
  overwrite: boolean;
};

type UseSkillsImportFlowParams = {
  conversations: Array<{ localId: string }>;
  createConversation: (params: { title: string; select: boolean }) => { localId: string; title: string };
  onSubmit: (conversationId: string, text: string) => Promise<unknown>;
  openConversationTab: (conversationId: string) => void;
  requestUrlPush: () => void;
  openPanelTab: (panel: "chat" | "code") => void;
  showStatus: (message: string, intent?: "info" | "success" | "warning" | "error", durationMs?: number) => void;
  loadSkills: () => Promise<void>;
  buildImportTaskPrompt: (params: ImportTaskParams) => string;
  normalizeSkillName: (value: string) => string;
  humanizeSkillName: (value: string) => string;
  deriveSkillNameHintFromImportSource: (source: string) => string | null;
};

export function useSkillsImportFlow({
  conversations,
  createConversation,
  onSubmit,
  openConversationTab,
  requestUrlPush,
  openPanelTab,
  showStatus,
  loadSkills,
  buildImportTaskPrompt,
  normalizeSkillName,
  humanizeSkillName,
  deriveSkillNameHintFromImportSource,
}: UseSkillsImportFlowParams) {
  const [importSource, setImportSource] = useState("");
  const [importName, setImportName] = useState("");
  const [importOverwrite, setImportOverwrite] = useState(false);
  const [importPending, setImportPending] = useState(false);
  const [addSkillModalOpen, setAddSkillModalOpen] = useState(false);
  const [lastQueuedTask, setLastQueuedTask] = useState<string | null>(null);

  const refreshTimeoutRef = useRef<number[]>([]);
  const conversationsRef = useRef(conversations);
  const onSubmitRef = useRef(onSubmit);
  const openConversationTabRef = useRef(openConversationTab);
  const requestUrlPushRef = useRef(requestUrlPush);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    onSubmitRef.current = onSubmit;
  }, [onSubmit]);

  useEffect(() => {
    openConversationTabRef.current = openConversationTab;
  }, [openConversationTab]);

  useEffect(() => {
    requestUrlPushRef.current = requestUrlPush;
  }, [requestUrlPush]);

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
      const normalizedName =
        normalizeSkillName(params.skillName ?? "") ||
        deriveSkillNameHintFromImportSource(source) ||
        "imported-skill";
      const taskConversation = createConversation({
        title: `${humanizeSkillName(normalizedName)} Skill import`,
        select: false,
      });

      setImportPending(true);

      try {
        const waitDeadline = Date.now() + 2_000;
        while (Date.now() < waitDeadline) {
          const exists = conversationsRef.current.some(
            (conversation) => conversation.localId === taskConversation.localId,
          );
          if (exists) {
            break;
          }
          await new Promise((resolve) => {
            if (typeof window === "undefined") {
              setTimeout(resolve, 16);
            } else {
              window.setTimeout(resolve, 16);
            }
          });
        }

        requestUrlPushRef.current();
        openConversationTabRef.current(taskConversation.localId);
        openPanelTab("chat");

        await onSubmitRef.current(taskConversation.localId, buildImportTaskPrompt(params));
        setLastQueuedTask(`Skill import task for ${source}`);
        clearRefreshTimeouts();
        if (typeof window !== "undefined") {
          refreshTimeoutRef.current = [
            window.setTimeout(() => {
              void loadSkills();
            }, 2000),
            window.setTimeout(() => {
              void loadSkills();
            }, 7000),
          ];
        }
        showStatus(`Started "${taskConversation.title}" conversation task.`, "info", 3500);
        return true;
      } catch (queueError) {
        const message =
          queueError instanceof Error ? queueError.message : "Unable to start skill import task.";
        showStatus(message, "error", 4500);
        return false;
      } finally {
        setImportPending(false);
      }
    },
    [
      buildImportTaskPrompt,
      clearRefreshTimeouts,
      createConversation,
      deriveSkillNameHintFromImportSource,
      humanizeSkillName,
      loadSkills,
      normalizeSkillName,
      openPanelTab,
      showStatus,
    ],
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

  const handleOpenAssistant = useCallback(() => {
    requestUrlPush();
    openPanelTab("chat");
  }, [openPanelTab, requestUrlPush]);

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
    lastQueuedTask,
    queueSkillImportTask,
    handleSubmitImport,
    handleOpenAddSkillModal,
    handleOpenAssistant,
  };
}
