import { useCallback, useEffect, useRef, useState } from "react";
import { useConversations } from "../conversations/ConversationsProvider";
import { useProject } from "../projects/useProject";
import { controllerClient } from "../sdk/instafy";
import { useStatus } from "../status/useStatus";
import { isUUID } from "../utils/uuid";
import { useWorkspaceTabs } from "./WorkspaceTabsProvider";

/** Shared by chat rows and the legacy tab menu; keep thread permissions unchanged. */
export function useStartConversationThread(onStarted?: () => void) {
  const { conversations, createConversation, setConversationControllerId } = useConversations();
  const { activeProjectId } = useProject();
  const { showStatus } = useStatus();
  const { openConversationTab, requestUrlPush } = useWorkspaceTabs();
  const [pending, setPending] = useState<{ projectId: string; conversationId: string } | null>(null);
  const projectRef = useRef(activeProjectId);
  projectRef.current = activeProjectId;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  // Wait for the locally created conversation to reach the provider before opening it.
  useEffect(() => {
    if (!pending) return;
    setPending(null);
    if (pending.projectId !== activeProjectId) return;
    requestUrlPush();
    openConversationTab(pending.conversationId);
    onStarted?.();
  }, [activeProjectId, onStarted, openConversationTab, pending, requestUrlPush]);

  return useCallback(async (parentId: string) => {
    const parent = conversations.find(conversation => conversation.localId === parentId);
    if (!parent || !activeProjectId || !isUUID(activeProjectId)) return;
    const projectId = activeProjectId;
    const stillCurrent = () => mounted.current && projectRef.current === projectId;
    try {
      let parentControllerId = parent.controllerId;
      if (!parentControllerId) {
        const response = await controllerClient.conversations.createBlank({
          projectId,
          metadata: { title: parent.title, localId: parent.localId, visibility: parent.visibility },
        });
        if (!stillCurrent()) return;
        if (!response?.conversationId) throw new Error("Parent conversation unavailable");
        parentControllerId = response.conversationId;
        setConversationControllerId(parent.localId, parentControllerId);
      }
      const count = conversations.filter(conversation => conversation.parentConversationId === parentControllerId &&
        (conversation.threadKind ?? "thread") === "thread").length;
      const title = `Thread ${count + 1}`;
      const thread = createConversation({ title, visibility: parent.visibility,
        parentConversationId: parentControllerId, threadKind: "thread", select: false });
      const response = await controllerClient.conversations.createBlank({
        projectId,
        metadata: { title, localId: thread.localId, visibility: thread.visibility },
        parentConversationId: parentControllerId, threadKind: "thread",
      });
      if (!stillCurrent()) return;
      if (!response?.conversationId) throw new Error("Thread conversation unavailable");
      setConversationControllerId(thread.localId, response.conversationId);
      setPending({ projectId, conversationId: thread.localId });
    } catch {
      if (stillCurrent()) showStatus("Could not create the thread. Try again shortly.", "error", 4000);
    }
  }, [activeProjectId, conversations, createConversation, setConversationControllerId, showStatus]);
}
