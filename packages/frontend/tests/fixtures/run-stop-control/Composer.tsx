import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChatComposerSurface } from "../../../src/screens/studio/components/ChatComposerSurface";
import { ChatImageLightboxOverlay } from "../../../src/screens/studio/components/ChatPanelOverlays";
import type { ChatRunStopController } from "../../../src/screens/studio/components/useChatRunStop";
import type { ChatInputHandle } from "../../../src/screens/studio/components/chat-input/ChatInput";
import { useQueueReview } from "./useQueueReview";
import type { ControllerMessageStash } from "../../../src/services/runtimeController/messageStashes";
import type { ConversationGoal, ConversationGoalStatus } from "../../../src/conversations/conversationGoals";
import type { PendingChatImageAttachment } from "../../../src/screens/studio/components/useChatComposerAttachments";
import reviewImageUrl from "../../../public/og-image.png?inline";

const noop = () => {};
const reviewImageBytes = Uint8Array.from(atob(reviewImageUrl.split(",")[1]), character => character.charCodeAt(0));

/** The real composer and Lexical editor; only submission and peripheral panes are inert. */
export function Composer({ controller, readOnly, recording, viewNavigation, queueReview, utilityReview, attachmentCount, attachmentSending = false, fullPage = false, newTab = false }: { controller: ChatRunStopController; readOnly: boolean; recording: boolean; viewNavigation?: ReactNode; queueReview?: { count: number; initialDraft?: string; withStash?: boolean }; utilityReview?: { goalStatus: "active" | "paused" | "blocked" }; attachmentCount?: number; attachmentSending?: boolean; fullPage?: boolean; newTab?: boolean }) {
  const overlay = useRef<HTMLDivElement>(null);
  const input = useRef<ChatInputHandle>(null);
  const image = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(queueReview?.initialDraft ?? "");
  const [editorState, setEditorState] = useState<string | null>(null);
  const [sent, setSent] = useState<string[]>([]);
  const [imageLightbox, setImageLightbox] = useState<{ src: string; alt: string } | null>(null);
  useEffect(() => {
    if (!imageLightbox) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setImageLightbox(null); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [imageLightbox]);
  const [stashes, setStashes] = useState<ControllerMessageStash[]>(() => queueReview?.withStash ? (utilityReview ? [
    "Compare keyboard navigation and touch targets across the browser pages before sharing the design review",
    "Follow up on the saved research notes", "A short reminder",
  ] : ["Draft idea to come back to later"]).map((text, index) => ({
    id: index ? `fixture-stash-${index}` : "fixture-stash", clientStashId: index ? `fixture-stash-${index}` : "fixture-stash", projectId: "fixture-project", conversationId: "fixture-conversation",
    text, editorState: null, composerEnvelope: {},
    createdAt: "2026-10-23T00:00:00Z", updatedAt: "2026-10-23T00:00:00Z",
  })) : []);
  const [goalStatus, setGoalStatus] = useState<ConversationGoalStatus | null>(utilityReview?.goalStatus ?? null);
  const goal: ConversationGoal | null = goalStatus ? {
    id: "review-goal", objective: "Compare the browser research notes", status: goalStatus,
    doneWhen: null, stopWhen: null, progressSummary: null, parentGoalId: null,
    createdAt: "2026-10-25T00:00:00Z", updatedAt: "2026-10-25T00:00:00Z", createdBy: null, updatedBy: null,
  } : null;
  const [attachments, setAttachments] = useState<PendingChatImageAttachment[]>(() => Array.from({ length: attachmentCount ?? (utilityReview ? 1 : 0) }, (_, index) => ({
    id: `review-image-${index}`, file: new File([reviewImageBytes], index === 0 ? "social-card-review.png" : `social-card-review-with-a-long-filename-for-responsive-attachment-preview-${index + 1}.png`, { type: "image/png" }),
    sending: attachmentSending,
    previewUrl: reviewImageUrl,
  })));
  const [restoredStashId, setRestoredStashId] = useState<string | null>(null);
  const [newTabPending, setNewTabPending] = useState(newTab);
  const onDraftChange = useCallback((value: string, state: string | null) => { setDraft(value); setEditorState(state); }, []);
  const focusInput = useCallback(() => input.current?.focus(), []);
  const queue = useQueueReview({ count: queueReview?.count ?? 0, draft, editorState, onDraftChange, focusInput, setSent, readOnly });
  const send = () => {
    if (queue.editing && !queue.editing.restoreOnly) {
      queue.props.onRequeueEditedMessage();
      return;
    }
    if (!draft.trim()) return;
    setSent(current => [...current, draft]);
    setDraft("");
    setEditorState(null);
  };
  return <>
    <div className={[fullPage ? "" : "relative", viewNavigation ? "min-h-48" : "min-h-28"].filter(Boolean).join(" ")} data-testid="composer-preview">
      <ChatComposerSurface
        composerOverlayRef={overlay} composerAutoHidden={false} compactBrowserViewport={matchMedia("(max-width: 639px)").matches}
        viewNavigation={viewNavigation} touchLikeInput={Boolean(viewNavigation)}
        pendingNewTab={newTabPending ? { onCancel: () => setNewTabPending(false) } : null}
        onSubmit={event => { event.preventDefault(); send(); }}
        queueSurfaceProps={queue.props}
        stashTrayProps={queueReview?.withStash ? { stashes, restoredStashId, busy: readOnly,
          onRestore: stash => { if (!draft.trim()) { onDraftChange(stash.text, null); setRestoredStashId(stash.id); } },
          onDelete: id => setStashes(current => current.filter(stash => stash.id !== id)),
        } : null}
        activeGoal={goal} activeGoalHealth={goal ? {
          turnCount: 3, maxTurns: 8, label: goalStatus === "blocked" ? "Needs input" : goalStatus === "paused" ? "Paused" : "In progress",
          detail: "Review the saved comparison before continuing. The examples use local fixture data and do not send a request.",
          tone: goalStatus === "blocked" ? "blocked" : goalStatus === "paused" ? "paused" : "active", progressRatio: .4,
          stagnation: { level: goalStatus === "blocked" ? "blocked" : "none", reason: "none", summary: null },
        } : null} onPauseGoal={() => setGoalStatus("paused")} onResumeGoal={() => setGoalStatus("active")} onClearGoal={() => setGoalStatus(null)}
        onHelpUnblockGoal={() => { setDraft("Help me review the remaining comparison"); setEditorState(null); }} goalDetailsCollapseToken={0} nativeKeyboardOpen={false} onboardingInputLocked={false}
        onDragOver={noop} onDrop={noop} chatInputRef={input}
        chatInputProps={{ draftKey: "playground-draft", value: draft, editorState, placeholder: "Message Octo…",
          agentHandles: ["octo", "scribe"], onChange: onDraftChange,
          onKeyDown: event => { if (!viewNavigation && event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } } }}
        imageInputRef={image} onImageInputChange={noop} imageAttachments={attachments} onOpenImage={(src, alt) => setImageLightbox({ src, alt })} onRemoveImageAttachment={id => setAttachments(current => current.filter(attachment => attachment.id !== id))}
        showVoiceStatus={recording} voiceStatusMessage={recording ? "Recording…" : ""} providerTriggerNoticeProps={null}
        showComposerNavigationButton={new URLSearchParams(location.search).get("navigation") === "compact"}
        composerNavigationDestination={viewNavigation ? "sheet" : "chats"} onOpenNavigation={noop} homeAttentionCount={0} homeAttentionBadge=""
        composerActionMenuProps={{ pendingNewBrowser: false, onOpenBrowser: noop, onOpenNewBrowser: noop,
          onOpenInvite: noop, onImportGithubRepo: noop, onInsertCommand: value => { setDraft(value); setEditorState(null); },
          showBrowserAction: false, showNewBrowserAction: false, showInviteAction: false }}
        onOpenImagePicker={noop} imageUploadUnavailableReason="Attachments are disabled in this playground."
        sendingAttachment={false} showMobileGhostSuggestionAcceptButton={false} onAcceptGhostSuggestion={noop}
        showVoicePrimaryAction={recording || Boolean(viewNavigation && !draft.trim())} showVoiceSecondaryAction={Boolean(viewNavigation && draft.trim())}
        voiceConversationActionStripProps={{ showVoiceRepliesToggle: false, voiceActionActive: recording,
          voiceListening: recording, voiceStarting: false, voiceTranscribing: false, voiceState: recording ? "recording" : "idle",
          voiceRoute: "fixture", voiceCapture: "fixture", onVoicePressStart: noop, onVoicePressEnd: noop,
          onVoiceTap: noop, voiceInteractionMode: "tap" }}
        sendButtonDisabled={readOnly || recording} sendButtonVariant={draft.trim() ? "primary" : "ghost"}
        onSendButtonPress={send} composerGhostActionClass="[&_svg]:text-slate-600 dark:[&_svg]:text-slate-300"
        composerPrimaryActionClass="shadow-none" composerActionIconClass="h-[22px] w-[22px]"
        inviteModalProps={{ isOpen: false, onOpenChange: noop, mentionableUsers: [], inviteParticipantIdSet: new Set(),
          inviteParticipantBusyUserId: null, inviteParticipantsLoading: false, onInviteTeammate: async () => {},
          activeConversationVisibility: null, activeConversationControllerId: null, activeOrgId: null, activeProjectId: null,
          canShareProject: false, canWriteProject: false, sharingPermissionsLoading: false }}
        mutationDisabled={readOnly} composerRunStopController={controller}
      />
    </div>
    <ChatImageLightboxOverlay imageLightbox={imageLightbox} onClose={() => setImageLightbox(null)} />
    <output hidden data-testid="composer-draft">{draft}</output>
    <output hidden data-testid="sent-messages">{JSON.stringify(sent)}</output>
    <output hidden data-testid="queue-order">{JSON.stringify(queue.items.map(item => item.id))}</output>
    <output hidden data-testid="queue-messages">{JSON.stringify(queue.items.map(item => item.message))}</output>
    {utilityReview ? <output hidden data-testid="review-goal-status">{goalStatus ?? "cleared"}</output> : null}
    {newTab ? <output hidden data-testid="review-new-tab-pending">{String(newTabPending)}</output> : null}
    {queue.status ? <p role="status" data-testid="queue-status" className="pointer-events-none fixed left-4 right-4 top-20 mx-auto max-w-md rounded-lg bg-slate-900 px-3 py-2 text-sm text-white">{queue.status}</p> : null}
  </>;
}
