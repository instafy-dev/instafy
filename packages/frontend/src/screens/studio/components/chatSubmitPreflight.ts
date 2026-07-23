import { Capacitor } from "@capacitor/core";
import { isLikelyInviteEmail, parseInviteCommandRequest } from "../../../conversations/inviteCommand";
import { buildGithubImportFollowupMessageFromPayload } from "../../../conversations/githubImportFollowup";
import {
  deriveGithubImportTargetPath,
  parseGithubRepoOwnerName,
} from "../../../services/runtimeController/githubImportPath";
import type { StatusIntent } from "../../../status/useStatus";
import type { PreparedEmailInvite } from "../../../sharing/preparedEmailInvite";
import type { ChatMessage } from "../types";
import type { ChatSubmitOverride } from "./chatSubmitPlanning";
import { extractExplicitGithubRepoReference } from "./chatGithubImportIntent";
import { createLocalChatMessage } from "./chatLocalMessages";
import { executeGithubProjectImport } from "./githubImport";
import { buildGithubImportRetryIdentity } from "./githubImportRetryRegistry";

type ShowStatus = (message: string, intent?: StatusIntent, durationMs?: number) => void;

type InvitationResult = {
  acceptUrl: string;
  email: string;
  role: string;
  expiresAt?: string | null;
};

export type ChatSubmitPreflightResult =
  | {
      status: "continue";
      editorState: string | null;
    }
  | {
      status: "handled";
      submitted: boolean;
    };

type RunChatSubmitPreflightParams = {
  activeConversationControllerId: string | null;
  activeConversationId: string | null;
  activeConversationVisibility: string | null;
  activeOrgId: string | null;
  activeProjectId: string | null;
  allowWhileBusy: boolean;
  appendMessages: (conversationId: string, messages: ChatMessage[]) => void;
  attachedImageCount: number;
  clearQueuedComposerDraft: () => void;
  clearSubmittedComposerDraft: () => void;
  consumeBrowserComposerTarget: () => void;
  createConversationId: () => string;
  createOrgInvitation: (input: {
    orgId: string;
    projectId?: string;
    conversationId?: string;
    email: string;
    role: string;
  }) => Promise<InvitationResult>;
  credentialsReady: boolean;
  currentUserId: string | null;
  focusInput: (options?: { force?: boolean }) => void;
  handleOutOfCredits: () => boolean;
  inputEditorState: string | null;
  isAssistantTyping: boolean;
  messageRequiresAi: boolean;
  messageRequiresRuntime: boolean;
  messageToSend: string;
  onMaybeAutoTitleConversation: (conversationId: string, prompt: string) => void | Promise<void>;
  onPreparedEmailInvite: (invite: PreparedEmailInvite) => void;
  onRecordMessage: (
    conversationId: string,
    message: string,
    metadata?: Record<string, unknown> | null,
    role?: "assistant" | "user",
  ) => Promise<ChatMessage | null>;
  override?: ChatSubmitOverride;
  pinToBottom: () => void;
  queueCurrentMessage: (editorState: string | null) => void;
  queueMessageToServer: (() => Promise<boolean>) | null;
  recoverRuntime: () => void;
  resolveRuntimeAvailable: () => Promise<boolean>;
  runtimeControllerEnabled: boolean;
  sendingAttachment: boolean;
  showCredentialsGate: () => void;
  showStatus: ShowStatus;
  targetAgentHandles: string[];
  targetsOverlapActiveRuns: (targetAgentHandles: string[]) => boolean;
  trimmed: string;
};

async function tryHandleInviteCommand({
  activeConversationControllerId,
  activeConversationId,
  activeConversationVisibility,
  activeOrgId,
  activeProjectId,
  appendMessages,
  attachedImageCount,
  clearSubmittedComposerDraft,
  createConversationId,
  createOrgInvitation,
  currentUserId,
  focusInput,
  messageToSend,
  onMaybeAutoTitleConversation,
  onPreparedEmailInvite,
  onRecordMessage,
  pinToBottom,
  showStatus,
}: Omit<
  RunChatSubmitPreflightParams,
  | "allowWhileBusy"
  | "credentialsReady"
  | "handleOutOfCredits"
  | "inputEditorState"
  | "isAssistantTyping"
  | "messageRequiresAi"
  | "messageRequiresRuntime"
  | "override"
  | "queueCurrentMessage"
  | "queueMessageToServer"
  | "recoverRuntime"
  | "resolveRuntimeAvailable"
  | "runtimeControllerEnabled"
  | "sendingAttachment"
  | "showCredentialsGate"
  | "targetAgentHandles"
  | "targetsOverlapActiveRuns"
  | "trimmed"
  | "clearQueuedComposerDraft"
> & {
  attachedImageCount: number;
}): Promise<ChatSubmitPreflightResult | null> {
  const inviteRequest = parseInviteCommandRequest(messageToSend);
  if (!inviteRequest) {
    return null;
  }

  if (attachedImageCount > 0) {
    showStatus("/invite does not support image attachments.", "error", 4000);
    focusInput();
    return { status: "handled", submitted: false };
  }
  if (inviteRequest.error) {
    showStatus(inviteRequest.error, "error", 4500);
    focusInput();
    return { status: "handled", submitted: false };
  }
  if (!inviteRequest.email) {
    showStatus("Add an email after /invite.", "error", 4000);
    focusInput();
    return { status: "handled", submitted: false };
  }
  if (!isLikelyInviteEmail(inviteRequest.email)) {
    showStatus("Enter a valid email after /invite.", "error", 4500);
    focusInput();
    return { status: "handled", submitted: false };
  }
  if (!activeOrgId) {
    showStatus("This space is not linked to a team yet, so email invites are unavailable.", "error", 5000);
    focusInput();
    return { status: "handled", submitted: false };
  }
  if (activeConversationVisibility === "private" && !activeConversationControllerId) {
    showStatus("Wait for this private chat to finish syncing before inviting someone.", "warning", 4500);
    focusInput();
    return { status: "handled", submitted: false };
  }

  const conversationIdForInvite = activeConversationId ?? createConversationId();
  clearSubmittedComposerDraft();

  const timestamp = Date.now();
  const userInviteMessage = createLocalChatMessage("user", messageToSend, {
    authorId: currentUserId,
    timestamp,
  });

  try {
    const invitation = await createOrgInvitation({
      orgId: activeOrgId,
      projectId: activeProjectId ?? undefined,
      conversationId:
        activeConversationVisibility === "private"
          ? activeConversationControllerId ?? undefined
          : undefined,
      email: inviteRequest.email,
      role: inviteRequest.role,
    });
    onPreparedEmailInvite({
      acceptUrl: invitation.acceptUrl,
      email: invitation.email,
      role: invitation.role,
    });
    const assistantInviteMessageContent = `Prepared an invite for ${invitation.email} with ${invitation.role} access${
      invitation.expiresAt ? `, valid until ${new Date(invitation.expiresAt).toLocaleString()}` : ""
    }. Instafy has not sent an email. The secure link is ready in the Invite panel for you to share now.`;
    const recordedUserInviteMessage =
      await onRecordMessage(conversationIdForInvite, messageToSend, null);
    const recordedAssistantInviteMessage =
      await onRecordMessage(conversationIdForInvite, assistantInviteMessageContent, null);
    appendMessages(conversationIdForInvite, [
      recordedUserInviteMessage ?? userInviteMessage,
      recordedAssistantInviteMessage ?? createLocalChatMessage("assistant", assistantInviteMessageContent),
    ]);
    void onMaybeAutoTitleConversation(conversationIdForInvite, messageToSend);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create email invite.";
    const assistantInviteErrorMessageContent = `I couldn't create an invite for ${inviteRequest.email}. ${message}`;
    const recordedUserInviteMessage =
      await onRecordMessage(conversationIdForInvite, messageToSend, null);
    const recordedAssistantInviteErrorMessage =
      await onRecordMessage(conversationIdForInvite, assistantInviteErrorMessageContent, null);
    appendMessages(conversationIdForInvite, [
      recordedUserInviteMessage ?? userInviteMessage,
      recordedAssistantInviteErrorMessage ??
        createLocalChatMessage("assistant", assistantInviteErrorMessageContent),
    ]);
    void onMaybeAutoTitleConversation(conversationIdForInvite, messageToSend);
  } finally {
    pinToBottom();
    if (!Capacitor.isNativePlatform()) {
      focusInput({ force: true });
    }
  }

  return { status: "handled", submitted: true };
}

async function tryHandleGithubRepoImport({
  activeConversationId,
  activeProjectId,
  appendMessages,
  attachedImageCount,
  clearSubmittedComposerDraft,
  createConversationId,
  currentUserId,
  focusInput,
  messageToSend,
  onMaybeAutoTitleConversation,
  onRecordMessage,
  pinToBottom,
  showStatus,
}: Omit<
  RunChatSubmitPreflightParams,
  | "activeOrgId"
  | "allowWhileBusy"
  | "credentialsReady"
  | "createOrgInvitation"
  | "handleOutOfCredits"
  | "inputEditorState"
  | "isAssistantTyping"
  | "messageRequiresAi"
  | "messageRequiresRuntime"
  | "override"
  | "queueCurrentMessage"
  | "queueMessageToServer"
  | "recoverRuntime"
  | "resolveRuntimeAvailable"
  | "runtimeControllerEnabled"
  | "sendingAttachment"
  | "showCredentialsGate"
  | "targetAgentHandles"
  | "targetsOverlapActiveRuns"
  | "trimmed"
  | "clearQueuedComposerDraft"
  | "consumeBrowserComposerTarget"
> & {
  attachedImageCount: number;
}): Promise<ChatSubmitPreflightResult | null> {
  const repoReference = extractExplicitGithubRepoReference(messageToSend);
  if (!repoReference) {
    return null;
  }

  if (attachedImageCount > 0) {
    showStatus("GitHub repo imports do not support image attachments.", "error", 4000);
    focusInput();
    return { status: "handled", submitted: false };
  }
  if (!activeProjectId) {
    showStatus("Pick a space before importing a GitHub repo.", "error", 4500);
    focusInput();
    return { status: "handled", submitted: false };
  }

  const parsedRepo = parseGithubRepoOwnerName(repoReference);
  if (!parsedRepo) {
    return null;
  }
  const repoLabel = `${parsedRepo.owner}/${parsedRepo.repo}`;
  const targetPath = deriveGithubImportTargetPath(repoReference);
  const conversationIdForImport = activeConversationId ?? createConversationId();
  clearSubmittedComposerDraft();

  const timestamp = Date.now();
  const userImportMessage = createLocalChatMessage("user", messageToSend, {
    authorId: currentUserId,
    timestamp,
  });
  const githubImportIdentity = buildGithubImportRetryIdentity({
    projectId: activeProjectId,
    sourceMessageId: userImportMessage.id,
    repo: repoReference,
    ref: null,
    targetPath,
  });
  const recordedUserImportMessage = await onRecordMessage(
    conversationIdForImport,
    messageToSend,
    null,
  ).catch(() => null);

  try {
    const importResult = await executeGithubProjectImport({
      projectId: activeProjectId,
      repo: repoReference,
      targetPath,
      idempotencyKey: githubImportIdentity.idempotencyKey,
      queueFollowup: false,
    });
    if (!importResult.success) {
      const accessFailure =
        importResult.errorCode === "github_auth_required" ||
        importResult.errorCode === "github_auth_failed" ||
        importResult.errorCode === "github_access_denied" ||
        importResult.errorCode === "github_access_or_not_found" ||
        // Backward compatibility while older controllers are rolling out.
        (!importResult.errorCode &&
          /connect github|authentication failed|do not have access/i.test(
            importResult.error ?? "",
          ));
      if (!accessFailure) {
        const assistantContent = `GitHub import failed for ${repoLabel}: ${
          importResult.error ?? "Please try again."
        }`;
        const recordedAssistantErrorMessage = await onRecordMessage(
          conversationIdForImport,
          assistantContent,
          {
            messageType: "integration_error",
            details: {
              provider: "github",
              code: importResult.errorCode ?? null,
              retryable: importResult.status === null || importResult.status === undefined
                ? true
                : importResult.status >= 408,
            },
          },
          "assistant",
        ).catch(() => null);
        appendMessages(conversationIdForImport, [
          recordedUserImportMessage ?? userImportMessage,
          recordedAssistantErrorMessage ??
            createLocalChatMessage("assistant", assistantContent, {
              metadata: {
                messageType: "integration_error",
                details: { provider: "github", code: importResult.errorCode ?? null },
              },
            }),
        ]);
        void onMaybeAutoTitleConversation(conversationIdForImport, messageToSend);
        pinToBottom();
        return { status: "handled", submitted: true };
      }
      const assistantContent = `GitHub access is needed to import ${repoLabel}.`;
      const metadata = {
        messageType: "integration_request",
        details: {
          provider: "github",
          authMethods: ["oauth"],
          capabilities: ["repository import"],
          requiredScopes: ["repo"],
          description:
            importResult.error ??
            `Connect GitHub to continue importing ${repoLabel}.`,
          resumeAction: {
            kind: "github_import",
            repo: repoReference,
            ref: null,
            targetPath,
            promptMessage: messageToSend,
            idempotencyKey: githubImportIdentity.idempotencyKey,
          },
        },
      };
      const recordedAssistantRequestMessage = await onRecordMessage(
        conversationIdForImport,
        assistantContent,
        metadata,
        "assistant",
      ).catch(() => null);
      appendMessages(conversationIdForImport, [
        recordedUserImportMessage ?? userImportMessage,
        recordedAssistantRequestMessage ??
          createLocalChatMessage("assistant", assistantContent, {
            metadata,
          }),
      ]);
      void onMaybeAutoTitleConversation(conversationIdForImport, messageToSend);
      pinToBottom();
      return { status: "handled", submitted: true };
    }

    const assistantImportMessage = buildGithubImportFollowupMessageFromPayload({
      projectId: activeProjectId,
      repo: repoLabel,
      targetPath: importResult.targetPath ?? targetPath,
      fileCount: importResult.fileCount ?? null,
    });
    const recordedAssistantImportMessage = await onRecordMessage(
      conversationIdForImport,
      assistantImportMessage.content,
      (assistantImportMessage.metadata as Record<string, unknown> | null) ?? null,
      "assistant",
    ).catch(() => null);
    appendMessages(conversationIdForImport, [
      recordedUserImportMessage ?? userImportMessage,
      recordedAssistantImportMessage ?? assistantImportMessage,
    ]);
    showStatus("GitHub repo imported.", "success", 3500);
    void onMaybeAutoTitleConversation(conversationIdForImport, messageToSend);
    pinToBottom();
    return { status: "handled", submitted: true };
  } finally {
    if (!Capacitor.isNativePlatform()) {
      focusInput({ force: true });
    }
  }
}

export async function runChatSubmitPreflight(
  params: RunChatSubmitPreflightParams,
): Promise<ChatSubmitPreflightResult> {
  const editorState = params.override ? params.override.editorState : params.trimmed ? params.inputEditorState ?? null : null;

  const inviteResult = await tryHandleInviteCommand(params);
  if (inviteResult) {
    return inviteResult;
  }

  const githubImportResult = await tryHandleGithubRepoImport(params);
  if (githubImportResult) {
    return githubImportResult;
  }

  // Participation arbitration has already neutralized record-only human turns.
  // Gate a responding AI turn before checking or provisioning a runtime so a
  // credential-less teammate cannot accidentally start runtime work or get
  // redirected to credits before they can connect an existing subscription.
  if (params.messageRequiresAi && !params.credentialsReady) {
    params.showCredentialsGate();
    return { status: "handled", submitted: false };
  }

  if (params.messageRequiresAi && params.handleOutOfCredits()) {
    return { status: "handled", submitted: false };
  }

  if (params.messageRequiresRuntime) {
    const runtimeAvailable = await params.resolveRuntimeAvailable();
    if (!runtimeAvailable) {
      if (params.runtimeControllerEnabled && params.attachedImageCount === 0) {
        params.recoverRuntime();
        return { status: "continue", editorState };
      }
      if (!params.override && params.attachedImageCount > 0) {
        if (params.runtimeControllerEnabled) {
          params.recoverRuntime();
        }
        params.showStatus("Starting runtime… Send images once it is ready.", "info", 4000);
        params.focusInput();
        return { status: "handled", submitted: false };
      }
      if (!params.override) {
        params.queueCurrentMessage(editorState);
        params.consumeBrowserComposerTarget();
        params.clearQueuedComposerDraft();
      }
      if (params.runtimeControllerEnabled) {
        params.recoverRuntime();
      } else {
        params.showStatus("Runtime control is unavailable right now.", "warning", 4000);
      }
      return { status: "handled", submitted: false };
    }
  }

  if (!params.allowWhileBusy && params.isAssistantTyping && params.attachedImageCount > 0) {
    params.showStatus("Wait for the current reply before sending images.", "info", 4000);
    return { status: "handled", submitted: false };
  }

  if (!params.allowWhileBusy && (params.isAssistantTyping || params.sendingAttachment)) {
    if (params.attachedImageCount > 0) {
      params.showStatus("Wait for the current reply before sending images.", "info", 4000);
      return { status: "handled", submitted: false };
    }
    if (
      params.sendingAttachment ||
      params.targetsOverlapActiveRuns(params.targetAgentHandles)
    ) {
      // Prefer the controller's durable send queue: it survives reloads and the
      // controller auto-dispatches entries once the target agents go idle. The
      // localStorage queue stays as fallback when the controller client is
      // unavailable. Attachment sends stay local so ordering with the in-flight
      // upload is preserved.
      const queuedToServer =
        !params.sendingAttachment && params.queueMessageToServer
          ? await params.queueMessageToServer()
          : false;
      if (!queuedToServer) {
        params.queueCurrentMessage(editorState);
      }
      params.consumeBrowserComposerTarget();
      params.clearQueuedComposerDraft();
      params.focusInput();
      return { status: "handled", submitted: false };
    }
  }

  if (params.sendingAttachment) {
    return { status: "handled", submitted: false };
  }

  return {
    status: "continue",
    editorState,
  };
}
