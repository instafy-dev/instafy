import { useEffect, useRef } from "react";
import { StudioDialogHeader } from "../../../components/aria/StudioDialogLayout";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { useConversations, type ConversationState } from "../../../conversations/ConversationsProvider";
import { useStudioNavigation } from "../../../navigation/useStudioNavigation";
import {
  prepareSpaceRecommendationConversation,
  prepareSpaceReviewConversation,
  type SpaceRecommendation,
} from "../../../services/runtimeController/spaceRecommendations";
import { useStatus } from "../../../status/useStatus";
import { useWorkspaceTabs } from "../../../workspace/WorkspaceTabsProvider";
import { SpaceRecommendations } from "./SpaceRecommendations";

export const SPACE_REVIEW_PROMPT = [
  "@octo Use the instafy-space-review skill at .agents/skills/instafy-space-review/SKILL.md to review this space.",
  "Read prior recommendations and their outcomes first, then review a bounded selection of recent shared chats and this review's history.",
  "Find up to three useful next steps, unresolved decisions, or follow-ups. Link each finding to the conversation or message that supports it.",
  "Save grounded recommendations with the recommendations CLI. Preserve accepted and dismissed decisions; do not repeat work that is already complete.",
  "If there is no evidence-backed next step, say so. For an empty space, offer a useful starting question without inventing findings.",
  "Only review and save recommendations. Do not edit project files, archive chats, change priorities, contact people, or create automations.",
].join("\n\n");

type PreparedDraft = { conversation: ConversationState; controllerId: string };

/** Mounted only while open; async handoffs never move a user who left this space. */
export function SpaceReviewDialog({ projectId, canWrite, onClose }: {
  projectId: string;
  canWrite: boolean;
  onClose: () => void;
}) {
  const { conversations, createConversation, setConversationDraft, setConversationLifecycleStatus } = useConversations();
  const { openConversationTab, requestUrlPush } = useWorkspaceTabs();
  const goToStudio = useStudioNavigation();
  const { showStatus } = useStatus();
  const current = useRef({ conversations, canWrite });
  current.current = { conversations, canWrite };
  const mounted = useRef(true);
  const pendingHandoff = useRef<PreparedDraft | null>(null);
  const actionDrafts = useRef(new Map<string, PreparedDraft>());
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const stageDraft = (controllerId: string, title: string, prompt: string, preserveExistingDraft = false): PreparedDraft => {
    const existing = current.current.conversations.find((item) => item.controllerId === controllerId);
    if (!preserveExistingDraft && existing?.draft.trim() && existing.draft !== prompt) {
      throw new Error("Your review chat has an unsent draft. Send or clear it before preparing another review.");
    }
    const conversation = existing ?? createConversation({
      localId: controllerId,
      controllerId,
      title,
      visibility: "private",
      assistantEnabled: true,
      select: false,
    });
    if (existing && existing.lifecycleStatus !== "active") {
      setConversationLifecycleStatus(existing.localId, "active");
    }
    if (preserveExistingDraft && existing?.draft.trim()) {
      return { conversation: { ...conversation, lifecycleStatus: "active" }, controllerId };
    }
    setConversationDraft(conversation.localId, prompt);
    return { conversation: { ...conversation, lifecycleStatus: "active", draft: prompt, draftEditorState: null }, controllerId };
  };

  const prepareReview = async (): Promise<boolean> => {
    if (!current.current.canWrite) return false;
    const { conversationId } = await prepareSpaceReviewConversation(projectId);
    if (!mounted.current || !current.current.canWrite) return false;
    pendingHandoff.current = stageDraft(conversationId, "Space review", SPACE_REVIEW_PROMPT);
    return true;
  };

  const prepareAction = async (recommendation: SpaceRecommendation) => {
    if (!current.current.canWrite) return false;
    let draft = actionDrafts.current.get(recommendation.id);
    if (!draft) {
      const created = await prepareSpaceRecommendationConversation(projectId, recommendation.id);
      if (!mounted.current || !current.current.canWrite) return false;
      const references = recommendation.evidence.map((source) => source.messageId
        ? `[[message:${source.conversationId}/${source.messageId}|Source message]]`
        : `[[conversation:${source.conversationId}|Source conversation]]`);
      draft = stageDraft(created.conversationId, recommendation.title,
        [recommendation.prompt, "", "Context:", ...references].join("\n"), true);
      actionDrafts.current.set(recommendation.id, draft);
    }
    pendingHandoff.current = draft;
    return { acceptedConversationId: draft.controllerId };
  };

  const finishHandoff = () => {
    const draft = pendingHandoff.current;
    if (!mounted.current || !draft || !current.current.canWrite) return;
    pendingHandoff.current = null;
    requestUrlPush();
    openConversationTab(draft.conversation.localId, { fallbackConversation: draft.conversation });
    onClose();
    showStatus("Your private draft is ready. Send it when you’re ready to start.", "info", 4500);
  };

  return (
    <StudioDialogModal
      isOpen
      isDismissable
      onOpenChange={(open) => { if (!open) onClose(); }}
      modalClassName="max-h-[85dvh] overflow-y-auto overscroll-contain"
      dialogAriaLabel="Space review"
      data-testid="space-review-dialog"
    >
      <StudioDialogHeader title="Space review" onClose={onClose} closeLabel="Close space review" />
      <div className="px-5 py-4">
        <SpaceRecommendations
          projectId={projectId}
          canWrite={canWrite}
          onReview={prepareReview}
          onUseRecommendation={prepareAction}
          onHandoffComplete={finishHandoff}
          onOpenEvidence={(evidence) => {
            onClose();
            goToStudio({ kind: "conversation", projectId,
              conversationControllerId: evidence.conversationId, messageId: evidence.messageId });
          }}
        />
      </div>
    </StudioDialogModal>
  );
}
