import type { JSX } from "react";
import type { ControllerCredentialListItem } from "../../../sdk/instafy";
import { Button } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { AiCredentialsStatusBubble, type AiCredentialsGateState } from "./AiCredentialsStatusBubble";
import { NotificationsNudgeBubble } from "./NotificationsNudgeBubble";
import { ActionRequestEntry } from "./ActionRequestEntry";
import { ChatActionCard } from "./ChatActionCard";
import { ChatBubbleRow } from "./ChatBubbleRow";
import { NotchedMessageShell } from "./ChatMessageEntries";
import { ThreadSpine } from "./ThreadSpine";
import type { AssistantAgentIdentity } from "./chatAssistantIdentity";
import type { WorkspaceFileStaleNotice } from "./workspaceFileStaleNoticeStore";
import { SAVE_COPY } from "./versioningCopy";
import type { UnsavedWorkNotice } from "./useUnsavedWorkNotice";

const CHAT_LEFT_SPINE_OFFSET_CLASS = "left-[-26px]";
const ASSISTANT_AVATAR_GUTTER_PLACEHOLDER = (
  <span aria-hidden="true" className="h-8 w-8 shrink-0 pointer-events-none" />
);

type AssistantAvatarRenderer = (
  metadata?: Record<string, unknown> | null,
  messageAgentIdentity?: AssistantAgentIdentity | null,
) => JSX.Element;

type TimedSyntheticChatRow = {
  key: string;
  timestamp: number;
  element: JSX.Element;
};

function createAssistantActionMessage(id: string, timestamp = Date.now()) {
  return {
    id,
    role: "assistant" as const,
    content: "",
    timestamp,
  };
}

const CHAT_NOTICE_ACTION_CLASS =
  "border-secondary-300/80 text-secondary-900 hover:bg-secondary-50 data-[hovered]:bg-secondary-50 dark:border-secondary-400/40 dark:text-secondary-100 dark:hover:bg-secondary-500/10 dark:data-[hovered]:bg-secondary-500/10";

/** A warning row in the assistant's column with one optional action. */
function ChatNoticeActionBubble({
  testId,
  text,
  textRole,
  action,
}: {
  testId: string;
  text: string;
  /** "status" when the row stands in for the typing status, a live region too. */
  textRole?: "status";
  action: {
    label: string;
    onPress: () => void;
    isPending?: boolean;
    testId?: string;
  } | null;
}) {
  return (
    <ChatBubbleRow align="left" avatar={ASSISTANT_AVATAR_GUTTER_PLACEHOLDER}>
      <NotchedMessageShell
        align="left"
        testId={testId}
        messageType="warning"
        showNotch
        className="pr-2"
      >
        <ThreadSpine
          tone="warning"
          className={`pointer-events-none absolute top-0 h-full ${CHAT_LEFT_SPINE_OFFSET_CLASS}`}
          notches={[{ maskLine: true }]}
        />
        <div className="min-w-0">
          <Text as="div" variant="body" tone="secondary" role={textRole}>
            {text}
          </Text>
          {action ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                onPress={action.onPress}
                isPending={action.isPending}
                variant="outline"
                size="xs"
                radius="full"
                data-testid={action.testId}
                className={CHAT_NOTICE_ACTION_CLASS}
              >
                {action.label}
              </Button>
            </div>
          ) : null}
        </div>
      </NotchedMessageShell>
    </ChatBubbleRow>
  );
}

function OutOfCreditsChatBubble({
  creditLimit,
  onOpenCredits,
}: {
  creditLimit: number;
  onOpenCredits: () => void;
}) {
  return (
    <ChatNoticeActionBubble
      testId="chat-out-of-credits-cta"
      text={creditLimit > 0 ? `0/${creditLimit} credits left.` : "No credits left."}
      action={{ label: "Refill credits", onPress: onOpenCredits }}
    />
  );
}

function workspaceStartStalledDescription({
  agentDisplayName,
  canRetry,
}: {
  agentDisplayName: string | null;
  canRetry: boolean;
}): string {
  const workspace = agentDisplayName ? `${agentDisplayName}'s workspace` : "The workspace";
  // A member who cannot retry cannot send either, so the waiting message is
  // not theirs.
  const waiting = canRetry
    ? "Your message is kept and will send once it's running."
    : "Queued messages will send once it's running.";
  return `${workspace} is taking longer than usual to start. ${waiting}`;
}

/**
 * Stands in for the "starting its workspace…" status once a hosted launch has
 * gone five minutes without coming up. Try again asks the controller to
 * replace the launch; a new one's fresh start time clears this row.
 */
export function WorkspaceStartStalledRow({
  agentDisplayName,
  onRetry,
  retryPending,
}: {
  /** The waiting agent's name; null when several share the workspace. */
  agentDisplayName: string | null;
  /** Null for a member who cannot control the space's runtime. */
  onRetry: (() => void) | null;
  retryPending: boolean;
}) {
  return (
    <ChatNoticeActionBubble
      testId="chat-workspace-start-stalled"
      text={workspaceStartStalledDescription({ agentDisplayName, canRetry: onRetry !== null })}
      textRole="status"
      action={
        onRetry
          ? {
              label: "Try again",
              onPress: onRetry,
              isPending: retryPending,
              testId: "chat-workspace-start-retry",
            }
          : null
      }
    />
  );
}

export function unsavedWorkNoticeDescription(count: number): string {
  return count > 1
    ? `${count} entries are kept in History, under Unsaved work, until someone restores or removes them.`
    : "It's kept in History, under Unsaved work, until someone restores or removes it.";
}

/** Per viewer, never written into the conversation (see useUnsavedWorkNotice). */
export function UnsavedWorkSystemRow({
  notice,
  renderAssistantAvatar,
}: {
  notice: UnsavedWorkNotice;
  renderAssistantAvatar: AssistantAvatarRenderer;
}) {
  return (
    <ChatBubbleRow align="left" avatar={renderAssistantAvatar(null)}>
      <ChatActionCard
        testId="unsaved-work-system-row"
        overline="Space"
        title="Some work wasn't saved"
        description={unsavedWorkNoticeDescription(notice.count)}
        actions={[
          {
            id: "open-history",
            label: "Open History",
            variant: "primary",
            onPress: notice.onOpenHistory,
            testId: "unsaved-work-system-row-open",
          },
          {
            id: "dismiss",
            label: "Dismiss",
            variant: "ghost",
            onPress: notice.onDismiss,
            testId: "unsaved-work-system-row-dismiss",
          },
        ]}
      />
    </ChatBubbleRow>
  );
}

export function buildTimedSyntheticChatRows({
  notificationsNudgeOpen,
  credentialGateState,
  aiOnboardingOpen,
  notificationsNudgeAnchorTimestamp,
  notificationsNudgeKind,
  onEnableNotifications,
  onDismissNotificationsNudge,
  outOfCredits,
  outOfCreditsAnchorTimestamp,
  creditLimit,
  onOpenCredits,
  renderAssistantAvatar,
}: {
  notificationsNudgeOpen: boolean;
  credentialGateState: AiCredentialsGateState | null;
  aiOnboardingOpen: boolean;
  notificationsNudgeAnchorTimestamp: number | null;
  notificationsNudgeKind: "browser" | "native";
  onEnableNotifications: () => Promise<boolean>;
  onDismissNotificationsNudge: () => void;
  outOfCredits: boolean;
  outOfCreditsAnchorTimestamp: number | null;
  creditLimit: number;
  onOpenCredits: () => void;
  renderAssistantAvatar: AssistantAvatarRenderer;
}): TimedSyntheticChatRow[] {
  const rows: TimedSyntheticChatRow[] = [];

  if (
    notificationsNudgeOpen &&
    !credentialGateState &&
    !aiOnboardingOpen &&
    notificationsNudgeAnchorTimestamp !== null
  ) {
    rows.push({
      key: "notifications-nudge",
      timestamp: notificationsNudgeAnchorTimestamp,
      element: (
        <ChatBubbleRow key="notifications-nudge" align="left" avatar={renderAssistantAvatar(null)}>
          <NotificationsNudgeBubble
            title={notificationsNudgeKind === "native" ? "Enable push notifications?" : "Enable notifications?"}
            detail="Get alerted when new assistant messages arrive."
            onEnable={onEnableNotifications}
            onDismiss={onDismissNotificationsNudge}
          />
        </ChatBubbleRow>
      ),
    });
  }

  if (outOfCredits && outOfCreditsAnchorTimestamp !== null) {
    rows.push({
      key: "chat-out-of-credits-message",
      timestamp: outOfCreditsAnchorTimestamp,
      element: (
        <OutOfCreditsChatBubble
          key="chat-out-of-credits-message"
          creditLimit={creditLimit}
          onOpenCredits={onOpenCredits}
        />
      ),
    });
  }

  return rows;
}

export function ChatPostTranscriptAuxiliaryRows({
  jobThreadPresent,
  workspaceFileStaleNotice,
  workspaceFileStaleBusy,
  workspaceFileStaleError,
  onWorkspaceFileStaleMerge,
  onWorkspaceFileStaleReload,
  onWorkspaceFileStaleDismiss,
  unsavedWorkNotice = null,
  workspaceGitSyncConflictDetails,
  workspaceGitSyncConflictDetectedAt,
  credentialGateStateForBubble,
  aiOnboardingOpen,
  credentialGateDetail,
  credentialsBusy,
  canUseDesktopConnect,
  aiConnectWizardStorageKey,
  activeAiCredentials,
  defaultCredentialId,
  managedAi,
  onSetDefaultCredential,
  onUseManagedAi,
  onChatWithoutAi,
  onConnectAi,
  hasTeammates,
  onCloseAiOnboarding,
  onStashDraftForCredentials,
  onConnectDesktop,
  onUploadAuthJson,
  onSaveApiKey,
  onRetryCredentials,
  renderAssistantAvatar,
}: {
  jobThreadPresent: boolean;
  workspaceFileStaleNotice: WorkspaceFileStaleNotice | null;
  workspaceFileStaleBusy: null | "merge" | "reload";
  workspaceFileStaleError: string | null;
  onWorkspaceFileStaleMerge: () => void;
  onWorkspaceFileStaleReload: () => void;
  onWorkspaceFileStaleDismiss: () => void;
  /** New unsaved work in a stateless or Desktop space, once per viewer. */
  unsavedWorkNotice?: UnsavedWorkNotice | null;
  workspaceGitSyncConflictDetails: Record<string, unknown> | null;
  workspaceGitSyncConflictDetectedAt: number | null;
  credentialGateStateForBubble: AiCredentialsGateState | null;
  aiOnboardingOpen: boolean;
  credentialGateDetail: string | null;
  credentialsBusy: boolean;
  canUseDesktopConnect: boolean;
  aiConnectWizardStorageKey: string | null;
  activeAiCredentials: ControllerCredentialListItem[];
  defaultCredentialId: string | null;
  managedAi: {
    enabled: boolean;
    available: boolean;
    label: string;
    creditBurnAmount: number;
    dailyPromptLimit: number;
    dailyPromptsUsed: number;
    remainingPrompts: number | null;
  } | null;
  onSetDefaultCredential: (credentialId: string) => void;
  onUseManagedAi: () => void;
  onChatWithoutAi: () => void;
  // The gate's one button: opens the Add AI connection modal.
  onConnectAi: () => void;
  // Gates the gate's "turn the assistant off" caption on a real second member.
  hasTeammates: boolean;
  onCloseAiOnboarding: () => void;
  onStashDraftForCredentials: () => void;
  onConnectDesktop: () => void;
  onUploadAuthJson: (file: File) => void;
  onSaveApiKey: (
    apiKey: string,
    provider: "openai" | "deepseek" | "zai" | "gemini",
  ) => Promise<{ success: boolean; error?: string }>;
  onRetryCredentials: () => void;
  renderAssistantAvatar: AssistantAvatarRenderer;
}) {
  const credentialBubbleState =
    credentialGateStateForBubble ??
    (aiOnboardingOpen && activeAiCredentials.length > 0 && !defaultCredentialId
      ? "needs_default"
      : "missing");

  return (
    <>
      {!jobThreadPresent && workspaceFileStaleNotice ? (
        <ChatBubbleRow
          key="workspace-file-stale"
          align="left"
          avatar={renderAssistantAvatar(null)}
        >
          <ChatActionCard
            testId="workspace-file-stale-card"
            overline="Space"
            title={`"${workspaceFileStaleNotice.label}" changed`}
            description={
              workspaceFileStaleNotice.variant === "desktop"
                ? SAVE_COPY.desktopStaleDescription
                : "A newer version was saved while you were editing. Reload discards your unsaved edits; Merge keeps both."
            }
            actions={[
              {
                id: "merge",
                label: "Merge for me",
                variant: "primary",
                onPress: () => void onWorkspaceFileStaleMerge(),
                isLoading: workspaceFileStaleBusy === "merge",
                isDisabled: workspaceFileStaleBusy === "reload",
                loadingLabel: "Starting merge…",
                testId: "workspace-file-stale-merge",
              },
              {
                id: "reload",
                label: "Reload latest",
                variant: "outline",
                onPress: onWorkspaceFileStaleReload,
                isLoading: workspaceFileStaleBusy === "reload",
                isDisabled: workspaceFileStaleBusy === "merge",
                testId: "workspace-file-stale-reload",
              },
              {
                id: "dismiss",
                label: "Dismiss",
                variant: "ghost",
                onPress: onWorkspaceFileStaleDismiss,
                isDisabled: workspaceFileStaleBusy !== null,
                testId: "workspace-file-stale-dismiss",
              },
            ]}
          >
            {workspaceFileStaleError ? (
              <Text variant="caption" tone="muted">
                {workspaceFileStaleError}
              </Text>
            ) : null}
          </ChatActionCard>
        </ChatBubbleRow>
      ) : null}
      {!jobThreadPresent && unsavedWorkNotice ? (
        <UnsavedWorkSystemRow notice={unsavedWorkNotice} renderAssistantAvatar={renderAssistantAvatar} />
      ) : null}
      {workspaceGitSyncConflictDetails ? (
        <ChatBubbleRow
          key="workspace-git-sync-conflict"
          align="left"
          avatar={renderAssistantAvatar(null)}
        >
          <ActionRequestEntry
            message={createAssistantActionMessage(
              "workspace-git-sync-conflict",
              workspaceGitSyncConflictDetectedAt ?? Date.now(),
            )}
            details={workspaceGitSyncConflictDetails}
          />
        </ChatBubbleRow>
      ) : null}
      {credentialGateStateForBubble || aiOnboardingOpen ? (
        <ChatBubbleRow align="left" avatar={renderAssistantAvatar(null)}>
          <AiCredentialsStatusBubble
            state={credentialBubbleState}
            intent={aiOnboardingOpen ? "connect" : "gate"}
            detail={credentialGateDetail}
            isBusy={credentialsBusy}
            canUseDesktopConnect={canUseDesktopConnect}
            storageKey={aiConnectWizardStorageKey}
            connectedCredentials={activeAiCredentials}
            defaultCredentialId={defaultCredentialId}
            managedAi={managedAi}
            onSetDefaultCredential={onSetDefaultCredential}
            onUseManagedAi={onUseManagedAi}
            onChatWithoutAi={onChatWithoutAi}
            onConnectAi={onConnectAi}
            hasTeammates={hasTeammates}
            onClose={onCloseAiOnboarding}
            onStashDraft={onStashDraftForCredentials}
            onConnectDesktop={onConnectDesktop}
            onUploadAuthJson={onUploadAuthJson}
            onSaveApiKey={onSaveApiKey}
            onRetry={() => void onRetryCredentials()}
          />
        </ChatBubbleRow>
      ) : null}
    </>
  );
}
