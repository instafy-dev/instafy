/** Authenticated, server-scoped substring search; no message contents are indexed by clients. */
export interface ControllerMessageSearchParams {
  query: string;
  projectId?: string;
  orgId?: string;
  personal?: boolean;
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
}

export interface ControllerMessageSearchMatch {
  messageId: string;
  conversationId: string;
  projectId: string;
  orgId: string | null;
  projectName: string;
  orgName: string | null;
  conversationTitle: string;
  role: "user" | "assistant";
  createdAt: string;
  /** Plain text, never HTML. */
  snippet: string;
  /** Half-open UTF-16 offsets into snippet, compatible with JavaScript slice(). */
  matchRanges: Array<{ start: number; end: number }>;
}

export interface ControllerMessageSearchPage {
  matches: ControllerMessageSearchMatch[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ControllerMessageContextParams {
  conversationId: string;
  messageId: string;
  before?: number;
  after?: number;
  signal?: AbortSignal;
}

export interface ControllerMessageContextPage<TMessage> {
  anchorMessageId: string;
  /** Existing canonical message payloads, newest first, including the anchor. */
  messages: TMessage[];
  /** Boundary IDs. Use context(messageId=olderCursor,before=40,after=0) for older rows. */
  olderCursor: string | null;
  /** Use context(messageId=newerCursor,before=0,after=40) for newer rows. Deduplicate the anchor. */
  newerCursor: string | null;
  hasOlder: boolean;
  hasNewer: boolean;
}

export function messageSearchPath(params: ControllerMessageSearchParams): string {
  const query = new URLSearchParams({ q: params.query });
  if (params.projectId) query.set("projectId", params.projectId);
  if (params.orgId) query.set("orgId", params.orgId);
  if (params.personal) query.set("personal", "true");
  if (params.cursor) query.set("cursor", params.cursor);
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  return `/search/messages?${query}`;
}

export function messageContextPath(params: ControllerMessageContextParams): string {
  const query = new URLSearchParams({ messageId: params.messageId });
  if (params.before !== undefined) query.set("before", String(params.before));
  if (params.after !== undefined) query.set("after", String(params.after));
  return `/conversations/${encodeURIComponent(params.conversationId)}/messages/context?${query}`;
}
