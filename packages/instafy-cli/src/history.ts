import { requestControllerApi } from "./api.js";
import { findProjectManifest } from "./project-manifest.js";

type HistoryCommonOptions = {
  controllerUrl?: string;
  accessToken?: string;
  serviceToken?: string;
  pretty?: boolean;
};

export type HistoryMessagesOptions = HistoryCommonOptions & {
  conversation?: string;
  limit?: number;
  cursor?: string;
};

export type HistoryRunsOptions = HistoryCommonOptions & {
  conversation?: string;
  limit?: number;
};

export type HistoryConversationsOptions = HistoryCommonOptions & {
  project?: string;
  limit?: number;
};

const DEFAULT_LIMIT = 50;

function clampLimit(limit: number | undefined, min: number, max: number): number {
  if (!Number.isFinite(limit as number)) {
    return DEFAULT_LIMIT;
  }
  const normalized = Math.trunc(limit as number);
  if (normalized < min) return min;
  if (normalized > max) return max;
  return normalized;
}

function resolveConversationId(rawConversation: string | undefined): string {
  const explicit = rawConversation?.trim();
  if (explicit) {
    return explicit;
  }

  const fromEnv = process.env["INSTAFY_CONVERSATION_ID"]?.trim() || process.env["CONVERSATION_ID"]?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  throw new Error(
    "No conversation configured. Pass --conversation or set INSTAFY_CONVERSATION_ID.",
  );
}

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

function asPretty(value: boolean | undefined): boolean {
  return value !== false;
}

export async function historyMessages(options: HistoryMessagesOptions): Promise<void> {
  const conversationId = resolveConversationId(options.conversation);
  const limit = clampLimit(options.limit, 1, 200);
  const query: string[] = [`limit=${limit}`];
  if (options.cursor?.trim()) {
    query.push(`cursor=${encodeURIComponent(options.cursor.trim())}`);
  }

  await requestControllerApi({
    method: "GET",
    path: `/conversations/${conversationId}/messages`,
    query,
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
    pretty: asPretty(options.pretty),
  });
}

export async function historyRuns(options: HistoryRunsOptions): Promise<void> {
  const conversationId = resolveConversationId(options.conversation);
  const limit = clampLimit(options.limit, 1, 200);

  await requestControllerApi({
    method: "GET",
    path: `/conversations/${conversationId}/runs`,
    query: [`limit=${limit}`],
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
    pretty: asPretty(options.pretty),
  });
}

export async function historyConversations(options: HistoryConversationsOptions): Promise<void> {
  const projectId = resolveProjectId(options.project);
  const limit = clampLimit(options.limit, 1, 200);

  await requestControllerApi({
    method: "GET",
    path: `/projects/${projectId}/conversations`,
    query: [`limit=${limit}`],
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
    pretty: asPretty(options.pretty),
  });
}
