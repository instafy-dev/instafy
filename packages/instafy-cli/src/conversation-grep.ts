import {
  messageContextPath,
  messageSearchPath,
  type ControllerMessageContextPage,
  type ControllerMessageSearchPage,
} from "@instafy/sdk/conversation-search";
import { customerControllerJsonRequest, type CustomerControllerAuthOptions } from "./customer-controller.js";
import { findProjectManifest } from "./project-manifest.js";

export type ConversationGrepOptions = CustomerControllerAuthOptions & {
  query: string;
  space?: string;
  org?: string;
  personal?: boolean;
  all?: boolean;
  limit?: number;
  cursor?: string;
  json?: boolean;
};

export type ConversationContextOptions = CustomerControllerAuthOptions & {
  conversationId: string;
  messageId: string;
  before?: number;
  after?: number;
  json?: boolean;
};

interface ContextMessage {
  id: string;
  conversationId: string;
  projectId: string;
  role: string;
  content: string;
  createdAt: string;
}

function uuid(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(normalized)) {
    throw new Error(`${label} must be a UUID.`);
  }
  return normalized.toLowerCase();
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number, label: string): number {
  const count = value ?? fallback;
  if (!Number.isInteger(count) || count < min || count > max) throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  return count;
}

function scopeFor(options: ConversationGrepOptions): { projectId?: string; orgId?: string; personal?: boolean } {
  if ([Boolean(options.space), Boolean(options.org), Boolean(options.personal), Boolean(options.all)].filter(Boolean).length > 1) {
    throw new Error("Choose only one of --space, --org, --personal or --all.");
  }
  if (options.all) return {};
  if (options.personal) return { personal: true };
  if (options.org) return { orgId: uuid(options.org, "--org") };
  const project = options.space?.trim() || ["SPACE_ID", "INSTAFY_SPACE_ID", "PROJECT_ID", "INSTAFY_PROJECT_ID"]
    .map((key) => process.env[key]?.trim()).find(Boolean) || findProjectManifest(process.cwd()).manifest?.spaceId;
  if (!project) throw new Error("No space configured. Pass --space, --org, --personal or --all, or run `instafy space init`.");
  return { projectId: uuid(project, "Space id") };
}

/** Message text is untrusted terminal output: escape controls rather than executing ANSI sequences. */
function terminalText(value: string, singleLine = false): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => {
    if (!singleLine && (character === "\n" || character === "\t")) return character;
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    if (character === "\t") return "\\t";
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

function validCursor(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0);
}

export async function grepConversationMessages(options: ConversationGrepOptions): Promise<boolean> {
  const query = options.query.trim();
  if (Array.from(query).length < 2 || Array.from(query).length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(query)) {
    throw new Error("Search text must contain 2 to 200 characters without control characters.");
  }
  const limit = boundedInteger(options.limit, 30, 1, 50, "--limit");
  const scope = scopeFor(options);
  const page = await customerControllerJsonRequest<ControllerMessageSearchPage>({
    ...options,
    method: "GET",
    apiPath: messageSearchPath({ query, ...scope, cursor: options.cursor, limit }),
    operation: "Conversation message search",
    notFoundMessage: "Message search is unavailable at this controller (404). It requires a controller with /search/messages support.",
  });
  if (!page || !Array.isArray(page.matches) || page.matches.length > limit || typeof page.hasMore !== "boolean"
    || !validCursor(page.nextCursor) || (page.hasMore && !page.nextCursor)) throw new Error("Invalid conversation message search response.");
  for (const match of page.matches) {
    if (!match || typeof match.messageId !== "string" || typeof match.conversationId !== "string"
      || typeof match.projectId !== "string" || typeof match.snippet !== "string" || typeof match.role !== "string"
      || typeof match.createdAt !== "string" || !Array.isArray(match.matchRanges)
      || match.matchRanges.some((range) => !range || !Number.isInteger(range.start) || !Number.isInteger(range.end)
        || range.start < 0 || range.end <= range.start || range.end > match.snippet.length)
      || (scope.projectId && match.projectId !== scope.projectId)
      || (scope.orgId && match.orgId !== scope.orgId) || (scope.personal && match.orgId !== null)) {
      throw new Error("Invalid conversation message search result or scope.");
    }
  }
  if (options.json) {
    console.log(JSON.stringify(page, null, 2));
  } else {
    for (const match of page.matches) {
      console.log(terminalText(`${match.projectId}:${match.conversationId}:${match.messageId}:${match.role}:${match.createdAt}: ${match.snippet}`, true));
    }
    if (page.hasMore) console.error(`More matches are available. Repeat the query and scope with --cursor ${terminalText(page.nextCursor!, true)}.`);
  }
  return page.matches.length > 0;
}

export async function showConversationContext(options: ConversationContextOptions): Promise<void> {
  const conversationId = uuid(options.conversationId, "Conversation id");
  const messageId = uuid(options.messageId, "Message id");
  const before = boundedInteger(options.before, 20, 0, 50, "--before");
  const after = boundedInteger(options.after, 20, 0, 50, "--after");
  const page = await customerControllerJsonRequest<ControllerMessageContextPage<ContextMessage>>({
    ...options,
    method: "GET",
    apiPath: messageContextPath({ conversationId, messageId, before, after }),
    operation: "Conversation message context",
  });
  if (!page || page.anchorMessageId !== messageId || !Array.isArray(page.messages)
    || page.messages.length < 1 || page.messages.length > before + after + 1
    || !page.messages.some((message) => message?.id === messageId)
    || typeof page.hasOlder !== "boolean" || typeof page.hasNewer !== "boolean"
    || !validCursor(page.olderCursor) || !validCursor(page.newerCursor)
    || (page.hasOlder && !page.olderCursor) || (page.hasNewer && !page.newerCursor)
    || page.messages.some((message) => !message || message.conversationId !== conversationId || typeof message.id !== "string"
      || typeof message.content !== "string" || typeof message.role !== "string" || typeof message.createdAt !== "string")) {
    throw new Error("Invalid conversation message context response.");
  }
  if (options.json) {
    console.log(JSON.stringify(page, null, 2));
    return;
  }
  // Human-readable context reads chronologically; JSON preserves canonical newest-first order.
  for (const message of [...page.messages].reverse()) {
    console.log(terminalText(`${message.id === messageId ? "> " : "  "}${message.id} ${message.role} ${message.createdAt}`, true));
    console.log(terminalText(message.content));
    console.log("");
  }
  if (page.hasOlder) console.error(`Older context: instafy conversation context ${conversationId} ${terminalText(page.olderCursor!, true)} --before 40 --after 0`);
  if (page.hasNewer) console.error(`Newer context: instafy conversation context ${conversationId} ${terminalText(page.newerCursor!, true)} --before 0 --after 40`);
}
