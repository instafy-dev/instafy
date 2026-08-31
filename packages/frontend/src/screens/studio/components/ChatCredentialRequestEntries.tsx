import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { GitBranch, Key } from "iconoir-react";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { GitHubIcon } from "../../../components/IntegrationIcons";
import { Spinner } from "../../../components/Spinner";
import { Surface } from "../../../components/Surface";
import { Text } from "../../../components/Text";
import {
  buildGithubImportFollowupMessageFromPayload,
} from "../../../conversations/githubImportFollowup";
import { useConversation } from "../../../conversations/useConversation";
import { useConversations } from "../../../conversations/ConversationsProvider";
import type { ChatMessage } from "../types";
import { useStatus } from "../../../status/useStatus";
import { controllerClient } from "../../../sdk/instafy";
import { useWorkspaceTabs } from "../../../workspace/WorkspaceTabsProvider";
import { openExternalUrl } from "../../../utils/openExternalUrl";
import {
  AccessDecisionCard,
  AccessDecisionContent,
  AccessPill,
  AccessSectionLabel,
} from "./AccessDecisionCard";
import { CHAT_BUBBLE_MAX_WIDTH } from "./chatBubbleWidth";
import { useDeviceAuthFlow } from "./device-auth/useDeviceAuthFlow";
import {
  executeGithubProjectImport,
  formatGithubImportSuccessMessage,
  parseGithubImportResumeAction,
  type GithubImportResumeAction,
} from "./githubImport";
import {
  buildGithubImportRetryIdentity,
  getGithubImportRetrySnapshot,
  runGithubImportRetry,
  subscribeGithubImportRetry,
} from "./githubImportRetryRegistry";
import { InlineSecretsForm } from "./InlineSecretsForm";
import {
  parseIntegrationRequestDetails,
  parseSecretRequestDetails,
  resolveUiSuggestedReplies,
} from "./chatMessageDetailHelpers";
import { setPendingProjectSecretPrefill } from "./secretManagerDeepLink";

const { listForProject: listProjectIntegrations, upsert: upsertProjectIntegration } = controllerClient.integrations;
const ATTACHED_INTEGRATION_STATUSES = new Set(["attached", "available", "connected", "enabled"]);
const GITHUB_TOKEN_SECRET_NAMES = new Set(["GITHUB_TOKEN", "GH_TOKEN"]);

function integrationMetadataAllowsAttached(metadata: Record<string, unknown>) {
  return metadata.attached !== false && metadata.enabled !== false;
}

type IntegrationRetryOperation = "github_import" | "suggested_request";

type IntegrationRetryState =
  | { phase: "idle" }
  | { phase: "running"; operation: IntegrationRetryOperation }
  | { phase: "failed"; operation: IntegrationRetryOperation; error: string }
  | { phase: "succeeded"; operation: "suggested_request" }
  | {
      phase: "succeeded";
      operation: "github_import";
      repo: string;
      ref: string | null;
      targetPath: string | null;
      fileCount: number | null;
    };

type IntegrationRetryResult =
  | { success: true }
  | { success: false; error: string };

type GithubImportReceipt = {
  projectId: string | null;
  repo: string;
  ref: string | null;
  targetPath: string | null;
  fileCount: number | null;
  sourceMessageId: string | null;
};

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readTrimmedString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function normalizeGithubRepoIdentity(value: string): string {
  const withoutSuffix = value
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  const githubMatch = withoutSuffix.match(/github\.com[/:]([^/]+)\/([^/]+)$/i);
  return (githubMatch ? `${githubMatch[1]}/${githubMatch[2]}` : withoutSuffix).toLowerCase();
}

function parseGithubImportReceipt(message: ChatMessage): GithubImportReceipt | null {
  const metadata = readRecord(message.metadata);
  const receipt = readRecord(metadata?.["githubImport"] ?? metadata?.["github_import"]);
  if (!receipt) {
    return null;
  }
  const repo = readTrimmedString(receipt, ["repo"]);
  if (!repo) {
    return null;
  }
  const rawFileCount = receipt["fileCount"] ?? receipt["file_count"];
  return {
    projectId: readTrimmedString(receipt, ["projectId", "project_id"]),
    repo,
    ref: readTrimmedString(receipt, ["ref"]),
    targetPath: readTrimmedString(receipt, ["targetPath", "target_path"]),
    fileCount:
      typeof rawFileCount === "number" && Number.isFinite(rawFileCount)
        ? rawFileCount
        : null,
    sourceMessageId: readTrimmedString(receipt, ["sourceMessageId", "source_message_id"]),
  };
}

function isMessageAfterRequest(
  messages: ChatMessage[],
  request: ChatMessage,
  candidate: ChatMessage,
  candidateIndex: number,
): boolean {
  const requestIndex = messages.findIndex((entry) => entry.id === request.id);
  if (requestIndex >= 0) {
    return candidateIndex > requestIndex;
  }
  return candidate.id !== request.id && candidate.timestamp >= request.timestamp;
}

function findGithubImportReceipt(params: {
  messages: ChatMessage[];
  request: ChatMessage;
  projectId: string | null;
  action: GithubImportResumeAction;
}): GithubImportReceipt | null {
  const expectedRepo = normalizeGithubRepoIdentity(params.action.repo);
  const expectedRef = params.action.ref?.trim() || null;
  const expectedTargetPath = params.action.targetPath?.trim() || null;
  for (let index = 0; index < params.messages.length; index += 1) {
    const candidate = params.messages[index];
    if (!candidate || candidate.role !== "assistant") {
      continue;
    }
    const receipt = parseGithubImportReceipt(candidate);
    if (!receipt || normalizeGithubRepoIdentity(receipt.repo) !== expectedRepo) {
      continue;
    }
    if (receipt.sourceMessageId && receipt.sourceMessageId !== params.request.id) {
      continue;
    }
    if (params.projectId && receipt.projectId && receipt.projectId !== params.projectId) {
      continue;
    }
    if (expectedRef !== receipt.ref) {
      continue;
    }
    if (expectedTargetPath && receipt.targetPath && receipt.targetPath !== expectedTargetPath) {
      continue;
    }
    if (
      receipt.sourceMessageId === params.request.id ||
      isMessageAfterRequest(params.messages, params.request, candidate, index)
    ) {
      return receipt;
    }
  }
  return null;
}

function hasSubmittedSuggestedRetry(
  messages: ChatMessage[],
  request: ChatMessage,
  suggestedRetry: string | null,
): boolean {
  const expected = suggestedRetry?.trim() ?? "";
  if (!expected) {
    return false;
  }
  return messages.some(
    (candidate, index) =>
      candidate.role === "user" &&
      candidate.content.trim() === expected &&
      isMessageAfterRequest(messages, request, candidate, index),
  );
}

function metadataContainsMessageId(value: unknown, messageId: string): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    const record = current as Record<string, unknown>;
    if (record["id"] === messageId) {
      return true;
    }
    pending.push(...Object.values(record));
  }
  return false;
}

function normalizeRetryError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return fallback;
}

export function SecretRequestEntry({
  message,
  projectId,
  details,
}: {
  message: ChatMessage;
  projectId: string | null;
  details: Record<string, unknown> | null;
}) {
  const { openPanelTab, requestUrlPush } = useWorkspaceTabs();

  const parsed = useMemo(() => parseSecretRequestDetails(details), [details]);

  const canOpen = Boolean(projectId);

  const handleOpen = useCallback(() => {
    if (!projectId) {
      return;
    }
    if (parsed.name) {
      setPendingProjectSecretPrefill({
        projectId,
        name: parsed.name,
        description: parsed.description ?? null,
        agentHandles: parsed.agentHandles.length > 0 ? parsed.agentHandles : undefined,
        returnPanelTab: "chat",
      });
    }
    requestUrlPush();
    openPanelTab("secrets", { activate: true });
  }, [openPanelTab, parsed.agentHandles, parsed.description, parsed.name, projectId, requestUrlPush]);

  const title = parsed.name ? "Secret required" : "Secret required (name missing)";
  const content = message.content.trim();
  const description = parsed.description ?? (content.length > 0 ? content : null);
  const inlineSecretName = parsed.name?.trim() ? parsed.name.trim() : null;

  return (
    <Surface
      tone="default"
      radius="2xl"
      shadow="sm"
      data-testid="secret-request-card"
      data-message-type="secret_request"
      className={`${CHAT_BUBBLE_MAX_WIDTH.alert} px-3 py-2.5 text-sm text-slate-700`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Key className="h-4 w-4 text-slate-500" aria-hidden="true" />
            <Text variant="overline" tone="subtle">
              {title}
            </Text>
          </div>
          {parsed.name ? (
            <Text as="div" variant="bodyStrong" tone="primary" className="mt-1 font-mono text-sm">
              {parsed.name}
            </Text>
          ) : null}
          {description ? (
            <Text as="div" variant="caption" tone="muted" className="mt-1">
              {description}
            </Text>
          ) : null}
          {parsed.agentHandles.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {parsed.agentHandles.map((handle) => (
                <Badge key={handle} size="xs" className="text-slate-600">
                  @{handle}
                </Badge>
              ))}
            </div>
          ) : null}
          {inlineSecretName ? (
            <InlineSecretsForm
              projectId={projectId}
              secrets={[
                {
                  name: inlineSecretName,
                  description: parsed.description ?? null,
                },
              ]}
              agentHandles={parsed.agentHandles.length > 0 ? parsed.agentHandles : undefined}
              description={parsed.description ?? null}
            />
          ) : null}
          <Text as="div" variant="caption" tone="muted" className="mt-2 text-xxs">
            Add the secret in Secrets, then reply here and I’ll retry.
          </Text>
        </div>

        <Button
          onPress={handleOpen}
          variant="outline"
          size="xs"
          radius="full"
          isDisabled={!canOpen}
          data-testid="secret-request-open"
          className="shrink-0"
        >
          Manage secrets
        </Button>
      </div>
    </Surface>
  );
}

export function IntegrationRequestEntry({
  message,
  projectId,
  details,
}: {
  message: ChatMessage;
  projectId: string | null;
  details: Record<string, unknown> | null;
}) {
  const { openPanelTab, requestUrlPush } = useWorkspaceTabs();
  const { showStatus } = useStatus();
  const parsed = useMemo(() => parseIntegrationRequestDetails(details), [details]);
  const resumeAction = useMemo(() => parseGithubImportResumeAction(details), [details]);
  const { appendMessages, conversations = [] } = useConversations();
  const {
    activeConversationId,
    messages: activeConversationMessages = [],
    onRecordMessage,
    onSubmit,
  } = useConversation();
  const [retryState, setRetryState] = useState<IntegrationRetryState>({ phase: "idle" });
  const retryFlightRef = useRef<Promise<IntegrationRetryResult | null> | null>(null);
  const [disconnectBusy, setDisconnectBusy] = useState(false);
  const [persistedGithubConnected, setPersistedGithubConnected] = useState(false);
  const [githubIntegrationChecked, setGithubIntegrationChecked] = useState(false);
  const [githubIntegrationLoading, setGithubIntegrationLoading] = useState(false);

  const provider = parsed.provider ?? null;
  const providerLabel =
    provider && provider.length > 0
      ? `${provider.slice(0, 1).toUpperCase()}${provider.slice(1)}`
      : "Integration";
  const isGithub = provider === "github";
  const oauthEnabled = parsed.authMethods.includes("oauth") || (isGithub && parsed.authMethods.length === 0);
  const canOpenSecrets = Boolean(projectId);
  const defaultSecretName = useMemo(() => {
    if (parsed.suggestedSecretNames.length > 0) {
      return parsed.suggestedSecretNames[0];
    }
    if (isGithub) {
      return "GITHUB_TOKEN";
    }
    return null;
  }, [isGithub, parsed.suggestedSecretNames]);
  const remainingSecretNames = useMemo(
    () => (parsed.suggestedSecretNames.length > 1 ? parsed.suggestedSecretNames.slice(1) : []),
    [parsed.suggestedSecretNames],
  );
  const secretsSummary = useMemo(() => {
    const names = parsed.suggestedSecretNames;
    if (names.length === 0) {
      return null;
    }
    if (names.length <= 3) {
      return names.join(", ");
    }
    return `${names.slice(0, 3).join(", ")}, +${names.length - 3} more`;
  }, [parsed.suggestedSecretNames]);
  const requestedAccess = useMemo(() => {
    const values = [...parsed.requiredScopes, ...parsed.capabilities]
      .map((value) => value.trim())
      .filter(Boolean);
    return Array.from(new Set(values));
  }, [parsed.capabilities, parsed.requiredScopes]);
  const cardDescription = parsed.description ?? (message.content.trim().length > 0 ? message.content.trim() : null);
  const suggestedRetry = useMemo(
    () => resolveUiSuggestedReplies(message.metadata)[0] ?? null,
    [message.metadata],
  );
  const githubPermissionNote = isGithub
    ? "GitHub will ask for broad private-repository access. Instafy uses it here to import this repo; use a token instead if you want to limit access to one repository."
    : null;
  const inlineSecrets = useMemo(() => parsed.suggestedSecrets, [parsed.suggestedSecrets]);
  const containingConversation = useMemo(
    () =>
      conversations.find((conversation) =>
        conversation.messages.some(
          (entry) =>
            entry.id === message.id || metadataContainsMessageId(entry.metadata, message.id),
        ),
      ) ?? null,
    [conversations, message.id],
  );
  const requestConversationId = containingConversation?.localId ?? activeConversationId;
  const requestConversationMessages = useMemo(
    () =>
      containingConversation && containingConversation.localId !== activeConversationId
        ? containingConversation.messages
        : activeConversationMessages,
    [activeConversationId, activeConversationMessages, containingConversation],
  );
  const durableGithubImportReceipt = useMemo(
    () =>
      resumeAction?.kind === "github_import"
        ? findGithubImportReceipt({
            messages: requestConversationMessages,
            request: message,
            projectId,
            action: resumeAction,
          })
        : null,
    [message, projectId, requestConversationMessages, resumeAction],
  );
  const durableSuggestedRetrySubmitted = useMemo(
    () =>
      resumeAction?.kind !== "github_import" &&
      hasSubmittedSuggestedRetry(requestConversationMessages, message, suggestedRetry),
    [message, requestConversationMessages, resumeAction, suggestedRetry],
  );
  const githubImportRetryIdentity = useMemo(
    () =>
      projectId && resumeAction?.kind === "github_import"
        ? buildGithubImportRetryIdentity({
            projectId,
            sourceMessageId: message.id,
            repo: resumeAction.repo,
            ref: resumeAction.ref,
            targetPath: resumeAction.targetPath,
          })
        : null,
    [message.id, projectId, resumeAction],
  );
  const subscribeToGithubImportRetry = useCallback(
    (listener: () => void) =>
      subscribeGithubImportRetry(githubImportRetryIdentity?.registryKey ?? null, listener),
    [githubImportRetryIdentity?.registryKey],
  );
  const readGithubImportRetrySnapshot = useCallback(
    () => getGithubImportRetrySnapshot(githubImportRetryIdentity?.registryKey ?? null),
    [githubImportRetryIdentity?.registryKey],
  );
  const sharedGithubImportRetryState = useSyncExternalStore(
    subscribeToGithubImportRetry,
    readGithubImportRetrySnapshot,
    readGithubImportRetrySnapshot,
  );
  const effectiveRetryState = useMemo<IntegrationRetryState>(() => {
    if (durableGithubImportReceipt && resumeAction?.kind === "github_import") {
      return {
        phase: "succeeded",
        operation: "github_import",
        repo: durableGithubImportReceipt.repo,
        ref: durableGithubImportReceipt.ref,
        targetPath: durableGithubImportReceipt.targetPath,
        fileCount: durableGithubImportReceipt.fileCount,
      };
    }
    if (
      resumeAction?.kind === "github_import" &&
      sharedGithubImportRetryState.phase !== "idle"
    ) {
      return sharedGithubImportRetryState;
    }
    if (durableSuggestedRetrySubmitted) {
      return { phase: "succeeded", operation: "suggested_request" };
    }
    return retryState;
  }, [
    durableGithubImportReceipt,
    durableSuggestedRetrySubmitted,
    resumeAction,
    retryState,
    sharedGithubImportRetryState,
  ]);
  const retryBusy = effectiveRetryState.phase === "running";
  const githubImportRetryBusy =
    effectiveRetryState.phase === "running" &&
    effectiveRetryState.operation === "github_import";
  const retryError = effectiveRetryState.phase === "failed" ? effectiveRetryState.error : null;
  const importResolved =
    effectiveRetryState.phase === "succeeded" && effectiveRetryState.operation === "github_import"
      ? effectiveRetryState
      : null;
  const suggestedRetrySubmitted =
    effectiveRetryState.phase === "succeeded" &&
    effectiveRetryState.operation === "suggested_request";
  const resumeGithubImport = useCallback(
    (
      githubDeviceAuthSessionId: string | null = null,
      prepareImport: (() => Promise<IntegrationRetryResult>) | null = null,
    ): Promise<IntegrationRetryResult | null> => {
      if (
        !isGithub ||
        !projectId ||
        !requestConversationId ||
        resumeAction?.kind !== "github_import" ||
        !githubImportRetryIdentity
      ) {
        return Promise.resolve(null);
      }
      if (durableGithubImportReceipt) {
        return Promise.resolve({ success: true });
      }
      const attempt = runGithubImportRetry(githubImportRetryIdentity.registryKey, async () => {
        if (prepareImport) {
          const preparation = await prepareImport();
          if (!preparation.success) {
            return preparation;
          }
        }
        let importResult;
        try {
          importResult = await executeGithubProjectImport({
            projectId,
            repo: resumeAction.repo,
            ref: resumeAction.ref,
            targetPath: resumeAction.targetPath,
            githubDeviceAuthSessionId,
            idempotencyKey:
              resumeAction.idempotencyKey ?? githubImportRetryIdentity.idempotencyKey,
            queueFollowup: false,
          });
        } catch (error) {
          return {
            success: false as const,
            error: normalizeRetryError(error, "GitHub import failed."),
          };
        }
        if (!importResult.success) {
          return {
            success: false as const,
            error: normalizeRetryError(importResult.error, "GitHub import failed."),
          };
        }

        const resolvedTargetPath = importResult.targetPath ?? resumeAction.targetPath;
        showStatus(
          formatGithubImportSuccessMessage({
            repo: resumeAction.repo,
            fileCount: importResult.fileCount ?? null,
            targetPath: resolvedTargetPath,
          }),
          "success",
          3500,
        );

        // The import itself has already succeeded. Recording the receipt is
        // best-effort and must never turn that success back into a retryable
        // failure (which could cause a duplicate import).
        try {
          const importFollowupMessage = buildGithubImportFollowupMessageFromPayload({
            projectId,
            repo: resumeAction.repo,
            ref: resumeAction.ref,
            targetPath: resolvedTargetPath,
            fileCount: importResult.fileCount ?? null,
            sourceMessageId: message.id,
          });
          const followupMetadata = {
            ...((importFollowupMessage.metadata as Record<string, unknown> | null) ?? {}),
            clientMessageId: `${
              resumeAction.idempotencyKey ?? githubImportRetryIdentity.idempotencyKey
            }:receipt`,
          };
          const followupWithIdempotency = {
            ...importFollowupMessage,
            metadata: followupMetadata,
          };
          const recordedImportFollowupMessage = await onRecordMessage(
            requestConversationId,
            importFollowupMessage.content,
            followupMetadata,
            "assistant",
          ).catch(() => null);
          appendMessages(requestConversationId, [
            recordedImportFollowupMessage ?? followupWithIdempotency,
          ]);
        } catch {
          // The resolved state still truthfully reflects the completed import.
        }
        return {
          success: true as const,
          repo: resumeAction.repo,
          ref: resumeAction.ref,
          targetPath: resolvedTargetPath,
          fileCount: importResult.fileCount ?? null,
        };
      });
      return attempt.then((outcome) =>
        outcome.success ? { success: true } : outcome,
      );
    },
    [
      appendMessages,
      durableGithubImportReceipt,
      githubImportRetryIdentity,
      isGithub,
      message.id,
      onRecordMessage,
      projectId,
      requestConversationId,
      resumeAction,
      showStatus,
    ],
  );
  const resumeGithubImportWithProjectToken = useCallback((): Promise<IntegrationRetryResult | null> => {
    if (!isGithub || !projectId || !provider || resumeAction?.kind !== "github_import") {
      return Promise.resolve(null);
    }
    return resumeGithubImport(null, async () => {
      let integrationResult;
      try {
        integrationResult = await upsertProjectIntegration(projectId, provider, {
          status: "connected",
          connectionType: "token",
          requiredScopes: parsed.requiredScopes,
          capabilities: parsed.capabilities,
          metadata: {
            source: "chat_integration_request",
            connectedAt: new Date().toISOString(),
            authMode: "token",
            enabled: true,
          },
        });
      } catch (error) {
        return {
          success: false,
          error: normalizeRetryError(
            error,
            "Unable to activate the saved GitHub token for this project.",
          ),
        };
      }
      if (!integrationResult.success) {
        return {
          success: false,
          error: normalizeRetryError(
            integrationResult.error,
            "Unable to activate the saved GitHub token for this project.",
          ),
        };
      }

      // The shared flight begins before this upsert, so a remount cannot expose
      // a second import that races ahead using an older OAuth connection.
      setPersistedGithubConnected(true);
      return { success: true };
    });
  }, [
    isGithub,
    parsed.capabilities,
    parsed.requiredScopes,
    projectId,
    provider,
    resumeAction,
    resumeGithubImport,
  ]);
  const githubDeviceAuth = useDeviceAuthFlow({
    onCompleted: async ({ sessionId }) => {
      if (isGithub) {
        setPersistedGithubConnected(true);
      }
      // The import endpoint records the project connection together with the
      // completed operation. A second fire-and-forget upsert here can land
      // after a long import and overwrite newer disconnect/auth metadata.
      if (projectId && provider && resumeAction?.kind !== "github_import") {
        const connectedAt = new Date().toISOString();
        void upsertProjectIntegration(projectId, provider, {
          status: "connected",
          connectionType: "oauth",
          requiredScopes: parsed.requiredScopes,
          capabilities: parsed.capabilities,
          metadata: {
            source: "chat_integration_request",
            connectedAt,
          },
        }).catch(() => null);
      }
      if (resumeAction?.kind === "github_import") {
        const resumeResult = await resumeGithubImport(sessionId);
        if (resumeResult) {
          return resumeResult;
        }
      }
      showStatus("GitHub connected. Retry your previous request.", "success", 3500);
      return { success: true };
    },
    onCancelled: () => {
      showStatus("GitHub device login cancelled.", "info", 3500);
    },
  });
  const githubDeviceAuthSession = githubDeviceAuth.session;
  const githubDeviceAuthError = githubDeviceAuth.error;
  const githubDeviceAuthBusy = githubDeviceAuth.busy;
  const beginGithubDeviceAuthFlow = githubDeviceAuth.begin;
  const cancelGithubDeviceAuthFlow = githubDeviceAuth.cancel;
  const githubConnected =
    isGithub && (githubDeviceAuthSession?.status === "completed" || persistedGithubConnected);
  const githubCheckingAccess =
    isGithub &&
    Boolean(projectId) &&
    (githubIntegrationLoading || !githubIntegrationChecked) &&
    !githubDeviceAuthSession &&
    !githubConnected;
  // A completed device-auth session in this card means the user connected just
  // now to unblock the request; a persisted connection means the request failed
  // even though GitHub was already connected — a very different situation.
  const justConnectedHere = githubDeviceAuthSession?.status === "completed";
  const connectedDescription = useMemo(() => {
    if (!githubConnected) {
      return null;
    }
    if (resumeAction?.kind === "github_import") {
      return justConnectedHere
        ? `Retry the import of ${resumeAction.repo} to continue.`
        : `Importing ${resumeAction.repo} failed even though GitHub is connected — the connected account may lack access, or the URL may be wrong.`;
    }
    if (suggestedRetry) {
      return "Retry the blocked request from here.";
    }
    return "GitHub is connected for this project.";
  }, [githubConnected, justConnectedHere, resumeAction, suggestedRetry]);

  useEffect(() => {
    if (!isGithub || !projectId) {
      setPersistedGithubConnected(false);
      setGithubIntegrationChecked(false);
      setGithubIntegrationLoading(false);
      return;
    }

    let cancelled = false;
    setGithubIntegrationChecked(false);
    setGithubIntegrationLoading(true);
    void listProjectIntegrations(projectId)
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (!result.success) {
          setPersistedGithubConnected(false);
          return;
        }
        const githubIntegration = result.integrations.find(
          (integration) => integration.provider.trim().toLowerCase() === "github",
        );
        const connected =
          githubIntegration !== undefined &&
          ATTACHED_INTEGRATION_STATUSES.has(githubIntegration.status.trim().toLowerCase()) &&
          integrationMetadataAllowsAttached(githubIntegration.metadata);
        setPersistedGithubConnected(connected);
      })
      .catch(() => {
        if (!cancelled) {
          setPersistedGithubConnected(false);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setGithubIntegrationChecked(true);
          setGithubIntegrationLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isGithub, projectId]);

  const beginGithubDeviceAuth = useCallback(async () => {
    if (!isGithub || !oauthEnabled || retryBusy || disconnectBusy) {
      return;
    }
    setRetryState({ phase: "idle" });
    await beginGithubDeviceAuthFlow({ provider: "github" });
  }, [beginGithubDeviceAuthFlow, disconnectBusy, isGithub, oauthEnabled, retryBusy]);

  const cancelGithubDeviceAuthSession = useCallback(async () => {
    await cancelGithubDeviceAuthFlow();
  }, [cancelGithubDeviceAuthFlow]);

  const disconnectGithubIntegration = useCallback(async () => {
    if (disconnectBusy || retryBusy) {
      return;
    }
    setDisconnectBusy(true);
    try {
      await cancelGithubDeviceAuthFlow();
      if (projectId && provider) {
        const result = await upsertProjectIntegration(projectId, provider, {
          status: "disconnected",
          connectionType: "oauth",
          metadata: {
            source: "chat_integration_request",
            disconnectedAt: new Date().toISOString(),
            enabled: false,
          },
          requiredScopes: parsed.requiredScopes,
          capabilities: parsed.capabilities,
        });
        if (!result.success) {
          showStatus(result.error ?? "Unable to disconnect GitHub.", "error", 5000);
          return;
        }
      }
      setRetryState({ phase: "idle" });
      setPersistedGithubConnected(false);
    } catch (error) {
      showStatus(normalizeRetryError(error, "Unable to disconnect GitHub."), "error", 5000);
    } finally {
      setDisconnectBusy(false);
    }
  }, [
    cancelGithubDeviceAuthFlow,
    disconnectBusy,
    parsed.capabilities,
    parsed.requiredScopes,
    projectId,
    provider,
    retryBusy,
    showStatus,
  ]);
  const retryConnectedRequest = useCallback(async () => {
    if (!requestConversationId || retryFlightRef.current || disconnectBusy) {
      return;
    }
    // Imports retry through the deterministic import API — never via a chat
    // message, which would dispatch an agent run (and burn a managed prompt)
    // for something the controller can do directly.
    if (resumeAction?.kind === "github_import") {
      await resumeGithubImport();
      return;
    }
    if (!suggestedRetry) {
      return;
    }
    const attempt = (async (): Promise<IntegrationRetryResult | null> => {
      setRetryState({ phase: "running", operation: "suggested_request" });
      try {
        await onSubmit(requestConversationId, suggestedRetry);
        // The run result arrives as a newer message. This historical request
        // becomes inert as soon as the retry has been accepted.
        setRetryState({ phase: "succeeded", operation: "suggested_request" });
        return { success: true };
      } catch (error) {
        const message = normalizeRetryError(error, "Unable to retry the request.");
        setRetryState({
          phase: "failed",
          operation: "suggested_request",
          error: message,
        });
        return { success: false, error: message };
      }
    })();
    const trackedAttempt = attempt.finally(() => {
      if (retryFlightRef.current === trackedAttempt) {
        retryFlightRef.current = null;
      }
    });
    retryFlightRef.current = trackedAttempt;
    await trackedAttempt;
  }, [disconnectBusy, onSubmit, requestConversationId, resumeAction, resumeGithubImport, suggestedRetry]);

  const handleOpenSecrets = useCallback(() => {
    if (!projectId) {
      return;
    }
    if (defaultSecretName) {
      setPendingProjectSecretPrefill({
        projectId,
        name: defaultSecretName,
        description: parsed.description ?? null,
        agentHandles: parsed.agentHandles.length > 0 ? parsed.agentHandles : undefined,
        remainingNames: remainingSecretNames.length > 0 ? remainingSecretNames : undefined,
        returnPanelTab: "chat",
      });
    }
    requestUrlPush();
    openPanelTab("secrets", { activate: true });
  }, [
    defaultSecretName,
    openPanelTab,
    parsed.agentHandles,
    parsed.description,
    projectId,
    remainingSecretNames,
    requestUrlPush,
  ]);

  if (importResolved) {
    return (
      <AccessDecisionCard
        data-testid="integration-request-card"
        data-message-type="integration_request"
        resolved
        className={`${CHAT_BUBBLE_MAX_WIDTH.card} px-4 py-3 text-slate-700 dark:text-slate-200`}
      >
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-950 shadow-sm shadow-slate-950/10 dark:border-white/15 dark:bg-white dark:text-slate-950 dark:shadow-black/30">
            <GitHubIcon className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <Text as="span" variant="bodyStrong" tone="primary" className="text-sm text-slate-950 dark:text-white">
              Repository imported
            </Text>
            <Text
              as="div"
              variant="caption"
              tone="muted"
              className="mt-0.5 text-sm leading-5"
              data-testid="integration-request-import-resolved"
            >
              {formatGithubImportSuccessMessage({
                repo: importResolved.repo,
                fileCount: importResolved.fileCount,
                targetPath: importResolved.targetPath,
              })} The result appears below.
            </Text>
          </div>
        </div>
      </AccessDecisionCard>
    );
  }

  if (githubConnected) {
    return (
      <AccessDecisionCard
        data-testid="integration-request-card"
        data-message-type="integration_request"
        resolved
        className={`${CHAT_BUBBLE_MAX_WIDTH.card} px-4 py-3 text-slate-700 dark:text-slate-200`}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-950 shadow-sm shadow-slate-950/10 dark:border-white/15 dark:bg-white dark:text-slate-950 dark:shadow-black/30">
              <GitHubIcon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <Text as="span" variant="bodyStrong" tone="primary" className="text-sm text-slate-950 dark:text-white">
                GitHub connected
              </Text>
              {connectedDescription ? (
                <Text as="div" variant="caption" tone="muted" className="mt-0.5 text-sm leading-5">
                  {connectedDescription}
                </Text>
              ) : null}
              {retryError ? (
                <Text
                  as="div"
                  variant="caption"
                  tone="inherit"
                  className="mt-1 text-sm leading-5 text-rose-600 dark:text-rose-300"
                  data-testid="integration-request-retry-error"
                >
                  {retryError}
                </Text>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
            {suggestedRetrySubmitted ? (
              <Text
                as="span"
                variant="caption"
                tone="muted"
                data-testid="integration-request-retry-sent"
              >
                Retry sent — the result appears below.
              </Text>
            ) : (
              <>
                {resumeAction?.kind === "github_import" || suggestedRetry ? (
                  <Button
                    onPress={() => void retryConnectedRequest()}
                    variant={
                      resumeAction?.kind === "github_import" && !justConnectedHere
                        ? "outline"
                        : "primary"
                    }
                    size="sm"
                    radius="full"
                    isDisabled={githubDeviceAuthBusy || retryBusy || disconnectBusy}
                    data-testid="integration-request-retry"
                    className="px-3 py-1.5 text-sm"
                  >
                    {retryBusy
                      ? "Retrying..."
                      : resumeAction?.kind === "github_import"
                        ? justConnectedHere
                          ? "Retry import"
                          : "Try again"
                        : "Retry request"}
                  </Button>
                ) : null}
                <Button
                  onPress={() => void disconnectGithubIntegration()}
                  variant="outline"
                  size="sm"
                  radius="full"
                  aria-label="Disconnect GitHub"
                  isDisabled={githubDeviceAuthBusy || retryBusy || disconnectBusy}
                  className="px-3 py-1.5 text-sm"
                >
                  {disconnectBusy
                    ? resumeAction?.kind === "github_import" && !justConnectedHere
                      ? "Switching..."
                      : "Disconnecting..."
                    : resumeAction?.kind === "github_import" && !justConnectedHere
                      ? "Use a different account"
                      : "Disconnect"}
                </Button>
              </>
            )}
          </div>
        </div>
      </AccessDecisionCard>
    );
  }

  return (
    <AccessDecisionCard
      data-testid="integration-request-card"
      data-message-type="integration_request"
      className="text-slate-700 dark:text-slate-200"
    >
      <AccessDecisionContent
        icon={isGithub ? <GitHubIcon className="h-7 w-7" /> : <GitBranch className="h-6 w-6" aria-hidden="true" />}
        title={
          githubConnected
            ? "GitHub connected"
            : githubCheckingAccess
              ? "Checking GitHub access"
              : isGithub
                ? "GitHub access required"
                : `${providerLabel} access required`
        }
        description={
          githubConnected
            ? connectedDescription
            : githubCheckingAccess
              ? "Looking for an existing project connection."
              : cardDescription
        }
        bodyPlacement={isGithub ? "full" : "content"}
      >
        {requestedAccess.length > 0 && !githubConnected && !githubCheckingAccess ? (
          <div className={isGithub ? "mt-6" : "mt-5"}>
            <AccessSectionLabel>{isGithub ? "Instafy will use" : "Access requested"}</AccessSectionLabel>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {requestedAccess.slice(0, 8).map((access) => (
                <AccessPill key={`access-${access}`}>{access}</AccessPill>
              ))}
            </div>
          </div>
        ) : null}
        {githubPermissionNote && !githubConnected && !githubCheckingAccess ? (
          <div className="mt-4 rounded-2xl border border-amber-200/80 bg-amber-50/80 px-4 py-3 text-sm leading-6 text-amber-950 shadow-sm shadow-amber-950/5 dark:border-amber-300/20 dark:bg-amber-400/10 dark:text-amber-100">
            {githubPermissionNote}
          </div>
        ) : null}
        {secretsSummary ? (
          <Text as="div" variant="caption" tone="muted" className="mt-3 text-xxs">
            Expected secrets: {secretsSummary}
          </Text>
        ) : null}
        {inlineSecrets.length > 0 ? (
          <InlineSecretsForm
            projectId={projectId}
            secrets={inlineSecrets}
            agentHandles={parsed.agentHandles.length > 0 ? parsed.agentHandles : undefined}
            description={parsed.description ?? null}
            onSaved={(names) => {
              const savedGithubToken = names.some((name) =>
                GITHUB_TOKEN_SECRET_NAMES.has(name.trim().toUpperCase()),
              );
              if (isGithub && resumeAction?.kind === "github_import" && savedGithubToken) {
                void resumeGithubImportWithProjectToken();
              }
            }}
          />
        ) : null}
        {githubImportRetryBusy ? (
          <div
            className="mt-3 flex items-center gap-2 text-sm text-slate-500 dark:text-slate-300"
            data-testid="integration-request-import-busy"
          >
            <Spinner aria-hidden="true" tone="slate" size="xs" />
            <span>Importing repo…</span>
          </div>
        ) : null}
        {retryError ? (
          <Text
            as="div"
            variant="caption"
            tone="inherit"
            className="mt-3 text-sm leading-5 text-rose-600 dark:text-rose-300"
            data-testid="integration-request-retry-error"
          >
            {retryError}
          </Text>
        ) : null}
        {githubDeviceAuthError && !githubDeviceAuthSession ? (
          <Text
            as="div"
            variant="caption"
            tone="inherit"
            className="mt-3 text-sm leading-5 text-rose-600 dark:text-rose-300"
            data-testid="integration-request-device-auth-error"
          >
            {githubDeviceAuthError}
          </Text>
        ) : null}
        {parsed.agentHandles.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {parsed.agentHandles.map((handle) => (
              <Badge key={handle} size="xs" className="text-slate-600">
                @{handle}
              </Badge>
            ))}
          </div>
        ) : null}
        <div className={isGithub ? "mt-5 flex flex-col gap-3 sm:flex-row sm:items-center" : "mt-5 flex flex-wrap items-center gap-3"}>
          {githubCheckingAccess ? (
            <div className="flex items-center gap-2 rounded-full border border-slate-200/70 bg-white/70 px-3 py-2 text-sm text-slate-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-300">
              <Spinner aria-hidden="true" tone="slate" size="xs" />
              <span>Checking saved GitHub connection…</span>
            </div>
          ) : null}
          {isGithub && oauthEnabled ? (
            !githubDeviceAuthSession && !githubCheckingAccess ? (
              <Button
                onPress={() => void beginGithubDeviceAuth()}
                variant="primary"
                size="sm"
                radius="full"
                isDisabled={githubDeviceAuthBusy || retryBusy || disconnectBusy}
                data-testid="integration-request-connect-github"
                className="justify-center bg-primary-600 px-5 py-2 text-sm shadow-lg shadow-primary-600/20 hover:bg-primary-700 data-[hovered]:bg-primary-700 dark:shadow-primary-950/40 sm:justify-start"
              >
                <GitHubIcon className="h-4 w-4" />
                Connect GitHub account
              </Button>
            ) : null
          ) : null}
          {inlineSecrets.length === 0 && !githubDeviceAuthSession && !githubCheckingAccess ? (
            <Button
              onPress={handleOpenSecrets}
              variant="ghost"
              size="sm"
              radius="full"
              isDisabled={!canOpenSecrets}
              data-testid="integration-request-open-secrets"
              className="px-2.5 py-2 text-sm text-primary-700 hover:bg-primary-50 data-[hovered]:bg-primary-50 dark:text-primary-300 dark:hover:bg-primary-400/10 dark:data-[hovered]:bg-primary-400/10"
            >
              {defaultSecretName
                ? remainingSecretNames.length > 0
                  ? `Use ${defaultSecretName} instead (+${remainingSecretNames.length})`
                  : isGithub
                    ? "Use one-repo token instead"
                    : `Use ${defaultSecretName} instead`
                : provider
                  ? `Add ${providerLabel} secret`
                  : "Manage secrets"}
            </Button>
          ) : null}
        </div>
      </AccessDecisionContent>
      {githubDeviceAuthSession && githubDeviceAuthSession.status !== "completed" ? (
        <div className="mt-6 rounded-3xl border border-slate-200/70 bg-white/80 px-4 py-4 text-sm text-slate-600 shadow-lg shadow-slate-950/8 dark:border-white/10 dark:bg-black/20 dark:text-slate-300">
          <Text as="div" variant="bodyStrong" tone="secondary" className="text-sm">
            Open GitHub and enter this code:
          </Text>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <code className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-semibold tracking-wide text-slate-800 dark:bg-slate-800 dark:text-slate-100">
              {githubDeviceAuthSession.userCode}
            </code>
            <Button
              onPress={() => {
                try {
                  void navigator.clipboard?.writeText(githubDeviceAuthSession.userCode);
                } catch {
                  // ignore
                }
              }}
              variant="ghost"
              size="sm"
              radius="full"
              isDisabled={githubDeviceAuthBusy}
            >
              Copy
            </Button>
            <Button
              onPress={() => void openExternalUrl(githubDeviceAuthSession.verificationUrl)}
              variant="outline"
              size="sm"
              radius="full"
              isDisabled={githubDeviceAuthBusy || retryBusy || disconnectBusy}
            >
              Open login
            </Button>
          </div>
          <div className="mt-4 flex items-center gap-2 text-sm text-slate-500 dark:text-slate-300">
            {githubImportRetryBusy ? (
              <>
                <Spinner aria-hidden="true" tone="slate" size="xs" />
                <span>Importing repo…</span>
              </>
            ) : githubDeviceAuthSession.status === "pending" ? (
              <>
                <Spinner aria-hidden="true" tone="slate" size="xs" />
                <span>Waiting for GitHub approval…</span>
              </>
            ) : githubDeviceAuthSession.status === "failed" ? (
              <span className="text-rose-600 dark:text-rose-400">
                {githubDeviceAuthSession.error ?? "GitHub login failed."}
              </span>
            ) : (
              <span>GitHub login was cancelled.</span>
            )}
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            {inlineSecrets.length === 0 ? (
              <Button
                onPress={handleOpenSecrets}
                variant="ghost"
                size="sm"
                radius="full"
                isDisabled={!canOpenSecrets}
                data-testid="integration-request-open-secrets"
                className="px-2.5 py-2 text-sm text-primary-700 hover:bg-primary-50 data-[hovered]:bg-primary-50 dark:text-primary-300 dark:hover:bg-primary-400/10 dark:data-[hovered]:bg-primary-400/10"
              >
                {defaultSecretName
                  ? remainingSecretNames.length > 0
                    ? `Use ${defaultSecretName} instead (+${remainingSecretNames.length})`
                    : isGithub
                      ? "Use one-repo token instead"
                      : `Use ${defaultSecretName} instead`
                  : provider
                    ? `Add ${providerLabel} secret`
                    : "Manage secrets"}
              </Button>
            ) : (
              <span />
            )}
            <Button
              onPress={cancelGithubDeviceAuthSession}
              variant="ghost"
              size="sm"
              radius="full"
              isDisabled={githubDeviceAuthBusy || retryBusy || disconnectBusy}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </AccessDecisionCard>
  );
}
