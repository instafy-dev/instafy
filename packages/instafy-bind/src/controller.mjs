// Minimal controller API client: the calls `instafy chat --wait --json` makes (packages/instafy-cli/src/chat.ts),
// reimplemented without dependencies, plus creating the site's own thread and cancelling a job.
// Shapes follow packages/runtime-controller: messages come back newest first with createdAt; a finished run's
// status is "success" (or failed, canceled, merged, expired); dispatch answers {status, runId?, jobId?, conversationId}.

const TERMINAL = ["success", "succeeded", "completed", "complete", "merged", "ready", "failed", "error", "errored", "cancelled", "canceled", "expired"];
const SUCCESS = ["success", "succeeded", "completed", "complete", "merged", "ready"];
const NON_REPLY_TYPES = [
  "token_usage", "command_execution", "mcp_tool_call", "plan_update", "learn_router",
  "integration_request", "status", "activity", "thread_update",
];

const lower = (status) => String(status ?? "").trim().toLowerCase();
export const isTerminalStatus = (status) => TERMINAL.includes(lower(status));
export const isSuccessfulStatus = (status) => SUCCESS.includes(lower(status));
export const isWaitingForApproval = (status) => lower(status) === "awaiting_approval";

export function messageRunId(message) {
  const raw = message?.runId ?? message?.run_id ?? null;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

export function messageType(message) {
  const metadata = message?.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const direct = metadata.messageType ?? metadata.message_type;
  return typeof direct === "string" && direct.trim() ? direct.trim().toLowerCase() : null;
}

/** Raw `{...}` or a single ```json fenced object. */
export function looksLikeJsonObjectReply(content) {
  const trimmed = String(content ?? "").trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return true;
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) {
    const inner = fence[1].trim();
    return inner.startsWith("{") && inner.endsWith("}");
  }
  return false;
}

/** An assistant message that can be the run's reply (status messages only when they hold a JSON object). */
export function isReplyCandidate(message, runId) {
  if (String(message?.role ?? "").toLowerCase() !== "assistant") return false;
  if (runId && messageRunId(message) !== runId) return false;
  if (typeof message.content !== "string" || !message.content.trim()) return false;
  const type = messageType(message);
  if (type === "status") return looksLikeJsonObjectReply(message.content);
  return !(type && NON_REPLY_TYPES.includes(type));
}

const createdAt = (message) => Date.parse(message?.createdAt ?? message?.created_at ?? "");

/** Messages sorted newest first by createdAt. Messages without a time keep the server's order after timed ones. */
export function newestFirst(messages) {
  return messages
    .map((message, index) => ({ message, index, at: createdAt(message) }))
    .sort((a, b) => {
      const at = Number.isFinite(a.at), bt = Number.isFinite(b.at);
      if (at && bt && a.at !== b.at) return b.at - a.at;
      if (at !== bt) return at ? -1 : 1;
      return a.index - b.index;
    })
    .map((entry) => entry.message);
}

/**
 * The run's reply: among its reply candidates, newest first, the first one `accept` takes (by default a bare
 * JSON object), else the newest candidate. Skips ids in `exclude`.
 */
export function findLatestReply(messages, runId, { exclude = new Set(), accept = (m) => looksLikeJsonObjectReply(m.content) } = {}) {
  let newest = null;
  for (const message of newestFirst(messages)) {
    if (!message || exclude.has(message.id) || !isReplyCandidate(message, runId)) continue;
    if (accept(message)) return message;
    newest ??= message;
  }
  return newest;
}

export class ControllerError extends Error {
  constructor(message, { status = 0, code = "upstream", viewerMessage = "Octo is unavailable right now" } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    /** What viewers see; the detail above stays in the binder log. */
    this.viewerMessage = viewerMessage;
  }
}

/** One signal that aborts when either does (AbortSignal.any is Node 20+). */
function anySignal(signals) {
  const controller = new AbortController();
  for (const signal of signals.filter(Boolean)) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/** metadata.purpose of the conversation a binder creates for a site's Octo turns. */
export const BIND_THREAD_PURPOSE = "bound-site-agent-thread";

export class ControllerClient {
  /**
   * @param {{controllerUrl: string, token: string, refreshToken?: () => Promise<string|null>|string|null, fetchImpl?: typeof fetch, timeoutMs?: number}} options
   * refreshToken is asked once after a 401 (the CLI may have refreshed its saved login meanwhile).
   */
  constructor({ controllerUrl, token, refreshToken = null, fetchImpl = globalThis.fetch, timeoutMs = 60_000 }) {
    this.base = new URL(`${controllerUrl.replace(/\/$/, "")}/`);
    Object.defineProperty(this, "token", { value: token, enumerable: false, writable: true });
    this.refreshToken = refreshToken;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(method, path, { query = {}, body, signal = null, timeoutMs = this.timeoutMs, retried = false } = {}) {
    const url = new URL(path.replace(/^\//, ""), this.base);
    if (url.origin !== this.base.origin) throw new ControllerError("refusing a cross-origin controller request", { code: "policy" });
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const headers = { accept: "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: anySignal([AbortSignal.timeout(timeoutMs), signal]),
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new ControllerError(`controller unreachable: ${error.message}`);
    }
    const text = await response.text().catch(() => "");
    if (response.status === 401 && !retried && this.refreshToken) {
      const fresh = await Promise.resolve(this.refreshToken()).catch(() => null);
      if (fresh && fresh !== this.token) {
        this.token = fresh;
        return this.request(method, path, { query, body, signal, timeoutMs, retried: true });
      }
    }
    if (response.status === 401 || response.status === 403) {
      throw new ControllerError(`controller rejected the access token (${response.status}); run \`instafy login\``, {
        status: response.status,
        code: "policy",
        viewerMessage: "Octo is not available: the site owner's Instafy login was rejected",
      });
    }
    if (!response.ok) {
      throw new ControllerError(`controller ${method} ${url.pathname} failed (${response.status}): ${text.slice(0, 200)}`, { status: response.status });
    }
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw new ControllerError(`controller ${method} ${url.pathname} returned non-JSON`);
    }
  }

  /** POST a prompt to a conversation. Returns {conversationId, runId, jobId, promptId, status}. */
  async dispatch({ prompt, conversationId, intent = "feature", metadata = {}, signal = null }) {
    if (!conversationId) throw new ControllerError("no conversation to dispatch to", { code: "policy" });
    const payload = { promptText: prompt, intent, metadata };
    const response = await this.request("POST", `/conversations/${encodeURIComponent(conversationId)}/messages`, { body: payload, signal });
    const pick = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
    return {
      conversationId: pick(response?.conversationId) || conversationId,
      runId: pick(response?.runId),
      jobId: pick(response?.jobId),
      promptId: pick(response?.promptId),
      status: pick(response?.status),
    };
  }

  /**
   * Create the conversation the site's agent turns go to. The controller (runtime-controller conversations.rs,
   * resolve_thread_columns) accepts `threadKind` only together with `parentConversationId`, so:
   * - with a parent: a private child thread `{parentConversationId, threadKind: "bind"}` under the owner's conversation;
   * - without one: a root conversation in the space (no threadKind), marked as the binder's own work thread.
   * When the parent is refused (400/403/404: gone, another space, private, internal), it falls back to a root
   * conversation and reports why through `onFallback`. Returns {conversationId, parentConversationId}.
   *
   * The controller has no client-settable "hidden" or "internal" conversation (conversations.internal_purpose is
   * set by controller code only, and strip_client_internal_metadata drops a client's internalPurpose), so the root
   * conversation is made as hidden as the API allows: `visibility: "private"` keeps it out of every other member's
   * conversation list, and `metadata.source` / `metadata.purpose` mark it as a tool's thread so Studio never binds
   * it to a user's chat tab (frontend conversationAdoption.ts keys on `source`).
   */
  async createThreadRecord({ spaceId, parentConversationId = null, title = null, signal = null, onFallback = null }) {
    if (!spaceId) throw new ControllerError("no space to create the site's thread in", { code: "policy" });
    const metadata = {
      source: "instafy-bind",
      purpose: BIND_THREAD_PURPOSE,
      ...(title ? { title: `Bound site: ${title}`.slice(0, 120) } : {}),
    };
    // Private in both cases: a viewer's click (their search, a rounded position, private_params) is posted here,
    // and only the owner who serves the site should read it, not every member who can see the parent.
    const create = async (parent) => {
      const body = parent
        ? { metadata: { ...metadata, visibility: "private" }, parentConversationId: parent, threadKind: "bind" }
        : { metadata: { ...metadata, visibility: "private" } };
      const response = await this.request("POST", `/projects/${encodeURIComponent(spaceId)}/conversations/blank`, { body, signal });
      const id = typeof response?.conversationId === "string" ? response.conversationId.trim() : "";
      if (!id) throw new ControllerError("conversation creation response missing conversationId");
      return { conversationId: id, parentConversationId: parent };
    };
    const parent = typeof parentConversationId === "string" && parentConversationId.trim() ? parentConversationId.trim() : null;
    if (!parent) return create(null);
    try {
      return await create(parent);
    } catch (error) {
      if (!(error instanceof ControllerError) || ![400, 403, 404].includes(error.status)) throw error;
      onFallback?.(error);
      return create(null);
    }
  }

  /** {@link createThreadRecord}, returning only the new conversation id. */
  async createThread(options) {
    return (await this.createThreadRecord(options)).conversationId;
  }

  /** Ask the controller to stop a dispatched job (best effort). */
  async cancelJob(jobId, reason = "Cancelled from the bound site") {
    return this.request("POST", `/jobs/${encodeURIComponent(jobId)}/cancel`, { body: { reason }, timeoutMs: 10_000 });
  }

  async run(conversationId, runId, { signal = null } = {}) {
    const runs = await this.request("GET", `/conversations/${encodeURIComponent(conversationId)}/runs`, { query: { limit: 20 }, signal });
    return Array.isArray(runs) ? runs.find((run) => run?.id === runId) ?? null : null;
  }

  /** The newest messages of a conversation, newest first. */
  async messages(conversationId, { limit = 50, signal = null } = {}) {
    const page = await this.request("GET", `/conversations/${encodeURIComponent(conversationId)}/messages`, { query: { limit }, signal });
    return newestFirst(Array.isArray(page?.messages) ? page.messages : []);
  }
}
