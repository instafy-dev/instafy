import kleur from "kleur";
import { findProjectManifest } from "./project-manifest.js";
import { requestControllerApiJson } from "./api.js";

type ConversationCommonOptions = {
  controllerUrl?: string;
  accessToken?: string;
  serviceToken?: string;
  pretty?: boolean;
};

export type ConversationListOptions = ConversationCommonOptions & {
  project?: string;
  limit?: number;
  includeThreads?: boolean;
  json?: boolean;
};

export type ConversationSearchOptions = ConversationListOptions & {
  query: string;
};

export type ConversationShowOptions = ConversationCommonOptions & {
  project?: string;
  target: string;
  limit?: number;
  includeThreads?: boolean;
  json?: boolean;
};

export type ConversationCreateOptions = ConversationCommonOptions & {
  project?: string;
  title?: string;
  parent?: string;
  threadKind?: string;
  json?: boolean;
};

type ControllerConversationCreateResponse = {
  conversationId?: string;
  conversation_id?: string;
};

type ControllerProjectConversation = {
  id: string;
  metadata?: Record<string, unknown> | null;
  parentConversationId?: string | null;
  parent_conversation_id?: string | null;
  rootConversationId?: string | null;
  root_conversation_id?: string | null;
  threadKind?: string | null;
  thread_kind?: string | null;
  lastMessagePreview?: string | null;
  last_message_preview?: string | null;
  lastMessageAt?: string | null;
  last_message_at?: string | null;
  updatedAt?: string | null;
  updated_at?: string | null;
  createdAt?: string | null;
  created_at?: string | null;
};

type ControllerConversationMessage = {
  id: string;
  role: string;
  content: string;
  createdAt?: string | null;
  created_at?: string | null;
  metadata?: Record<string, unknown> | null;
};

type ControllerConversationMessagesPage = {
  messages?: ControllerConversationMessage[];
};

type SearchMatch = {
  id: string;
  title: string;
  preview: string | null;
  updatedAt: string | null;
  createdAt: string | null;
  threadKind: string | null;
  score: number;
  matchedIn: string[];
};

const DEFAULT_CONVERSATION_LIMIT = 50;
const DEFAULT_MESSAGE_LIMIT = 80;
const MAX_LIMIT = 200;

function clampLimit(limit: number | undefined, fallback: number): number {
  if (!Number.isFinite(limit as number)) {
    return fallback;
  }
  const normalized = Math.trunc(limit as number);
  if (normalized < 1) return 1;
  if (normalized > MAX_LIMIT) return MAX_LIMIT;
  return normalized;
}

function trimOrNull(value: string | undefined | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeSearchText(value: string | undefined | null): string {
  return (value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizePreview(value: string | undefined | null): string | null {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function searchTokens(query: string): string[] {
  return normalizeSearchText(query)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value.trim(),
  );
}

function resolveProjectId(rawProject: string | undefined): string {
  const explicit = trimOrNull(rawProject);
  if (explicit) {
    return explicit;
  }

  const fromEnv =
    trimOrNull(process.env["SPACE_ID"]) ??
    trimOrNull(process.env["INSTAFY_SPACE_ID"]) ??
    trimOrNull(process.env["PROJECT_ID"]) ??
    trimOrNull(process.env["INSTAFY_PROJECT_ID"]);
  if (fromEnv) {
    return fromEnv;
  }

  const manifest = findProjectManifest(process.cwd()).manifest;
  const fromManifest = trimOrNull(manifest?.spaceId);
  if (fromManifest) {
    return fromManifest;
  }

  throw new Error(
    "No space configured. Pass --space, set SPACE_ID, or run `instafy space init`.",
  );
}

function extractConversationTitle(metadata: Record<string, unknown> | null | undefined, id: string): string {
  const raw = typeof metadata?.title === "string" ? metadata.title : null;
  const trimmed = raw?.trim() ?? "";
  if (trimmed.length > 0) {
    return trimmed;
  }
  return `Conversation ${id.slice(0, 8)}`;
}

function conversationPreview(conversation: ControllerProjectConversation): string | null {
  return normalizePreview(
    trimOrNull(conversation.lastMessagePreview) ??
      trimOrNull(conversation.last_message_preview),
  );
}

function conversationUpdatedAt(conversation: ControllerProjectConversation): string | null {
  return (
    trimOrNull(conversation.updatedAt) ??
    trimOrNull(conversation.updated_at) ??
    trimOrNull(conversation.lastMessageAt) ??
    trimOrNull(conversation.last_message_at) ??
    trimOrNull(conversation.createdAt) ??
    trimOrNull(conversation.created_at)
  );
}

function conversationCreatedAt(conversation: ControllerProjectConversation): string | null {
  return trimOrNull(conversation.createdAt) ?? trimOrNull(conversation.created_at);
}

function conversationThreadKind(conversation: ControllerProjectConversation): string | null {
  return trimOrNull(conversation.threadKind) ?? trimOrNull(conversation.thread_kind);
}

function normalizeCreateTitle(raw: string | undefined): string | null {
  const title = trimOrNull(raw);
  if (!title) {
    return null;
  }
  return title.replace(/\s+/g, " ");
}

function summarizeContent(content: string, maxLength = 160): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

async function fetchProjectConversations(
  options: ConversationCommonOptions & {
    project: string;
    limit: number;
    rootsOnly: boolean;
  },
): Promise<ControllerProjectConversation[]> {
  const query = [`limit=${options.limit}`];
  if (options.rootsOnly) {
    query.push("rootsOnly=true");
  }
  const response = await requestControllerApiJson<ControllerProjectConversation[]>({
    method: "GET",
    path: `/projects/${options.project}/conversations`,
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
    query,
  });
  return Array.isArray(response) ? response : [];
}

async function fetchConversationMessages(
  options: ConversationCommonOptions & {
    conversationId: string;
    limit: number;
  },
): Promise<ControllerConversationMessage[]> {
  const response = await requestControllerApiJson<ControllerConversationMessagesPage>({
    method: "GET",
    path: `/conversations/${options.conversationId}/messages`,
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
    query: [`limit=${options.limit}`],
  });
  return Array.isArray(response.messages) ? response.messages : [];
}

function scoreConversationText(
  normalizedValue: string,
  normalizedQuery: string,
  tokens: string[],
  weight: {
    exact: number;
    contains: number;
    perToken: number;
  },
): number {
  if (!normalizedValue) {
    return 0;
  }
  let score = 0;
  if (normalizedValue === normalizedQuery) {
    score += weight.exact;
  } else if (normalizedQuery && normalizedValue.includes(normalizedQuery)) {
    score += weight.contains;
  }
  for (const token of tokens) {
    if (normalizedValue.includes(token)) {
      score += weight.perToken;
    }
  }
  return score;
}

function dedupeMatchedIn(values: string[]): string[] {
  return [...new Set(values)];
}

async function buildSearchMatches(
  conversations: ControllerProjectConversation[],
  options: ConversationSearchOptions,
): Promise<SearchMatch[]> {
  const normalizedQuery = normalizeSearchText(options.query);
  const tokens = searchTokens(options.query);
  if (!normalizedQuery) {
    throw new Error("Search query cannot be empty.");
  }

  const baseMatches = conversations.map((conversation, index) => {
    const title = extractConversationTitle(conversation.metadata ?? null, conversation.id);
    const preview = conversationPreview(conversation);
    const matchedIn: string[] = [];
    let score = Math.max(0, 20 - index);

    const titleScore = scoreConversationText(normalizeSearchText(title), normalizedQuery, tokens, {
      exact: 800,
      contains: 450,
      perToken: 120,
    });
    if (titleScore > 0) {
      matchedIn.push("title");
      score += titleScore;
    }

    const previewScore = scoreConversationText(normalizeSearchText(preview), normalizedQuery, tokens, {
      exact: 240,
      contains: 160,
      perToken: 45,
    });
    if (previewScore > 0) {
      matchedIn.push("preview");
      score += previewScore;
    }

    return {
      conversation,
      title,
      preview,
      updatedAt: conversationUpdatedAt(conversation),
      createdAt: conversationCreatedAt(conversation),
      threadKind: conversationThreadKind(conversation),
      score,
      matchedIn: dedupeMatchedIn(matchedIn),
    };
  });

  const shouldInspectMessages =
    baseMatches.filter((match) => match.score >= 160).length === 0;
  if (shouldInspectMessages) {
    const conversationsToInspect = baseMatches.slice(0, Math.min(12, baseMatches.length));
    const messagePages = await Promise.all(
      conversationsToInspect.map((match) =>
        fetchConversationMessages({
          conversationId: match.conversation.id,
          controllerUrl: options.controllerUrl,
          accessToken: options.accessToken,
          serviceToken: options.serviceToken,
          limit: DEFAULT_MESSAGE_LIMIT,
        }).catch(() => []),
      ),
    );

    for (const [index, messages] of messagePages.entries()) {
      const combined = normalizeSearchText(
        messages
          .map((message) => (typeof message.content === "string" ? message.content : ""))
          .join("\n"),
      );
      if (!combined) {
        continue;
      }
      const score = scoreConversationText(combined, normalizedQuery, tokens, {
        exact: 100,
        contains: 80,
        perToken: 20,
      });
      if (score <= 0) {
        continue;
      }
      conversationsToInspect[index]!.score += score;
      conversationsToInspect[index]!.matchedIn = dedupeMatchedIn([
        ...conversationsToInspect[index]!.matchedIn,
        "messages",
      ]);
    }
  }

  return baseMatches
    .filter((match) => match.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
    })
    .map((match) => ({
      id: match.conversation.id,
      title: match.title,
      preview: match.preview,
      updatedAt: match.updatedAt,
      createdAt: match.createdAt,
      threadKind: match.threadKind,
      score: match.score,
      matchedIn: match.matchedIn,
    }));
}

function formatConversationMatch(match: SearchMatch): string {
  const lines = [`- ${kleur.green(match.title)} (${match.id})`];
  const details: string[] = [];
  if (match.matchedIn.length > 0) {
    details.push(`match: ${match.matchedIn.join(", ")}`);
  }
  if (match.updatedAt) {
    details.push(`updated: ${match.updatedAt}`);
  }
  if (details.length > 0) {
    lines.push(`  ${details.join(" · ")}`);
  }
  if (match.preview) {
    lines.push(`  ${kleur.gray(summarizeContent(match.preview))}`);
  }
  return lines.join("\n");
}

function selectConversationForShow(target: string, matches: SearchMatch[]): SearchMatch {
  const normalizedTarget = normalizeSearchText(target);
  const exactMatches = matches.filter(
    (match) => normalizeSearchText(match.title) === normalizedTarget,
  );
  if (exactMatches.length === 1) {
    return exactMatches[0]!;
  }
  if (matches.length === 1) {
    return matches[0]!;
  }
  if (matches.length > 1 && matches[0]!.score >= matches[1]!.score + 200) {
    return matches[0]!;
  }

  const suggestions = matches
    .slice(0, 5)
    .map((match) => `- ${match.title} (${match.id})`)
    .join("\n");
  throw new Error(
    `Multiple conversations match "${target}". Search first or pick one of:\n${suggestions}`,
  );
}

export async function createConversation(options: ConversationCreateOptions): Promise<void> {
  const projectId = resolveProjectId(options.project);
  const title = normalizeCreateTitle(options.title);
  const parentConversationId = trimOrNull(options.parent);
  const threadKind = trimOrNull(options.threadKind);

  if (threadKind && !parentConversationId) {
    throw new Error("--thread-kind requires --parent because only child threads have a thread kind.");
  }

  const response = await requestControllerApiJson<ControllerConversationCreateResponse>({
    method: "POST",
    path: `/projects/${projectId}/conversations/blank`,
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
    jsonBody: {
      metadata: title ? { title } : {},
      parentConversationId,
      threadKind,
    },
  });
  const conversationId = trimOrNull(response.conversationId) ?? trimOrNull(response.conversation_id);
  if (!conversationId) {
    throw new Error("Conversation creation response missing conversationId.");
  }

  const payload = {
    conversationId,
    projectId,
    parentConversationId,
    threadKind,
    title,
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(kleur.green("Created conversation"));
  console.log(`${kleur.gray("ID:")} ${conversationId}`);
  if (title) {
    console.log(`${kleur.gray("Title:")} ${title}`);
  }
  if (parentConversationId) {
    console.log(`${kleur.gray("Parent:")} ${parentConversationId}`);
  }
  if (threadKind) {
    console.log(`${kleur.gray("Thread kind:")} ${threadKind}`);
  }
}

export async function listConversations(options: ConversationListOptions): Promise<void> {
  const projectId = resolveProjectId(options.project);
  const limit = clampLimit(options.limit, DEFAULT_CONVERSATION_LIMIT);
  const conversations = await fetchProjectConversations({
    project: projectId,
    limit,
    rootsOnly: !options.includeThreads,
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
  });

  const items = conversations.map((conversation) => ({
    id: conversation.id,
    title: extractConversationTitle(conversation.metadata ?? null, conversation.id),
    preview: conversationPreview(conversation),
    updatedAt: conversationUpdatedAt(conversation),
    createdAt: conversationCreatedAt(conversation),
    threadKind: conversationThreadKind(conversation),
  }));

  if (options.json) {
    console.log(JSON.stringify({ conversations: items }, null, 2));
    return;
  }

  if (items.length === 0) {
    console.log(kleur.yellow("No conversations found for this space."));
    return;
  }

  console.log(kleur.green(`Conversations (${items.length})`));
  for (const item of items) {
    console.log(formatConversationMatch({ ...item, score: 0, matchedIn: [] }));
  }
}

export async function searchConversations(options: ConversationSearchOptions): Promise<SearchMatch[]> {
  const projectId = resolveProjectId(options.project);
  const limit = clampLimit(options.limit, DEFAULT_CONVERSATION_LIMIT);
  const conversations = await fetchProjectConversations({
    project: projectId,
    limit,
    rootsOnly: !options.includeThreads,
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
  });
  const matches = await buildSearchMatches(conversations, options);

  if (options.json) {
    console.log(JSON.stringify({ query: options.query, matches }, null, 2));
    return matches;
  }

  if (matches.length === 0) {
    console.log(kleur.yellow(`No conversations matched "${options.query}".`));
    return matches;
  }

  console.log(kleur.green(`Matches for "${options.query}"`));
  for (const match of matches.slice(0, Math.min(limit, matches.length))) {
    console.log(formatConversationMatch(match));
  }
  return matches;
}

export async function showConversation(options: ConversationShowOptions): Promise<void> {
  const projectId = resolveProjectId(options.project);
  const target = trimOrNull(options.target);
  if (!target) {
    throw new Error("Conversation target cannot be empty.");
  }

  const limit = clampLimit(options.limit, DEFAULT_MESSAGE_LIMIT);
  const conversations = await fetchProjectConversations({
    project: projectId,
    limit: MAX_LIMIT,
    rootsOnly: !options.includeThreads,
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
  });

  let selected: SearchMatch | null = null;
  if (isUuid(target)) {
    const conversation = conversations.find((entry) => entry.id === target) ?? null;
    if (conversation) {
      selected = {
        id: conversation.id,
        title: extractConversationTitle(conversation.metadata ?? null, conversation.id),
        preview: conversationPreview(conversation),
        updatedAt: conversationUpdatedAt(conversation),
        createdAt: conversationCreatedAt(conversation),
        threadKind: conversationThreadKind(conversation),
        score: 0,
        matchedIn: ["id"],
      };
    } else {
      selected = {
        id: target,
        title: `Conversation ${target.slice(0, 8)}`,
        preview: null,
        updatedAt: null,
        createdAt: null,
        threadKind: null,
        score: 0,
        matchedIn: ["id"],
      };
    }
  } else {
    const matches = await buildSearchMatches(conversations, {
      query: target,
      project: projectId,
      limit: MAX_LIMIT,
      includeThreads: options.includeThreads,
      controllerUrl: options.controllerUrl,
      accessToken: options.accessToken,
      serviceToken: options.serviceToken,
      pretty: options.pretty,
      json: false,
    });
    if (matches.length === 0) {
      throw new Error(`No conversations matched "${target}".`);
    }
    selected = selectConversationForShow(target, matches);
  }

  const messages = await fetchConversationMessages({
    conversationId: selected.id,
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
    limit,
  });

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          conversation: selected,
          messages,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(kleur.green(selected.title));
  console.log(`${kleur.gray("ID:")} ${selected.id}`);
  if (selected.updatedAt) {
    console.log(`${kleur.gray("Updated:")} ${selected.updatedAt}`);
  }
  if (selected.preview) {
    console.log(`${kleur.gray("Preview:")} ${summarizeContent(selected.preview, 240)}`);
  }
  console.log("");
  if (messages.length === 0) {
    console.log(kleur.yellow("No messages found in this conversation."));
    return;
  }

  for (const message of messages.slice().reverse()) {
    const role = (message.role ?? "unknown").trim().toLowerCase();
    const createdAt = trimOrNull(message.createdAt) ?? trimOrNull(message.created_at);
    const header = createdAt
      ? `${role} · ${createdAt}`
      : role;
    console.log(kleur.cyan(`[${header}]`));
    console.log(summarizeContent(message.content ?? "", 4_000));
    console.log("");
  }
}
