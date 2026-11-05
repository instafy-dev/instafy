import { useCallback, useRef, useState, type ReactNode } from "react";
import { ChatComposerSurface } from "../../../src/screens/studio/components/ChatComposerSurface";
import type { ChatRunStopController } from "../../../src/screens/studio/components/useChatRunStop";
import type { ChatInputHandle } from "../../../src/screens/studio/components/chat-input/ChatInput";
import { useQueueReview } from "../run-stop-control/useQueueReview";

const noop = () => {};
// Production derives this list with a memo. Re-registering Lexical's mention
// transforms on every host render would move an existing editor selection.
const agentHandles = ["octo"];
const imageAttachments: Parameters<typeof ChatComposerSurface>[0]["imageAttachments"] = [];
const inviteModalProps: Parameters<typeof ChatComposerSurface>[0]["inviteModalProps"] = {
  isOpen: false, onOpenChange: noop, mentionableUsers: [], inviteParticipantIdSet: new Set(),
  inviteParticipantBusyUserId: null, inviteParticipantsLoading: false, onInviteTeammate: async () => {},
  activeConversationVisibility: null, activeConversationControllerId: null, activeOrgId: null, activeProjectId: null,
  canShareProject: false, canWriteProject: false, sharingPermissionsLoading: false,
};

/** Production composer/editor with local draft state and no send transport. */
export function Composer({ controller, aboveComposer, scrollbarInset }: {
  controller: ChatRunStopController; aboveComposer?: ReactNode; scrollbarInset: number;
}) {
  const overlay = useRef<HTMLDivElement>(null);
  const input = useRef<ChatInputHandle>(null);
  const image = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("Keep the project links in this order.");
  const [editorState, setEditorState] = useState<string | null>(null);
  const [sent, setSent] = useState<string[]>([]);
  const onDraftChange = useCallback((value: string, state: string | null) => { setDraft(value); setEditorState(state); }, []);
  const focusInput = useCallback(() => input.current?.focus(), []);
  const queue = useQueueReview({ count: 0, draft, editorState, onDraftChange, focusInput, setSent, readOnly: false });
  const send = () => { if (draft.trim()) { setSent(current => [...current, draft]); setDraft(""); setEditorState(null); } };
  return <>
    <div data-testid="composer-preview">
      <ChatComposerSurface
        aboveComposer={aboveComposer} composerOverlayRef={overlay} scrollbarInset={scrollbarInset}
        composerAutoHidden={false} compactBrowserViewport={matchMedia("(max-width: 639px)").matches}
        onSubmit={event => { event.preventDefault(); send(); }} queueSurfaceProps={queue.props}
        activeGoal={null} activeGoalHealth={null} onPauseGoal={noop} onResumeGoal={noop} onClearGoal={noop}
        onHelpUnblockGoal={noop} goalDetailsCollapseToken={0} nativeKeyboardOpen={false} onboardingInputLocked={false}
        onDragOver={noop} onDrop={noop} chatInputRef={input}
        chatInputProps={{ draftKey: "search-reading-draft", value: draft, editorState, placeholder: "Message Octo…",
          agentHandles, onChange: onDraftChange,
          onKeyDown: event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } } }}
        imageInputRef={image} onImageInputChange={noop} imageAttachments={imageAttachments} onOpenImage={noop} onRemoveImageAttachment={noop}
        showVoiceStatus={false} voiceStatusMessage="" providerTriggerNoticeProps={null}
        showComposerNavigationButton={false} composerNavigationDestination="chats" onOpenNavigation={noop} homeAttentionCount={0} homeAttentionBadge=""
        composerActionMenuProps={{ pendingNewBrowser: false, onOpenBrowser: noop, onOpenNewBrowser: noop,
          onOpenInvite: noop, onImportGithubRepo: noop, onInsertCommand: value => { setDraft(value); setEditorState(null); },
          showBrowserAction: false, showNewBrowserAction: false, showInviteAction: false }}
        onOpenImagePicker={noop} imageUploadUnavailableReason="Attachments are disabled in this local review."
        sendingAttachment={false} showMobileGhostSuggestionAcceptButton={false} onAcceptGhostSuggestion={noop}
        showVoicePrimaryAction={false} showVoiceSecondaryAction={false}
        voiceConversationActionStripProps={{ showVoiceRepliesToggle: false, voiceActionActive: false,
          voiceListening: false, voiceStarting: false, voiceTranscribing: false, voiceState: "idle",
          voiceRoute: "fixture", voiceCapture: "fixture", onVoicePressStart: noop, onVoicePressEnd: noop,
          onVoiceTap: noop, voiceInteractionMode: "tap" }}
        sendButtonDisabled={false} sendButtonVariant={draft.trim() ? "primary" : "ghost"}
        onSendButtonPress={send} composerGhostActionClass="[&_svg]:text-slate-600 dark:[&_svg]:text-slate-300"
        composerPrimaryActionClass="shadow-none" composerActionIconClass="h-[22px] w-[22px]"
        inviteModalProps={inviteModalProps}
        mutationDisabled={false} composerRunStopController={controller}
      />
    </div>
    <output hidden data-testid="composer-draft">{draft}</output>
    <output hidden data-testid="sent-messages">{JSON.stringify(sent)}</output>
  </>;
}
