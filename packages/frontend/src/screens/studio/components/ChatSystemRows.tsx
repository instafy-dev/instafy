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

function OutOfCreditsChatBubble({
  creditLimit,
  onOpenCredits,
}: {
  creditLimit: number;
  onOpenCredits: () => void;
}) {
  return (
    <ChatBubbleRow
      key="chat-out-of-credits-message"
      align="left"
      avatar={ASSISTANT_AVATAR_GUTTER_PLACEHOLDER}
    >
      <NotchedMessageShell
        align="left"
        testId="chat-out-of-credits-cta"
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
          <Text as="div" variant="body" tone="secondary">
            {creditLimit > 0 ? `0/${creditLimit} credits left.` : "No credits left."}
          </Text>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              onPress={onOpenCredits}
              variant="outline"
              size="xs"
              radius="full"
              className="border-amber-300/80 text-amber-900 hover:bg-amber-50 data-[hovered]:bg-amber-50 dark:border-amber-400/40 dark:text-amber-100 dark:hover:bg-amber-500/10 dark:data-[hovered]:bg-amber-500/10"
            >
              Refill credits
            </Button>
          </div>
        </div>
      </NotchedMessageShell>
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
  workspaceFileStaleBusy: null | "merge";
  workspaceFileStaleError: string | null;
  onWorkspaceFileStaleMerge: () => void;
  onWorkspaceFileStaleReload: () => void;
  onWorkspaceFileStaleDismiss: () => void;
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
            description="A newer version was saved while you were editing. Reload discards your unsaved edits; Merge keeps both."
            actions={[
              {
                id: "merge",
                label: "Merge for me",
                variant: "primary",
                onPress: () => void onWorkspaceFileStaleMerge(),
                isLoading: workspaceFileStaleBusy === "merge",
                loadingLabel: "Starting merge…",
                testId: "workspace-file-stale-merge",
              },
              {
                id: "reload",
                label: "Reload latest",
                variant: "outline",
                onPress: onWorkspaceFileStaleReload,
                isDisabled: workspaceFileStaleBusy !== null,
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
