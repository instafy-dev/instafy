import { findProjectManifest } from "./project-manifest.js";
import { requestControllerApiJson } from "./api.js";

type ChatCommonOptions = {
  controllerUrl?: string;
  accessToken?: string;
  serviceToken?: string;
  timeoutMs?: number;
  pollMs?: number;
};

export type ChatPromptOptions = ChatCommonOptions & {
  prompt: string;
  project?: string;
  conversation?: string;
  intent?: string;
  wait?: boolean;
  json?: boolean;
  acceptStatusReply?: boolean;
};

type DispatchResponse = {
  runId?: string | null;
  promptId?: string | null;
  status?: string | null;
  conversationId?: string | null;
};

type ConversationMessage = {
  id: string;
  run_id?: string | null;
  runId?: string | null;
  role: string;
  content: string;
  metadata?: Record<string, unknown> | null;
  created_at?: string;
  createdAt?: string;
};

type ConversationMessagesPage = {
  messages?: ConversationMessage[];
};

type RunSnapshot = {
  id: string;
  status: string;
};

function resolveProjectId(rawProject: string | undefined): string {
  const explicit = rawProject?.trim();
  if (explicit) {
    return explicit;
  }

  const fromEnv =
    process.env["SPACE_ID"]?.trim() ||
    process.env["INSTAFY_SPACE_ID"]?.trim() ||
    process.env["PROJECT_ID"]?.trim() ||
    process.env["INSTAFY_PROJECT_ID"]?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  const manifest = findProjectManifest(process.cwd()).manifest;
  if (manifest?.spaceId?.trim()) {
    return manifest.spaceId.trim();
  }

  throw new Error(
    "No space configured. Pass --space, set SPACE_ID, or run `instafy space init`.",
  );
}

function normalizePrompt(prompt: string): string {
  const value = prompt.trim();
  if (!value) {
    throw new Error("Prompt cannot be empty.");
  }
  return value;
}

function extractMentionedAgentHandles(prompt: string): string[] {
  const seen = new Set<string>();
  const handles: string[] = [];
  const matcher = /(^|[^A-Za-z0-9_.-])@([A-Za-z0-9][A-Za-z0-9_-]{0,19})(?![A-Za-z0-9_-])/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(prompt)) !== null) {
    const raw = match[2]?.trim().toLowerCase();
    if (!raw || seen.has(raw)) {
      continue;
    }
    seen.add(raw);
    handles.push(raw);
  }
  return handles;
}

function buildPromptMetadata(prompt: string): Record<string, unknown> {
  const mentionedHandles = extractMentionedAgentHandles(prompt);
  if (mentionedHandles.length === 0) {
    return {};
  }
  return {
    agentSelection: {
      active: mentionedHandles,
      mentions: mentionedHandles,
    },
  };
}

function normalizeBooleanEnv(value: string | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function isRuntimeJobEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  const runtimeId = env["RUNTIME_ID"]?.trim();
  const conversationId = env["INSTAFY_CONVERSATION_ID"]?.trim() || env["CONVERSATION_ID"]?.trim();
  const controllerToken = env["CONTROLLER_ACCESS_TOKEN"]?.trim() || env["RUNTIME_ACCESS_TOKEN"]?.trim();
  return Boolean(runtimeId && conversationId && controllerToken);
}

function resolveDefaultWait(): boolean {
  const explicit = normalizeBooleanEnv(process.env["INSTAFY_CHAT_WAIT_BY_DEFAULT"]);
  if (explicit !== null) {
    return explicit;
  }
  return !isRuntimeJobEnvironment();
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number {
  if (!Number.isFinite(timeoutMs as number)) {
    return 120_000;
  }
  return Math.max(1_000, Math.trunc(timeoutMs as number));
}

function normalizePollMs(pollMs: number | undefined): number {
  if (!Number.isFinite(pollMs as number)) {
    return 1_000;
  }
  return Math.max(250, Math.trunc(pollMs as number));
}

function metadataMessageType(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const direct = metadata["messageType"] ?? metadata["message_type"];
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim().toLowerCase();
  }
  return null;
}

function looksLikeJsonObjectReply(content: string | null | undefined): boolean {
  const trimmed = (content ?? "").trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return true;
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) {
    const inner = fenceMatch[1]?.trim() ?? "";
    return inner.startsWith("{") && inner.endsWith("}");
  }
  return false;
}

function isTerminalStatus(status: string | null | undefined): boolean {
  const normalized = (status ?? "").trim().toLowerCase();
  return [
    "completed",
    "complete",
    "failed",
    "error",
    "errored",
    "cancelled",
    "canceled",
    "ready",
    "succeeded",
  ].includes(normalized);
}

function isSuccessfulTerminalStatus(status: string | null | undefined): boolean {
  const normalized = (status ?? "").trim().toLowerCase();
  return ["completed", "complete", "ready", "succeeded"].includes(normalized);
}

function messageRunId(message: ConversationMessage): string | null {
  const raw = message.runId ?? message.run_id ?? null;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function isAssistantReplyCandidate(
  message: ConversationMessage,
  runId: string | null,
  options?: { acceptStatusReply?: boolean },
): boolean {
  if ((message.role ?? "").toLowerCase() !== "assistant") return false;
  if (runId && messageRunId(message) !== runId) return false;
  const type = metadataMessageType(message.metadata ?? null);
  if (options?.acceptStatusReply && type === "status") {
    return typeof message.content === "string" && looksLikeJsonObjectReply(message.content);
  }
  if (
    type &&
    [
      "token_usage",
      "command_execution",
      "mcp_tool_call",
      "plan_update",
      "learn_router",
      "integration_request",
      "status",
      "activity",
      "thread_update",
    ].includes(type)
  ) {
    return false;
  }
  return typeof message.content === "string" && message.content.trim().length > 0;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function dispatchPrompt(options: ChatPromptOptions): Promise<{
  conversationId: string;
  runId: string | null;
  promptId: string | null;
  status: string | null;
}> {
  const prompt = normalizePrompt(options.prompt);
  const payload = {
    promptText: prompt,
    intent: options.intent?.trim() || "feature",
    metadata: buildPromptMetadata(prompt),
  };

  if (options.conversation?.trim()) {
    const conversationId = options.conversation.trim();
    const response = await requestControllerApiJson<DispatchResponse>({
      method: "POST",
      path: `/conversations/${conversationId}/messages`,
      controllerUrl: options.controllerUrl,
      accessToken: options.accessToken,
      serviceToken: options.serviceToken,
      jsonBody: payload,
    });
    return {
      conversationId: response.conversationId?.trim() || conversationId,
      runId: response.runId?.trim() || null,
      promptId: response.promptId?.trim() || null,
      status: response.status?.trim() || null,
    };
  }

  const projectId = resolveProjectId(options.project);
  const response = await requestControllerApiJson<DispatchResponse>({
    method: "POST",
    path: `/projects/${projectId}/conversations`,
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
    jsonBody: payload,
  });
  const conversationId = response.conversationId?.trim();
  if (!conversationId) {
    throw new Error("Conversation creation response missing conversationId.");
  }
  return {
    conversationId,
    runId: response.runId?.trim() || null,
    promptId: response.promptId?.trim() || null,
    status: response.status?.trim() || null,
  };
}

async function pollRunStatus(
  conversationId: string,
  runId: string,
  options: ChatCommonOptions,
): Promise<RunSnapshot | null> {
  const runs = await requestControllerApiJson<RunSnapshot[]>({
    method: "GET",
    path: `/conversations/${conversationId}/runs`,
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
    query: ["limit=100"],
  });
  return Array.isArray(runs)
    ? runs.find((run) => typeof run?.id === "string" && run.id === runId) ?? null
    : null;
}

async function fetchConversationMessages(
  conversationId: string,
  options: ChatCommonOptions,
): Promise<ConversationMessage[]> {
  const page = await requestControllerApiJson<ConversationMessagesPage>({
    method: "GET",
    path: `/conversations/${conversationId}/messages`,
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
    query: ["limit=200"],
  });
  return Array.isArray(page?.messages) ? page.messages : [];
}

function findLatestAssistantReply(
  messages: ConversationMessage[],
  runId: string | null,
  options?: { acceptStatusReply?: boolean },
): ConversationMessage | null {
  if (options?.acceptStatusReply) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message || (message.role ?? "").toLowerCase() !== "assistant") continue;
      if (runId && messageRunId(message) !== runId) continue;
      const type = metadataMessageType(message.metadata ?? null);
      if (type === "status" && typeof message.content === "string" && looksLikeJsonObjectReply(message.content)) {
        return message;
      }
    }
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && isAssistantReplyCandidate(message, runId, options)) {
      return message;
    }
  }
  return null;
}

async function waitForAssistantReply(
  conversationId: string,
  runId: string | null,
  options: ChatCommonOptions & { acceptStatusReply?: boolean },
): Promise<{ runStatus: string | null; assistant: ConversationMessage | null }> {
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const pollMs = normalizePollMs(options.pollMs);
  const deadline = Date.now() + timeoutMs;
  let lastStatus: string | null = null;

  while (Date.now() < deadline) {
    const messages = await fetchConversationMessages(conversationId, options);
    const assistant = findLatestAssistantReply(messages, runId, options);
    if (assistant) {
      return { runStatus: lastStatus, assistant };
    }

    if (runId) {
      const run = await pollRunStatus(conversationId, runId, options);
      lastStatus = run?.status ?? lastStatus;
      if (run && isTerminalStatus(run.status)) {
        break;
      }
    }

    await sleep(pollMs);
  }

  const finalMessages = await fetchConversationMessages(conversationId, options);
  const assistant = findLatestAssistantReply(finalMessages, runId, options);
  return { runStatus: lastStatus, assistant };
}

export async function chatPrompt(options: ChatPromptOptions): Promise<void> {
  const dispatched = await dispatchPrompt(options);
  const shouldWait = options.wait ?? resolveDefaultWait();
  if (!shouldWait) {
    const payload = {
      conversationId: dispatched.conversationId,
      runId: dispatched.runId,
      promptId: dispatched.promptId,
      status: dispatched.status,
    };
    console.log(options.json ? JSON.stringify(payload, null, 2) : dispatched.conversationId);
    return;
  }

  const waited = await waitForAssistantReply(
    dispatched.conversationId,
    dispatched.runId,
    options,
  );

  if (!waited.assistant) {
    const suffix = waited.runStatus
      ? ` Last observed run status: ${waited.runStatus}.`
      : "";
    throw new Error(
      `Timed out waiting for assistant reply in conversation ${dispatched.conversationId}.${suffix}`,
    );
  }

  const payload = {
    conversationId: dispatched.conversationId,
    runId: dispatched.runId,
    promptId: dispatched.promptId,
    status:
      waited.runStatus ??
      (dispatched.runId ? (isSuccessfulTerminalStatus(waited.runStatus) ? "completed" : dispatched.status) : dispatched.status),
    messageId: waited.assistant.id,
    reply: waited.assistant.content,
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(waited.assistant.content);
}
