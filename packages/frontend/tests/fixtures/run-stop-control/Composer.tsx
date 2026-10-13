import { useRef, useState } from "react";
import { ChatComposerSurface } from "../../../src/screens/studio/components/ChatComposerSurface";
import type { ChatRunStopController } from "../../../src/screens/studio/components/useChatRunStop";
import type { ChatInputHandle } from "../../../src/screens/studio/components/chat-input/ChatInput";

const noop = () => {};

/** The real composer and Lexical editor; only submission and peripheral panes are inert. */
export function Composer({ controller, readOnly, recording }: { controller: ChatRunStopController; readOnly: boolean; recording: boolean }) {
  const overlay = useRef<HTMLDivElement>(null);
  const input = useRef<ChatInputHandle>(null);
  const image = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [editorState, setEditorState] = useState<string | null>(null);
  const [sent, setSent] = useState<string[]>([]);
  const send = () => {
    if (!draft.trim()) return;
    setSent(current => [...current, draft]);
    setDraft("");
    setEditorState(null);
  };
  return <>
    <div className="relative min-h-28" data-testid="composer-preview">
      <ChatComposerSurface
        composerOverlayRef={overlay} composerAutoHidden={false} compactBrowserViewport={matchMedia("(max-width: 639px)").matches}
        browserDockProps={{ renderModal: false, browserSessionOpen: false, onBrowserSessionOpenChange: noop,
          projectId: null, preferredRuntimeId: null, showBrowserSessionPageStrip: false, browserSessionExpandRequestToken: 0,
          onBrowserRuntimeIdResolved: noop, browserSessionPages: [], onSelectBrowserSessionPage: noop,
          onToggleBrowserSession: noop, onClearPendingNewBrowserSession: noop, hasHiddenBrowserSession: false, pendingBrowserLaunchMode: null }}
        onSubmit={event => { event.preventDefault(); send(); }}
        queueSurfaceProps={{ totalQueuedCount: 0, editingQueuedItem: null, chatSendQueueExpanded: false,
          collapsedQueuedMessageSummary: null, queueCanSendNow: false, chatSendQueueDisplay: [], sendingAttachment: false,
          inputValue: draft, onToggleExpanded: noop, onSendQueuedMessageNow: noop, onRemoveQueuedItem: noop,
          onReorderQueuedItem: noop, onEditQueuedMessage: noop, onCancelQueuedEdit: noop,
          onRequeueEditedMessage: noop, onSendEditedMessageNow: noop }}
        activeGoal={null} activeGoalHealth={null} onPauseGoal={noop} onResumeGoal={noop} onClearGoal={noop}
        onHelpUnblockGoal={noop} goalDetailsCollapseToken={0} nativeKeyboardOpen={false} onboardingInputLocked={false}
        onDragOver={noop} onDrop={noop} chatInputRef={input}
        chatInputProps={{ draftKey: "playground-draft", value: draft, editorState, placeholder: "Message Octo…",
          agentHandles: ["octo", "scribe"], onChange: (value, state) => { setDraft(value); setEditorState(state); },
          onKeyDown: event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } } }}
        imageInputRef={image} onImageInputChange={noop} imageAttachments={[]} onOpenImage={noop} onRemoveImageAttachment={noop}
        showVoiceStatus={recording} voiceStatusMessage={recording ? "Recording…" : ""} providerTriggerNoticeProps={null}
        showComposerNavigationButton={false} onOpenNavigation={noop} homeAttentionCount={0} homeAttentionBadge=""
        composerActionMenuProps={{ pendingNewBrowser: false, onOpenBrowser: noop, onOpenNewBrowser: noop,
          onOpenInvite: noop, onImportGithubRepo: noop, onInsertCommand: value => { setDraft(value); setEditorState(null); },
          showBrowserAction: false, showNewBrowserAction: false, showInviteAction: false }}
        onOpenImagePicker={noop} imageUploadUnavailableReason="Attachments are disabled in this playground."
        sendingAttachment={false} showMobileGhostSuggestionAcceptButton={false} onAcceptGhostSuggestion={noop}
        showVoicePrimaryAction={recording} showVoiceSecondaryAction={false}
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
  </>;
}
