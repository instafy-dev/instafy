import { useCallback, useRef, useState, type ReactNode } from "react";
import { ChatComposerSurface } from "../../../src/screens/studio/components/ChatComposerSurface";
import type { ChatRunStopController } from "../../../src/screens/studio/components/useChatRunStop";
import type { ChatInputHandle } from "../../../src/screens/studio/components/chat-input/ChatInput";
import { useQueueReview } from "./useQueueReview";
import type { ControllerMessageStash } from "../../../src/services/runtimeController/messageStashes";

const noop = () => {};

/** The real composer and Lexical editor; only submission and peripheral panes are inert. */
export function Composer({ controller, readOnly, recording, viewNavigation, queueReview }: { controller: ChatRunStopController; readOnly: boolean; recording: boolean; viewNavigation?: ReactNode; queueReview?: { count: number; initialDraft?: string; withStash?: boolean } }) {
  const overlay = useRef<HTMLDivElement>(null);
  const input = useRef<ChatInputHandle>(null);
  const image = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(queueReview?.initialDraft ?? "");
  const [editorState, setEditorState] = useState<string | null>(null);
  const [sent, setSent] = useState<string[]>([]);
  const [stashes, setStashes] = useState<ControllerMessageStash[]>(() => queueReview?.withStash ? [{
    id: "fixture-stash", clientStashId: "fixture-stash", projectId: "fixture-project", conversationId: "fixture-conversation",
    text: "Draft idea to come back to later", editorState: null, composerEnvelope: {},
    createdAt: "2026-10-23T00:00:00Z", updatedAt: "2026-10-23T00:00:00Z",
  }] : []);
  const [restoredStashId, setRestoredStashId] = useState<string | null>(null);
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
    <div className={viewNavigation ? "relative min-h-48" : "relative min-h-28"} data-testid="composer-preview">
      <ChatComposerSurface
        composerOverlayRef={overlay} composerAutoHidden={false} compactBrowserViewport={matchMedia("(max-width: 639px)").matches}
        viewNavigation={viewNavigation} touchLikeInput={Boolean(viewNavigation)}
        browserDockProps={{ renderModal: false, browserSessionOpen: false, onBrowserSessionOpenChange: noop,
          projectId: null, preferredRuntimeId: null, showBrowserSessionPageStrip: false, browserSessionExpandRequestToken: 0,
          onBrowserRuntimeIdResolved: noop, browserSessionPages: [], onSelectBrowserSessionPage: noop,
          onToggleBrowserSession: noop, onClearPendingNewBrowserSession: noop, hasHiddenBrowserSession: false, pendingBrowserLaunchMode: null }}
        onSubmit={event => { event.preventDefault(); send(); }}
        queueSurfaceProps={queue.props}
        stashTrayProps={queueReview?.withStash ? { stashes, restoredStashId, busy: readOnly,
          onRestore: stash => { if (!draft.trim()) { onDraftChange(stash.text, null); setRestoredStashId(stash.id); } },
          onDelete: id => setStashes(current => current.filter(stash => stash.id !== id)),
        } : null}
        activeGoal={null} activeGoalHealth={null} onPauseGoal={noop} onResumeGoal={noop} onClearGoal={noop}
        onHelpUnblockGoal={noop} goalDetailsCollapseToken={0} nativeKeyboardOpen={false} onboardingInputLocked={false}
        onDragOver={noop} onDrop={noop} chatInputRef={input}
        chatInputProps={{ draftKey: "playground-draft", value: draft, editorState, placeholder: "Message Octo…",
          agentHandles: ["octo", "scribe"], onChange: onDraftChange,
          onKeyDown: event => { if (!viewNavigation && event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } } }}
        imageInputRef={image} onImageInputChange={noop} imageAttachments={[]} onOpenImage={noop} onRemoveImageAttachment={noop}
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
    <output hidden data-testid="composer-draft">{draft}</output>
    <output hidden data-testid="sent-messages">{JSON.stringify(sent)}</output>
    <output hidden data-testid="queue-order">{JSON.stringify(queue.items.map(item => item.id))}</output>
    <output hidden data-testid="queue-messages">{JSON.stringify(queue.items.map(item => item.message))}</output>
    {queue.status ? <p role="status" data-testid="queue-status" className="pointer-events-none fixed left-4 right-4 top-20 mx-auto max-w-md rounded-lg bg-slate-900 px-3 py-2 text-sm text-white">{queue.status}</p> : null}
  </>;
}
