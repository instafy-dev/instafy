/**
 * Follow mode's relay on the controller (docs/Follow-Mode.md). Every route uses
 * the preview's own gate, so a caller who may not view the preview gets 404.
 * Payloads are opaque JSON the site describes itself; Studio checks their size
 * and shape before they get here (`previewHost/followMode.ts`).
 */
import {
  ControllerApiError,
  emitControllerAuthErrorForRequest,
  resolveControllerRequestContext,
  runtimeControllerEnabled,
} from "./core";
import { ServerSentEventParser } from "./runs";

export type FollowPerson = { id: string; name: string; avatarUrl?: string | null };

/** What the space knows about a preview's presentation (presence only, never a view). */
export type FollowPresence = {
  presentationId: string;
  presenter: FollowPerson;
  state: "live" | "away";
  /** How many follow; `followerList` when the relay named them. */
  followers: number;
  followerList?: FollowPerson[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const readString = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
const readNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;

function followPath(projectId: string, previewId: string, suffix = "") {
  return `/projects/${encodeURIComponent(projectId)}/previews/${encodeURIComponent(previewId)}/follow${suffix}`;
}

/** Names come from the controller (account profiles), never from another client; one line, short. */
export function mapFollowPerson(value: unknown): FollowPerson | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  if (!id) return null;
  const name = (readString(value.name) ?? "Someone").replace(/\s+/g, " ").slice(0, 60);
  return { id, name, avatarUrl: readString(value.avatarUrl) };
}

/** A `presentation` from GET, the stream's `state`, or the `preview.follow` event's data. */
export function mapFollowPresence(value: unknown, followersValue?: unknown): FollowPresence | null {
  if (!isRecord(value)) return null;
  const presentationId = readString(value.presentationId);
  const presenter = mapFollowPerson(value.presenter);
  if (!presentationId || !presenter) return null;
  const rawState = readString(value.state)?.toLowerCase();
  if (rawState === "ended") return null;
  const list = Array.isArray(followersValue) ? followersValue.map(mapFollowPerson).filter((person): person is FollowPerson => Boolean(person)) : null;
  const count = readNumber(followersValue) ?? readNumber(value.followers) ?? list?.length ?? 0;
  return {
    presentationId, presenter,
    state: rawState === "away" ? "away" : "live",
    followers: Math.max(0, Math.round(count)),
    ...(list ? { followerList: list.slice(0, 12) } : {}),
  };
}

const END_REASONS = ["stopped", "replaced", "timeout", "closed", "access"] as const;
export type FollowEndReasonName = (typeof END_REASONS)[number];
const readEndReason = (value: unknown): FollowEndReasonName | null =>
  (END_REASONS as readonly string[]).includes(String(value)) ? value as FollowEndReasonName : null;

/** The `preview.follow` event on /events: which preview, its presence (null once ended) and why it ended. */
export function mapFollowPresenceEvent(data: unknown): {
  previewId: string; presentationId: string | null; presence: FollowPresence | null; reason: FollowEndReasonName | null;
} | null {
  if (!isRecord(data)) return null;
  const previewId = readString(data.previewId);
  if (!previewId) return null;
  const presence = mapFollowPresence(data, data.followers);
  return { previewId, presentationId: readString(data.presentationId), presence, reason: presence ? null : readEndReason(data.reason) };
}

/** The window event the controller sync raises for each `preview.follow` event; detail is the event's data. */
export const PREVIEW_FOLLOW_EVENT = "instafy:preview-follow";

/** The relay said someone else presents now (409). */
export class FollowReplacedError extends Error {
  constructor(readonly presenter: FollowPerson | null) {
    super("Someone else is presenting now.");
    this.name = "FollowReplacedError";
  }
}

/** 429: wait until `retryAt` (ms since the epoch) before sending again. */
export class FollowRateLimitedError extends Error {
  constructor(readonly retryAt: number) {
    super("Sending too fast.");
    this.name = "FollowRateLimitedError";
  }
}

type RequestOptions = { body?: unknown; signal?: AbortSignal; keepalive?: boolean };

async function followRequest(path: string, method: "GET" | "POST", options: RequestOptions = {}): Promise<unknown> {
  if (!runtimeControllerEnabled) throw new Error("Runtime controller is not configured.");
  const context = await resolveControllerRequestContext(null);
  if (!context.baseUrl || !context.accessToken) {
    throw new ControllerApiError({ status: 401, message: "Missing controller session token.", code: null, details: null });
  }
  const headers: Record<string, string> = { authorization: `Bearer ${context.accessToken}`, accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${context.baseUrl}${path}`, {
    method, headers, signal: options.signal, keepalive: options.keepalive,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = response.status === 204 ? "" : await response.text().catch(() => "");
  let data: unknown = null;
  try { data = text.trim() ? JSON.parse(text) as unknown : null; } catch { data = null; }
  if (response.ok) return data;
  if (response.status === 409) {
    // `state: "ended"`: the presentation is over (timed out or stopped elsewhere), nobody replaced it.
    if (isRecord(data) && data.state === "ended") {
      throw new ControllerApiError({ status: 410, message: "This presentation has ended.", code: "presentation_ended", details: null, url: response.url });
    }
    throw new FollowReplacedError(isRecord(data) ? mapFollowPerson(data.presenter) : null);
  }
  if (response.status === 429) {
    const seconds = Number(response.headers.get("retry-after"));
    throw new FollowRateLimitedError(Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000));
  }
  if (response.status === 401) {
    await emitControllerAuthErrorForRequest({ status: 401, message: "Follow request was not authorized.", url: response.url }, context);
  }
  const message = isRecord(data) && typeof data.message === "string" ? data.message : `Follow request failed (${response.status})`;
  throw new ControllerApiError({ status: response.status, message, code: isRecord(data) ? readString(data.code) : null, details: null, url: response.url });
}

export type FollowSnapshot = { presence: FollowPresence | null; followers: FollowPerson[] };

export async function getFollowState(projectId: string, previewId: string, signal?: AbortSignal): Promise<FollowSnapshot> {
  const value = await followRequest(followPath(projectId, previewId), "GET", { signal });
  return readSnapshot(value);
}

function readSnapshot(value: unknown): FollowSnapshot {
  if (!isRecord(value)) return { presence: null, followers: [] };
  const followers = Array.isArray(value.followers)
    ? value.followers.map(mapFollowPerson).filter((person): person is FollowPerson => Boolean(person)) : [];
  return { presence: mapFollowPresence(value.presentation, value.followers), followers };
}

export type PresentResult = { presentationId: string; presenter: FollowPerson; startedAt: string | null; replaced: FollowPerson | null };

/** Starts presenting this preview; the last one wins, so it may replace someone. */
export async function startPresenting(projectId: string, previewId: string): Promise<PresentResult> {
  const value = await followRequest(followPath(projectId, previewId), "POST", { body: { op: "present" } });
  const presentationId = isRecord(value) ? readString(value.presentationId) : null;
  const presenter = isRecord(value) ? mapFollowPerson(value.presenter) : null;
  if (!presentationId || !presenter) throw new Error("The controller returned an unreadable presentation.");
  return {
    presentationId, presenter, startedAt: readString((value as Record<string, unknown>).startedAt),
    replaced: mapFollowPerson((value as Record<string, unknown>).replaced),
  };
}

/** A view (`payload` is the site's JSON text, already checked), or, without one, a heartbeat. */
export async function sendFollowView(projectId: string, previewId: string, input: { presentationId: string; seq: number; payloadJson?: string | null }): Promise<void> {
  const body: Record<string, unknown> = { op: "view", presentationId: input.presentationId, seq: input.seq };
  if (input.payloadJson) body.payload = JSON.parse(input.payloadJson) as unknown;
  await followRequest(followPath(projectId, previewId), "POST", { body });
}

export async function sendFollowTap(projectId: string, previewId: string, input: { presentationId: string; seq: number; payloadJson: string }): Promise<void> {
  await followRequest(followPath(projectId, previewId), "POST", {
    body: { op: "tap", presentationId: input.presentationId, seq: input.seq, payload: JSON.parse(input.payloadJson) as unknown },
  });
}

/** Ends the presentation for everyone. `keepalive` lets it leave with a closing page (pagehide). */
export async function stopPresenting(projectId: string, previewId: string, presentationId: string, options: { keepalive?: boolean } = {}): Promise<void> {
  await followRequest(followPath(projectId, previewId), "POST", { body: { op: "stop", presentationId }, keepalive: options.keepalive });
}

export type FollowStreamEvent =
  | { type: "state"; snapshot: FollowSnapshot }
  | { type: "view"; seq: number; payload: unknown; at: number | null }
  | { type: "tap"; seq: number; payload: unknown; at: number | null }
  | { type: "end"; reason: "stopped" | "replaced" | "timeout" | "closed" | "access" };

export function parseFollowStreamEvent(event: string, data: string): FollowStreamEvent | null {
  let value: unknown;
  try { value = JSON.parse(data) as unknown; } catch { return null; }
  if (!isRecord(value)) return null;
  switch (event) {
    case "state":
      return { type: "state", snapshot: readSnapshot(value) };
    case "view":
    case "tap": {
      const seq = readNumber(value.seq);
      if (seq === null || !("payload" in value)) return null;
      const at = readNumber(value.at) ?? (typeof value.at === "string" ? Date.parse(value.at) || null : null);
      return { type: event, seq, payload: value.payload, at };
    }
    case "end": {
      const reason = readString(value.reason);
      return { type: "end", reason: reason === "replaced" || reason === "timeout" || reason === "closed" || reason === "access" ? reason : "stopped" };
    }
    default:
      return null;
  }
}

export type FollowStreamHandle = { close: () => void };

/**
 * Opens the follow stream ("I am following") and keeps it open, reconnecting
 * with Last-Event-ID, until closed, the presentation ends, or access is gone.
 * The relay sends the latest view on every (re)connect.
 */
export function openFollowStream(projectId: string, previewId: string, handlers: {
  onEvent: (event: FollowStreamEvent) => void;
  /** Each time the stream (re)opens: the next view is a jump, not an animation. */
  onOpen?: () => void;
  /** 404/403: this person may no longer see the preview. */
  onGone?: () => void;
}): FollowStreamHandle {
  let closed = false;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastEventId = "";
  let delay = 1_000;

  const schedule = () => {
    if (closed || timer) return;
    timer = setTimeout(() => { timer = null; void connect(); }, delay);
    delay = Math.min(delay * 2, 15_000);
  };

  const connect = async () => {
    if (closed || !runtimeControllerEnabled) return;
    const current = new AbortController();
    controller = current;
    try {
      const context = await resolveControllerRequestContext(null);
      if (closed || controller !== current || !context.baseUrl || !context.accessToken) return;
      const headers: Record<string, string> = { accept: "text/event-stream", authorization: `Bearer ${context.accessToken}` };
      if (lastEventId) headers["last-event-id"] = lastEventId;
      const response = await fetch(`${context.baseUrl}${followPath(projectId, previewId, "/stream")}`, {
        method: "GET", headers, cache: "no-store", signal: current.signal,
      });
      if (closed || controller !== current) return;
      if (response.status === 404 || response.status === 403 || response.status === 410) {
        closed = true;
        handlers.onGone?.();
        return;
      }
      if (!response.ok || !response.body) { schedule(); return; }
      delay = 1_000;
      handlers.onOpen?.();
      const parser = new ServerSentEventParser(lastEventId, parsed => {
        const event = parseFollowStreamEvent(parsed.event, parsed.data);
        if (!event || closed) return;
        handlers.onEvent(event);
        if (event.type === "end" && event.reason !== "replaced") closed = true;
      }, id => { lastEventId = id; }, retry => { delay = Math.max(500, retry); });
      const reader = response.body.getReader();
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) parser.push(value);
      }
      if (closed) { void reader.cancel().catch(() => undefined); return; }
      schedule();
    } catch {
      if (!closed && controller === current) schedule();
    }
  };

  void connect();
  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      controller?.abort();
      controller = null;
    },
  };
}
