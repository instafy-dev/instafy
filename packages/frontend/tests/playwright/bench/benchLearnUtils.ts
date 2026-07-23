import { expect, type Page } from "@playwright/test";
import { getControllerUrl, getSupabaseAuthHeaders } from "../utils/harness.js";
import { collectLearnRoutingSnapshot, type LearnRoutingSnapshot } from "./benchRoutingDebug.js";

export const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return "-";
  const sign = ms < 0 ? "-" : "";
  const absMs = Math.abs(ms);
  if (absMs < 1000) return `${sign}${absMs}ms`;
  const seconds = Math.round(absMs / 1000);
  if (seconds < 60) return `${sign}${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${sign}${minutes}m ${rem}s`;
}

export function truncateMiddle(input: string, max = 72): string {
  const trimmed = (input ?? "").trim();
  if (trimmed.length <= max) return trimmed;
  const head = Math.max(10, Math.floor((max - 3) / 2));
  const tail = Math.max(10, max - 3 - head);
  return `${trimmed.slice(0, head)}...${trimmed.slice(trimmed.length - tail)}`;
}

export function summarizeBenchSignal(signal: string | null | undefined, max = 160): string {
  const normalized = (signal ?? "-")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "-";
  return truncateMiddle(normalized, max).replace(/\|/g, " ");
}

export async function openNewConversation(page: Page) {
  const tabs = page.locator('[data-testid="workspace-tabs"] [data-tab-kind="conversation"]');
  const previousCount = await tabs.count().catch(() => 0);
  const previousUrl = page.url();

  await page.getByTestId("chat-new-conversation").click();

  await expect
    .poll(
      async () => {
        const currentUrl = page.url();
        const urlChanged = currentUrl !== previousUrl;

        const tabCount = await tabs.count().catch(() => previousCount);
        const countChanged = previousCount > 0 ? tabCount === previousCount + 1 : tabCount > previousCount;

        let conversationChanged = false;
        try {
          const prev = new URL(previousUrl);
          const next = new URL(currentUrl);
          const prevKey = `${prev.searchParams.get("conversationId") ?? ""}:${prev.searchParams.get("conversationControllerId") ?? ""}`;
          const nextKey = `${next.searchParams.get("conversationId") ?? ""}:${next.searchParams.get("conversationControllerId") ?? ""}`;
          conversationChanged = prevKey !== nextKey && nextKey !== ":";
        } catch {
          conversationChanged = false;
        }

        return urlChanged || countChanged || conversationChanged;
      },
      { timeout: 60_000 },
    )
    .toBeTruthy();

  if (previousCount > 0) {
    await expect(tabs).toHaveCount(previousCount + 1, { timeout: 60_000 });
  }

  if (await tabs.last().isVisible().catch(() => false)) {
    await expect(tabs.last()).toHaveAttribute("aria-current", "page", { timeout: 60_000 }).catch(() => {});
  }

  const conversationControllerId = await tryWaitForConversationControllerId(page, 10_000);
  if (conversationControllerId) {
    await expect
      .poll(
        async () => {
          const [messages, runs] = await Promise.all([
            fetchConversationMessages(page, conversationControllerId).catch(() => []),
            fetchConversationRuns(page, conversationControllerId).catch(() => []),
          ]);
          const visibleMessages = messages.filter((message) => {
            const role = (message?.role ?? "").toLowerCase();
            return role === "user" || role === "assistant";
          });
          return {
            messages: visibleMessages.length,
            runs: runs.length,
          };
        },
        { timeout: 15_000 },
      )
      .toEqual({ messages: 0, runs: 0 });
  }

  await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 60_000 });

  return {
    conversationControllerId,
    url: page.url(),
  };
}

function parseConversationControllerIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const value = (parsed.searchParams.get("conversationControllerId") ?? "").trim();
    return UUID_REGEX.test(value) ? value : null;
  } catch {
    return null;
  }
}

export async function tryWaitForConversationControllerId(page: Page, timeoutMs = 10_000): Promise<string | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const id = parseConversationControllerIdFromUrl(page.url());
    if (id) return id;
    await page.waitForTimeout(100);
  }
  return parseConversationControllerIdFromUrl(page.url());
}

export type TokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  model: string | null;
};

export type RunMetrics = {
  runId: string | null;
  tokenUsage: TokenUsage | null;
  mcpToolCalls: number;
  shellCommands: number;
  shellCommandSummaries: string[];
  learnRouterBlocks: Array<{ name: string | null; path: string; score: number | null; matchedTokens: string[] }>;
  learnedBlockReads: string[];
  learnedBlockReadCommands: string[];
};

type ConversationMessage = {
  id?: string | null;
  role?: string | null;
  content?: string | null;
  runId?: string | null;
  metadata?: unknown;
  createdAt?: string | null;
};

type ConversationRunSnapshot = {
  id?: string | null;
  status?: string | null;
  created_at?: string | null;
  createdAt?: string | null;
  updated_at?: string | null;
  updatedAt?: string | null;
};

function conversationRunTimestamp(run: ConversationRunSnapshot): number {
  const raw =
    (typeof run.updatedAt === "string" && run.updatedAt) ||
    (typeof run.updated_at === "string" && run.updated_at) ||
    (typeof run.createdAt === "string" && run.createdAt) ||
    (typeof run.created_at === "string" && run.created_at) ||
    "";
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getMetadataMessageType(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const record = metadata as Record<string, unknown>;
  const raw = record["messageType"];
  return typeof raw === "string" ? raw.trim() : null;
}

function extractTokenUsage(metadata: unknown): TokenUsage | null {
  if (!metadata || typeof metadata !== "object") return null;
  const record = metadata as Record<string, unknown>;
  const details = record["details"];
  if (!details || typeof details !== "object") return null;
  const detailsRecord = details as Record<string, unknown>;
  const usage = detailsRecord["usage"];
  if (!usage || typeof usage !== "object") return null;
  const usageRecord = usage as Record<string, unknown>;

  const input = usageRecord["input_tokens"];
  const cached = usageRecord["cached_input_tokens"];
  const output = usageRecord["output_tokens"];
  if (typeof input !== "number" || typeof cached !== "number" || typeof output !== "number") {
    return null;
  }

  const modelRaw = detailsRecord["model"] ?? record["model"];
  const model = typeof modelRaw === "string" && modelRaw.trim().length > 0 ? modelRaw.trim() : null;
  return {
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    model,
  };
}

function extractCommandFromMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const record = metadata as Record<string, unknown>;
  const raw = record["command"];
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  const details = record["details"];
  if (details && typeof details === "object") {
    const rawDetails = (details as Record<string, unknown>)["command"];
    if (typeof rawDetails === "string" && rawDetails.trim().length > 0) {
      return rawDetails.trim();
    }
  }
  return null;
}

function extractLearnedBlockPaths(command: string): string[] {
  const out = new Set<string>();
  // Match the most common pattern: ... .agents/skills/instafy-learned/blocks/<block>/SKILL.md
  const pattern = /(\.agents\/skills\/instafy-learned\/blocks\/[a-z0-9][a-z0-9-]*\/SKILL\.md)/gi;
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(command)) !== null) {
    const value = match[1]?.trim();
    if (value) out.add(value);
  }
  return [...out];
}

function extractLearnRouterBlockPaths(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object") return [];
  const record = metadata as Record<string, unknown>;
  const blocksRaw = (() => {
    const direct = record["blocks"];
    if (Array.isArray(direct)) return direct;
    const details = record["details"];
    if (details && typeof details === "object") {
      const detailsBlocks = (details as Record<string, unknown>)["blocks"];
      if (Array.isArray(detailsBlocks)) return detailsBlocks;
    }
    return null;
  })();
  const blocks = blocksRaw;
  if (!Array.isArray(blocks)) return [];

  const out = new Set<string>();
  for (const entry of blocks) {
    if (!entry || typeof entry !== "object") continue;
    const block = entry as Record<string, unknown>;
    const pathRaw = block["path"];
    if (typeof pathRaw === "string" && pathRaw.trim().length > 0) {
      out.add(pathRaw.trim());
      continue;
    }
    const nameRaw = block["name"];
    if (typeof nameRaw === "string" && nameRaw.trim().length > 0) {
      const name = nameRaw.trim();
      out.add(`.agents/skills/instafy-learned/blocks/${name}/SKILL.md`);
    }
  }
  return [...out];
}

function extractLearnRouterBlocks(metadata: unknown): Array<{ name: string | null; path: string; score: number | null; matchedTokens: string[] }> {
  if (!metadata || typeof metadata !== "object") return [];
  const record = metadata as Record<string, unknown>;
  const blocksRaw = (() => {
    const direct = record["blocks"];
    if (Array.isArray(direct)) return direct;
    const details = record["details"];
    if (details && typeof details === "object") {
      const detailsBlocks = (details as Record<string, unknown>)["blocks"];
      if (Array.isArray(detailsBlocks)) return detailsBlocks;
    }
    return null;
  })();
  if (!Array.isArray(blocksRaw)) return [];

  const out: Array<{ name: string | null; path: string; score: number | null; matchedTokens: string[] }> = [];
  for (const entry of blocksRaw) {
    if (!entry || typeof entry !== "object") continue;
    const block = entry as Record<string, unknown>;
    const nameRaw = typeof block["name"] === "string" ? (block["name"] as string).trim() : "";
    const name = nameRaw.length > 0 ? nameRaw : null;
    const pathRaw = typeof block["path"] === "string" ? (block["path"] as string).trim() : "";
    const path = pathRaw.length > 0 ? pathRaw : name ? `.agents/skills/instafy-learned/blocks/${name}/SKILL.md` : "";
    if (!path) continue;

    const scoreRaw = block["score"];
    const score = typeof scoreRaw === "number" && Number.isFinite(scoreRaw) ? scoreRaw : null;
    const matchedRaw = block["matchedTokens"];
    const matchedTokens = Array.isArray(matchedRaw)
      ? matchedRaw.map((token) => (typeof token === "string" ? token.trim() : "")).filter((token) => token.length > 0)
      : [];

    out.push({ name, path, score, matchedTokens });
  }
  return out;
}

async function fetchRunMetricsForAttempt(
  page: Page,
  conversationControllerId: string,
  assistantMatch: (content: string) => boolean,
): Promise<RunMetrics> {
  const headers = getSupabaseAuthHeaders();
  const controllerUrl = getControllerUrl();
  const result: RunMetrics = {
    runId: null,
    tokenUsage: null,
    mcpToolCalls: 0,
    shellCommands: 0,
    shellCommandSummaries: [],
    learnRouterBlocks: [],
    learnedBlockReads: [],
    learnedBlockReadCommands: [],
  };

  if (!headers.authorization) {
    return result;
  }

  const response = await page.context().request.get(
    `${controllerUrl}/conversations/${conversationControllerId}/messages?limit=200`,
    { headers },
  );
  if (!response.ok()) {
    const body = await response.text().catch(() => "");
    throw new Error(`failed to fetch conversation messages (${response.status()}): ${body}`);
  }
  const payload = (await response.json().catch(() => null)) as { messages?: any[] } | null;
  const messages = Array.isArray(payload?.messages) ? payload!.messages : [];

  const assistant = messages.find((message) => {
    const role = typeof message?.role === "string" ? message.role : "";
    if (role.toLowerCase() !== "assistant") return false;
    const content = typeof message?.content === "string" ? message.content : "";
    const metadata = message?.metadata;
    const messageType = getMetadataMessageType(metadata)?.toLowerCase() ?? "";
    if (messageType === "token_usage") return false;
    return assistantMatch(content);
  });

  const runId = typeof assistant?.runId === "string" && UUID_REGEX.test(assistant.runId) ? assistant.runId : null;
  let effectiveRunId = runId;
  if (!effectiveRunId) {
    const runs = await fetchConversationRuns(page, conversationControllerId).catch(() => []);
    const latestRun = [...runs]
      .filter((run) => typeof run?.id === "string" && UUID_REGEX.test(run.id ?? ""))
      .sort((a, b) => conversationRunTimestamp(b) - conversationRunTimestamp(a))[0];
    effectiveRunId = typeof latestRun?.id === "string" && UUID_REGEX.test(latestRun.id) ? latestRun.id : null;
  }

  result.runId = effectiveRunId;
  if (!effectiveRunId) {
    return result;
  }

  const learnedBlocks = new Set<string>();
  const learnedBlockCommands: string[] = [];
  const shellCommandSummaries: string[] = [];
  const learnRouterBlocks = new Map<string, { name: string | null; path: string; score: number | null; matchedTokens: string[] }>();
  let lastShellCommand: string | null = null;

  for (const message of messages) {
    const messageRunId = typeof message?.runId === "string" ? message.runId : null;
    if (messageRunId !== effectiveRunId) continue;
    const metadata = message?.metadata;
    const messageType = getMetadataMessageType(metadata)?.toLowerCase() ?? "";
    if (messageType === "token_usage" && !result.tokenUsage) {
      result.tokenUsage = extractTokenUsage(metadata);
    } else if (messageType === "mcp_tool_call") {
      result.mcpToolCalls += 1;
    } else if (messageType === "learn_router") {
      for (const block of extractLearnRouterBlocks(metadata)) {
        learnRouterBlocks.set(block.path, block);
      }
      const paths = extractLearnRouterBlockPaths(metadata);
      if (paths.length > 0) {
        for (const path of paths) {
          learnedBlocks.add(path);
        }
      }
    } else if (messageType === "command_execution") {
      const command = extractCommandFromMetadata(metadata);
      if (command) {
        const normalizedCommand = command.trim();
        const isDuplicateShellEvent =
          lastShellCommand !== null && normalizedCommand.length > 0 && lastShellCommand === normalizedCommand;
        if (!isDuplicateShellEvent) {
          result.shellCommands += 1;
        }
        lastShellCommand = normalizedCommand;
        if (!isDuplicateShellEvent && shellCommandSummaries.length < 12) {
          shellCommandSummaries.push(truncateMiddle(command, 220));
        }
        const paths = extractLearnedBlockPaths(command);
        if (paths.length > 0) {
          for (const path of paths) {
            learnedBlocks.add(path);
          }
          if (!isDuplicateShellEvent && learnedBlockCommands.length < 10) {
            learnedBlockCommands.push(truncateMiddle(command, 220));
          }
        }
      } else {
        result.shellCommands += 1;
        lastShellCommand = null;
      }
    } else {
      lastShellCommand = null;
    }
  }

  result.learnedBlockReads = [...learnedBlocks].sort((a, b) => a.localeCompare(b));
  result.learnedBlockReadCommands = learnedBlockCommands;
  result.shellCommandSummaries = shellCommandSummaries;
  result.learnRouterBlocks = [...learnRouterBlocks.values()].sort((a, b) => a.path.localeCompare(b.path));
  return result;
}

async function fetchConversationMessages(
  page: Page,
  conversationControllerId: string,
): Promise<ConversationMessage[]> {
  const headers = getSupabaseAuthHeaders();
  const controllerUrl = getControllerUrl();
  if (!headers.authorization) return [];

  const response = await page.context().request.get(
    `${controllerUrl}/conversations/${conversationControllerId}/messages?limit=200`,
    { headers },
  );
  if (!response.ok()) {
    const body = await response.text().catch(() => "");
    throw new Error(`failed to fetch conversation messages (${response.status()}): ${body}`);
  }
  const payload = (await response.json().catch(() => null)) as { messages?: ConversationMessage[] } | null;
  return Array.isArray(payload?.messages) ? payload!.messages : [];
}

async function fetchConversationRuns(
  page: Page,
  conversationControllerId: string,
): Promise<ConversationRunSnapshot[]> {
  const headers = getSupabaseAuthHeaders();
  const controllerUrl = getControllerUrl();
  if (!headers.authorization) return [];

  const response = await page.context().request.get(
    `${controllerUrl}/conversations/${conversationControllerId}/runs?limit=100`,
    { headers },
  );
  if (!response.ok()) {
    const body = await response.text().catch(() => "");
    throw new Error(`failed to fetch conversation runs (${response.status()}): ${body}`);
  }
  const payload = (await response.json().catch(() => null)) as ConversationRunSnapshot[] | null;
  return Array.isArray(payload) ? payload : [];
}

function isTerminalRunStatus(status: string | null | undefined): boolean {
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

function findLearnAssistantReply(
  messages: ConversationMessage[],
  command: string,
  baselineMessageIds: Set<string>,
): { signal: string | null; assistantSummary: string | null } | null {
  const normalizedCommand = command.trim();
  const normalizedPrefix = normalizedCommand.split(/\s+/, 1)[0]?.trim().toLowerCase() ?? "";
  const newMessages = messages.filter((message) => {
    const id = typeof message?.id === "string" ? message.id : null;
    return !id || !baselineMessageIds.has(id);
  });

  let learnUserIndex = -1;
  for (let index = 0; index < newMessages.length; index += 1) {
    const message = newMessages[index];
    const role = (message?.role ?? "").toLowerCase();
    const content = typeof message?.content === "string" ? message.content.trim() : "";
    const normalizedContent = content.toLowerCase();
    const matchesCommand =
      content === normalizedCommand ||
      (normalizedPrefix.length > 0 && normalizedContent.startsWith(normalizedPrefix)) ||
      (normalizedPrefix === "/learn" && normalizedContent.includes("/learn"));
    if (role === "user" && matchesCommand) {
      learnUserIndex = index;
      break;
    }
  }
  if (learnUserIndex < 0) return null;

  for (let index = learnUserIndex + 1; index < newMessages.length; index += 1) {
    const message = newMessages[index];
    const role = (message?.role ?? "").toLowerCase();
    if (role !== "assistant") continue;
    const messageType = getMetadataMessageType(message?.metadata)?.toLowerCase() ?? "";
    if (messageType === "token_usage") continue;
    const content = typeof message?.content === "string" ? message.content.trim() : "";
    return {
      signal: content || "learn-message-complete",
      assistantSummary: content || null,
    };
  }

  return null;
}

export async function fetchRunMetricsForAttemptWithRetry(
  page: Page,
  conversationControllerId: string,
  assistantMatch: (content: string) => boolean,
): Promise<RunMetrics> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const metrics = await fetchRunMetricsForAttempt(page, conversationControllerId, assistantMatch);
    if (!metrics.runId) return metrics;
    if (metrics.tokenUsage) return metrics;
    await page.waitForTimeout(500);
  }
  return fetchRunMetricsForAttempt(page, conversationControllerId, assistantMatch);
}

export async function attemptApplyLearn(
  page: Page,
  command: string,
  options?: {
    projectId?: string;
    requireWorkspaceMutation?: boolean;
  },
): Promise<{
  signal: string | null;
  error: string | null;
  wallMs: number | null;
  assistantSummary: string | null;
  workspaceMutatedObserved: boolean;
}> {
  const startedAtMs = Date.now();
  const timeoutMsRaw = Number(process.env.PLAYWRIGHT_BENCH_LEARN_TIMEOUT_MS ?? "120000");
  const timeoutMs = Math.max(15_000, Math.min(240_000, Number.isFinite(timeoutMsRaw) ? timeoutMsRaw : 120_000));
  const quiescenceMsRaw = Number(process.env.PLAYWRIGHT_BENCH_LEARN_QUIESCENCE_MS ?? "4000");
  const quiescenceMs = Math.max(1_500, Math.min(15_000, Number.isFinite(quiescenceMsRaw) ? quiescenceMsRaw : 4_000));
  const activeRunGraceMsRaw = Number(process.env.PLAYWRIGHT_BENCH_LEARN_ACTIVE_RUN_GRACE_MS ?? "12000");
  const activeRunGraceMs = Math.max(
    quiescenceMs,
    Math.min(60_000, Number.isFinite(activeRunGraceMsRaw) ? activeRunGraceMsRaw : 12_000),
  );
  const requireWorkspaceMutation = options?.requireWorkspaceMutation !== false && typeof options?.projectId === "string" && options.projectId.trim().length > 0;
  const projectId = options?.projectId?.trim() || null;
  let signal: string | null = null;
  let error: string | null = null;
  let assistantSummary: string | null = null;
  let workspaceMutatedObserved = !requireWorkspaceMutation;
  try {
    const baselineRoutingSnapshot =
      requireWorkspaceMutation && projectId
        ? await collectLearnRoutingSnapshot(page, projectId).catch(() => null)
        : null;
    let workspaceMutated = workspaceMutatedObserved;

    const conversationControllerId = await tryWaitForConversationControllerId(page, 20_000);
    const baselineMessages = conversationControllerId
      ? await fetchConversationMessages(page, conversationControllerId).catch(() => [])
      : [];
    const baselineRuns = conversationControllerId ? await fetchConversationRuns(page, conversationControllerId).catch(() => []) : [];
    const baselineMessageIds = new Set(
      baselineMessages
        .map((message) => (typeof message?.id === "string" ? message.id : null))
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    );
    const baselineRunIds = new Set(
      baselineRuns
        .map((run) => (typeof run?.id === "string" ? run.id : null))
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    );
    const learnPreviews = page.getByTestId("conversation-thread-preview").filter({ hasText: /learn/i });
    const baselineLearnCount = await learnPreviews.count().catch(() => 0);
    const mainAssistantBubbles = page.locator('[data-testid="chat-bubble-assistant"]');
    const baselineAssistantCount = await mainAssistantBubbles.count().catch(() => 0);

    await page.getByTestId("chat-input").fill(command);
    await expect(page.getByTestId("chat-send-button")).toBeEnabled();
    await page.getByTestId("chat-send-button").click();

    let previewText: string | null = null;
    let candidateSignal: string | null = null;
    let candidateAssistantSummary: string | null = null;
    let workspaceMutationSignal: string | null = null;
    let sawPreview = false;
    let sawLearnUserMessage = false;
    let latestNewRunStatus: string | null = null;
    let sawNewRun = false;
    let hasActiveNewRun = false;
    let lastObservedMessageSignature = `${baselineMessageIds.size}:`;
    let lastObservedRunSignature = `${baselineRunIds.size}:`;
    let lastObservedPreviewSignature = `${baselineLearnCount}:`;
    let lastActivityAt = Date.now();
    let lastWorkspaceMutationAt: number | null = null;
    const startedPollingAt = Date.now();
    while (Date.now() - startedPollingAt < timeoutMs) {
      if (!workspaceMutated && baselineRoutingSnapshot && projectId) {
        const currentRoutingSnapshot = await collectLearnRoutingSnapshot(page, projectId).catch(() => null);
        if (didLearnRoutingSnapshotChange(baselineRoutingSnapshot, currentRoutingSnapshot)) {
          workspaceMutated = true;
          workspaceMutatedObserved = true;
          workspaceMutationSignal = describeLearnRoutingSnapshotChange(
            baselineRoutingSnapshot,
            currentRoutingSnapshot,
          );
          lastActivityAt = Date.now();
          lastWorkspaceMutationAt = lastActivityAt;
        }
      }

      if (conversationControllerId) {
        const messages = await fetchConversationMessages(page, conversationControllerId).catch(() => []);
        const newMessageIds = messages
          .map((message) => (typeof message?.id === "string" ? message.id : null))
          .filter((value): value is string => typeof value === "string" && value.length > 0 && !baselineMessageIds.has(value));
        const latestNewMessageId = newMessageIds.at(-1) ?? "";
        const messageSignature = `${newMessageIds.length}:${latestNewMessageId}`;
        if (messageSignature !== lastObservedMessageSignature) {
          lastObservedMessageSignature = messageSignature;
          lastActivityAt = Date.now();
        }
        const learnUserReply = findLearnAssistantReply(messages, command, baselineMessageIds);
        if (learnUserReply) {
          sawLearnUserMessage = true;
        } else {
          const normalizedCommand = command.trim();
          const normalizedPrefix = normalizedCommand.split(/\s+/, 1)[0]?.trim().toLowerCase() ?? "";
          sawLearnUserMessage = messages.some((message) => {
            const id = typeof message?.id === "string" ? message.id : null;
            if (id && baselineMessageIds.has(id)) return false;
            const role = (message?.role ?? "").toLowerCase();
            if (role !== "user") return false;
            const content = typeof message?.content === "string" ? message.content.trim() : "";
            const normalizedContent = content.toLowerCase();
            return (
              content === normalizedCommand ||
              (normalizedPrefix.length > 0 && normalizedContent.startsWith(normalizedPrefix)) ||
              (normalizedPrefix === "/learn" && normalizedContent.includes("/learn"))
            );
          });
        }
        const assistantReply = findLearnAssistantReply(messages, command, baselineMessageIds);
        if (assistantReply) {
          candidateSignal = assistantReply.signal;
          candidateAssistantSummary = assistantReply.assistantSummary;
        }

        const runs = await fetchConversationRuns(page, conversationControllerId).catch(() => []);
        const newRuns = runs.filter((run) => {
          const id = typeof run?.id === "string" ? run.id : null;
          return !!id && !baselineRunIds.has(id);
        });
        const runSignature = newRuns
          .map((run) => `${typeof run?.id === "string" ? run.id : "?"}:${typeof run?.status === "string" ? run.status.trim() : ""}`)
          .join("|");
        if (runSignature !== lastObservedRunSignature) {
          lastObservedRunSignature = runSignature;
          lastActivityAt = Date.now();
        }
        if (newRuns.length > 0) {
          sawNewRun = true;
          const latestNewRun = newRuns[0];
          latestNewRunStatus =
            typeof latestNewRun?.status === "string" && latestNewRun.status.trim().length > 0
              ? latestNewRun.status.trim()
              : latestNewRunStatus;
          hasActiveNewRun = newRuns.some((run) => !isTerminalRunStatus(run?.status ?? null));
        }

        if (sawLearnUserMessage && !hasActiveNewRun && Date.now() - lastActivityAt >= quiescenceMs) {
          signal = candidateSignal ?? `learn-run-${(latestNewRunStatus ?? "completed").toLowerCase()}`;
          assistantSummary = candidateAssistantSummary;
          break;
        }
      }

      const currentPreviewCount = await learnPreviews.count().catch(() => baselineLearnCount);
      if (!sawNewRun && currentPreviewCount > baselineLearnCount) {
        sawPreview = true;
        const preview = learnPreviews.nth(baselineLearnCount);
        if (await preview.isVisible().catch(() => false)) {
          const expandButton = preview.getByLabel(/expand thread/i);
          if (await expandButton.isVisible().catch(() => false)) {
            await expandButton.click().catch(() => {});
          }
          const spinner = preview.getByLabel(/thread is running/i);
          if ((await spinner.count().catch(() => 0)) === 0 || !(await spinner.isVisible().catch(() => false))) {
            const threadAssistantBubbles = preview.locator('[data-testid="chat-bubble-assistant"]');
            if ((await threadAssistantBubbles.count().catch(() => 0)) > 0) {
              candidateAssistantSummary = (await threadAssistantBubbles.last().innerText().catch(() => "")).trim() || null;
            }
            previewText = (await preview.innerText().catch(() => "")).trim() || null;
            candidateSignal = candidateAssistantSummary ?? previewText;
          }
        }
      }
      const previewSignature = `${currentPreviewCount}:${previewText ?? ""}:${candidateAssistantSummary ?? ""}`;
      if (previewSignature !== lastObservedPreviewSignature) {
        lastObservedPreviewSignature = previewSignature;
        lastActivityAt = Date.now();
      }

      const currentAssistantCount = await mainAssistantBubbles.count().catch(() => baselineAssistantCount);
      if (!sawNewRun && currentAssistantCount > baselineAssistantCount) {
        const bubbleText = (await mainAssistantBubbles.last().innerText().catch(() => "")).trim() || null;
        if (bubbleText) {
          candidateAssistantSummary = bubbleText;
          candidateSignal = bubbleText;
          lastActivityAt = Date.now();
        }
      }

      if ((candidateSignal || sawPreview || sawLearnUserMessage) && !hasActiveNewRun && Date.now() - lastActivityAt >= quiescenceMs) {
        signal = candidateSignal ?? previewText ?? `learn-run-${(latestNewRunStatus ?? "completed").toLowerCase()}`;
        assistantSummary = candidateAssistantSummary;
        break;
      }

      if (
        workspaceMutatedObserved &&
        lastWorkspaceMutationAt !== null &&
        Date.now() - lastWorkspaceMutationAt >= quiescenceMs &&
        Date.now() - lastActivityAt >= quiescenceMs
      ) {
        signal =
          candidateSignal ??
          workspaceMutationSignal ??
          `learn-workspace-mutated${latestNewRunStatus ? `-${latestNewRunStatus.toLowerCase()}` : ""}`;
        assistantSummary = candidateAssistantSummary;
        break;
      }

      if (
        workspaceMutatedObserved &&
        sawLearnUserMessage &&
        hasActiveNewRun &&
        lastWorkspaceMutationAt !== null &&
        Date.now() - lastWorkspaceMutationAt >= activeRunGraceMs &&
        Date.now() - lastActivityAt >= quiescenceMs
      ) {
        signal =
          candidateSignal ??
          workspaceMutationSignal ??
          `learn-workspace-mutated-active-run-${(latestNewRunStatus ?? "in_progress").toLowerCase()}`;
        assistantSummary = candidateAssistantSummary;
        break;
      }

      await page.waitForTimeout(1000);
    }

    if (!signal && !sawNewRun && sawPreview) {
      signal = candidateSignal ?? previewText ?? "learn-thread-complete";
      assistantSummary = candidateAssistantSummary;
    }
    if (!signal && !error) {
      const runSuffix = latestNewRunStatus ? ` last run status=${latestNewRunStatus}` : "";
      const mutationSuffix =
        requireWorkspaceMutation && !workspaceMutated ? " workspace mutation not observed" : "";
      error = `timed out waiting for /learn completion after ${Math.round(timeoutMs / 1000)}s${runSuffix}${mutationSuffix}`;
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return {
    signal,
    error,
    wallMs: Date.now() - startedAtMs,
    assistantSummary,
    workspaceMutatedObserved,
  };
}

function didLearnRoutingSnapshotChange(
  before: LearnRoutingSnapshot | null,
  after: LearnRoutingSnapshot | null,
): boolean {
  return describeLearnRoutingSnapshotChange(before, after) !== null;
}

function describeLearnRoutingSnapshotChange(
  before: LearnRoutingSnapshot | null,
  after: LearnRoutingSnapshot | null,
): string | null {
  if (!before || !after) return null;
  if (before.instafyMdBytes !== after.instafyMdBytes || before.instafyMdHash !== after.instafyMdHash) {
    return "instafy-md-updated";
  }
  if (before.agentsMdBytes !== after.agentsMdBytes || before.agentsMdHash !== after.agentsMdHash) {
    return "agents-md-updated";
  }
  if (
    before.learnedIndexBytes !== after.learnedIndexBytes ||
    before.learnedIndexHash !== after.learnedIndexHash
  ) {
    return "learned-index-updated";
  }
  if (
    before.learnedUsageBytes !== after.learnedUsageBytes ||
    before.learnedUsageHash !== after.learnedUsageHash
  ) {
    return "learned-usage-updated";
  }
  if (
    before.learnedBlockCount !== after.learnedBlockCount ||
    before.learnedBlockTotalBytes !== after.learnedBlockTotalBytes
  ) {
    return "learned-block-set-updated";
  }

  const beforeBlocks = serializeLearnedBlocks(before);
  const afterBlocks = serializeLearnedBlocks(after);
  if (beforeBlocks !== afterBlocks) {
    return "learned-block-content-updated";
  }
  return null;
}

function serializeLearnedBlocks(snapshot: LearnRoutingSnapshot): string {
  return snapshot.learnedBlocks
    .map(
      (block) =>
        `${block.skillPath}:${block.skillBytes ?? "-"}:${block.skillHash ?? "-"}:${block.detailsBytes ?? "-"}:${block.detailsHash ?? "-"}`,
    )
    .sort()
    .join("|");
}
