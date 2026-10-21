/**
 * Follow mode (docs/Follow-Mode.md): one person presents a site, others follow
 * live. This file is the pure part: the messages Studio and a site exchange,
 * what Studio accepts from a site, the coalescer that paces views to the
 * relay, the location guard, and the state each pane is in. Nothing here
 * knows what the site is; a view is opaque JSON the site describes itself.
 */
import { HOST_MESSAGE_SOURCE, HOST_MESSAGE_VERSION } from "./hostMessages";

/** A view or tap payload, as UTF-8 JSON, may be at most this long. */
export const FOLLOW_PAYLOAD_MAX_BYTES = 2048;
/** Studio sends at most one view per this interval (10/s); the latest wins, with a trailing send. */
export const FOLLOW_VIEW_INTERVAL_MS = 100;
/** A site's `interact` this soon after an applied view is the apply echoing, not the person. */
export const FOLLOW_INTERACT_GRACE_MS = 300;
/** A presenter who sent no view for this long sends an empty one, so the space knows they are still there. */
export const FOLLOW_HEARTBEAT_MS = 5_000;
/** Taps per second a presenter may send; more are dropped (the relay allows 5). */
export const FOLLOW_TAPS_PER_SECOND = 5;
export const FOLLOW_RIPPLE_MS = 1_200;
export const FOLLOW_TAKEOVER_NOTE_MS = 3_000;
export const FOLLOW_ENDED_NOTE_MS = 4_000;
/** A presenter whose screen went away (timeout) and who presents again this soon is followed again without a tap. */
export const FOLLOW_REJOIN_MS = 5 * 60_000;

import type { FollowPerson, FollowPresence } from "../../../../services/runtimeController/previewFollow";

export type { FollowPerson, FollowPresence };

// ---------------------------------------------------------------------------
// Studio → site

export type HostPresentMessage = {
  source: typeof HOST_MESSAGE_SOURCE; v: typeof HOST_MESSAGE_VERSION; type: "present"; on: boolean; share: { location: false };
};
export type HostApplyViewMessage = {
  source: typeof HOST_MESSAGE_SOURCE; v: typeof HOST_MESSAGE_VERSION; type: "apply-view";
  seq: number; payload: unknown; from: { id: string; name: string }; smooth: boolean;
};
export type HostApplyTapMessage = {
  source: typeof HOST_MESSAGE_SOURCE; v: typeof HOST_MESSAGE_VERSION; type: "apply-tap"; payload: FollowTap; from: { id: string; name: string };
};

/** `share.location` is false: the person's position is never part of what followers get. */
export function buildPresentMessage(on: boolean): HostPresentMessage {
  return { source: HOST_MESSAGE_SOURCE, v: HOST_MESSAGE_VERSION, type: "present", on, share: { location: false } };
}

export function buildApplyViewMessage(input: { seq: number; payload: unknown; from: FollowPerson; smooth: boolean }): HostApplyViewMessage {
  return {
    source: HOST_MESSAGE_SOURCE, v: HOST_MESSAGE_VERSION, type: "apply-view",
    seq: input.seq, payload: input.payload, from: { id: input.from.id, name: input.from.name }, smooth: input.smooth,
  };
}

export function buildApplyTapMessage(payload: FollowTap, from: FollowPerson): HostApplyTapMessage {
  return { source: HOST_MESSAGE_SOURCE, v: HOST_MESSAGE_VERSION, type: "apply-tap", payload, from: { id: from.id, name: from.name } };
}

// ---------------------------------------------------------------------------
// What Studio accepts from a site

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** Plain JSON only: no Dates, Maps, typed arrays, NaN or cycles (structured clone lets all of these through). */
export function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => isJsonValue(item, depth + 1));
  if (isPlainObject(value)) return Object.values(value).every(item => isJsonValue(item, depth + 1));
  return false;
}

const encoder = new TextEncoder();

/** The payload's JSON when it is plain JSON of at most 2 KB, else null (dropped). */
export function encodeFollowPayload(payload: unknown): string | null {
  if (payload === undefined || !isJsonValue(payload)) return null;
  let text: string;
  try { text = JSON.stringify(payload); } catch { return null; }
  return encoder.encode(text).byteLength <= FOLLOW_PAYLOAD_MAX_BYTES ? text : null;
}

/** A tap: where the presenter tapped, in 0..1 of the frame, plus an optional site-defined `at`. */
export type FollowTap = { x: number; y: number; at?: unknown };

export function readFollowTap(value: unknown): FollowTap | null {
  if (!isPlainObject(value)) return null;
  const { x, y } = value;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  const tap: FollowTap = { x, y };
  if (value.at !== undefined) {
    if (!isJsonValue(value.at)) return null;
    tap.at = value.at;
  }
  return encodeFollowPayload(tap) ? tap : null;
}

// ---------------------------------------------------------------------------
// The location guard: best effort against a site leaking the person's own
// position by accident. A payload holding latitude and longitude both within
// 1e-3 degrees (about 110 m) of it, as decimals (3 or more places, in numbers
// or text) or as whole micro- or 1e-7 degrees, is not sent. Coarser rounding
// gets through: the skill's "never put the position in it" is the main control.

export type GuardPosition = { latitude: number; longitude: number };

const NUMBER_IN_TEXT = /-?\d{1,3}\.\d{3,}|-?\d{6,10}/g;

/** A number as degrees, and a whole number also as micro- (E6) and 1e-7 (E7) degrees. */
function pushDegrees(value: number, into: number[]) {
  into.push(value);
  if (Number.isInteger(value) && Math.abs(value) >= 100_000) into.push(value / 1e6, value / 1e7);
}

function collectNumbers(value: unknown, into: number[], depth = 0) {
  if (depth > 32) return;
  if (typeof value === "number" && Number.isFinite(value)) { pushDegrees(value, into); return; }
  if (typeof value === "string") {
    for (const match of value.matchAll(NUMBER_IN_TEXT)) pushDegrees(Number(match[0]), into);
    return;
  }
  if (Array.isArray(value)) { for (const item of value) collectNumbers(item, into, depth + 1); return; }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      collectNumbers(key, into, depth + 1);
      collectNumbers(item, into, depth + 1);
    }
  }
}

/**
 * Within 1e-3 degrees (about 110 m): a copy rounded or truncated to 3 or more
 * decimals. A map centred that close to the person also shows where they are,
 * so it is held back too.
 */
const GUARD_TOLERANCE = 1e-3;

export function payloadHasPosition(payload: unknown, positions: readonly GuardPosition[]): boolean {
  if (!positions.length) return false;
  const numbers: number[] = [];
  collectNumbers(payload, numbers);
  if (numbers.length < 2) return false;
  const near = (value: number) => numbers.some(number => Math.abs(number - value) < GUARD_TOLERANCE);
  return positions.some(position => near(position.latitude) && near(position.longitude));
}

// ---------------------------------------------------------------------------
// The coalescer: at most one send per interval, the latest wins, and the last
// value is always sent (trailing), so the follower ends where the presenter did.

export type Coalescer<T> = {
  push: (value: T) => void;
  /** Sends a pending value now. */
  flush: () => void;
  /** Holds sends until `until` (a 429's Retry-After); the latest value waits. */
  pauseUntil: (until: number) => void;
  dispose: () => void;
};

export function createCoalescer<T>(options: {
  send: (value: T) => void;
  intervalMs?: number;
  now?: () => number;
}): Coalescer<T> {
  const interval = options.intervalMs ?? FOLLOW_VIEW_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());
  let lastSent = -Infinity;
  let pausedUntil = -Infinity;
  let pending: { value: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const sendPending = () => {
    timer = null;
    if (disposed || !pending) return;
    const at = now();
    const ready = Math.max(lastSent + interval, pausedUntil);
    if (at < ready) { schedule(ready - at); return; }
    const { value } = pending;
    pending = null;
    lastSent = at;
    options.send(value);
  };
  const schedule = (delay: number) => {
    if (timer !== null) return;
    timer = setTimeout(sendPending, Math.max(0, delay));
  };

  return {
    push(value) {
      if (disposed) return;
      pending = { value };
      const at = now();
      const ready = Math.max(lastSent + interval, pausedUntil);
      if (at >= ready && timer === null) sendPending();
      else schedule(ready - at);
    },
    flush() {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (pending && !disposed) {
        const { value } = pending;
        pending = null;
        lastSent = now();
        options.send(value);
      }
    },
    pauseUntil(until) {
      pausedUntil = Math.max(pausedUntil, until);
    },
    dispose() {
      disposed = true;
      pending = null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

/** `interact` from the site stops following, except right after Studio applied a view (the apply's own echo). */
export function interactStopsFollowing(now: number, lastApplyAt: number | null): boolean {
  return lastApplyAt === null || now - lastApplyAt >= FOLLOW_INTERACT_GRACE_MS;
}

// ---------------------------------------------------------------------------
// One pane's follow state.

export type FollowRole = "none" | "presenting" | "following" | "stopped-following";

/** Why a presentation ended, as the relay says ("timeout": the presenter's screen went away). */
export type FollowEndReason = "stopped" | "replaced" | "timeout" | "closed" | "access";

export type FollowNote =
  | { kind: "takeover"; from: string; to: string; at: number }
  | { kind: "ended"; name: string; at: number; reason?: FollowEndReason | null }
  /** This pane's own presentation ended while the page was away (the relay timed it out). */
  | { kind: "own-ended"; at: number }
  /** A presenter who went away presented again: this pane follows them again on its own. */
  | { kind: "rejoined"; name: string; at: number }
  | { kind: "replaced"; by: string; at: number };

export type FollowState = {
  /** The preview's presentation, as the space knows it; null when nobody presents. */
  presence: FollowPresence | null;
  role: FollowRole;
  /** The presentation this pane presents; set only while presenting. */
  ownPresentationId: string | null;
  note: FollowNote | null;
  /** The signed-in person: their own presentation from another screen is theirs, never "someone" to follow. */
  selfId?: string | null;
  /** Following ended because the presenter went away: follow them again if they present again soon. */
  rejoin?: { presenterId: string; until: number } | null;
};

export const INITIAL_FOLLOW_STATE: FollowState = { presence: null, role: "none", ownPresentationId: null, note: null, selfId: null, rejoin: null };

/** The presentation is this person's own, from another screen (another device, a reload, a closed tab). */
export function presentsElsewhere(state: FollowState): boolean {
  return Boolean(state.selfId && state.presence && state.presence.presenter.id === state.selfId && state.role !== "presenting");
}

export type FollowAction =
  /** What the space knows changed (presence event, GET, the follow stream's `state`); `reason` when it ended. */
  | { type: "presence"; presence: FollowPresence | null; at: number; reason?: FollowEndReason | null }
  | { type: "self"; id: string | null }
  /** This pane's own presentation was over when it came back (the relay said it ended). */
  | { type: "own-ended"; at: number }
  /** This pane started presenting. */
  | { type: "presented"; presence: FollowPresence; at: number }
  | { type: "stop-presenting" }
  /** The relay said someone else presents now (409 replaced). */
  | { type: "replaced"; by: FollowPerson | null; at: number }
  | { type: "follow" }
  | { type: "stop-following" }
  /** The person's own gesture on the site. */
  | { type: "interact" }
  /** The presentation ended (stream `end`, or presence gone). */
  | { type: "ended"; at: number; reason?: FollowEndReason | null }
  | { type: "clear-note" };

/** Following ended: remember a presenter whose screen went away, to follow them again if they come back soon. */
function rejoinAfter(state: FollowState, reason: FollowEndReason | null | undefined, at: number): FollowState["rejoin"] {
  if (reason !== "timeout" || state.role !== "following" || !state.presence) return state.rejoin ?? null;
  return { presenterId: state.presence.presenter.id, until: at + FOLLOW_REJOIN_MS };
}

export function reduceFollow(state: FollowState, action: FollowAction): FollowState {
  switch (action.type) {
    case "self":
      return (state.selfId ?? null) === action.id ? state : { ...state, selfId: action.id };
    case "presented":
      return { ...state, presence: action.presence, role: "presenting", ownPresentationId: action.presence.presentationId, note: null, rejoin: null };
    case "stop-presenting":
      if (state.role !== "presenting") return state;
      return { ...state, role: "none", ownPresentationId: null, presence: null };
    case "own-ended":
      if (state.role !== "presenting") return state;
      return { ...state, role: "none", ownPresentationId: null, presence: null, note: { kind: "own-ended", at: action.at } };
    case "replaced": {
      if (state.role !== "presenting") return state;
      // Our own presentation is over; who presents now arrives as presence.
      const presence = state.presence && state.presence.presentationId === state.ownPresentationId ? null : state.presence;
      return { ...state, role: "none", ownPresentationId: null, presence, note: action.by ? { kind: "replaced", by: action.by.name, at: action.at } : null };
    }
    case "presence": {
      const next = action.presence;
      const before = state.presence;
      if (state.role === "presenting") {
        if (!next) {
          // Our own presentation went away (timed out, or stopped elsewhere).
          return { ...state, presence: null, role: "none", ownPresentationId: null };
        }
        if (next.presentationId === state.ownPresentationId) return { ...state, presence: next };
        // Someone else took over: Kim's pill reads "Lena is presenting · Follow".
        return { ...state, presence: next, role: "none", ownPresentationId: null, note: { kind: "replaced", by: next.presenter.name, at: action.at } };
      }
      if (!next) {
        if (!before) return state;
        // My own presentation from another screen ending is no news to me.
        const mine = Boolean(state.selfId) && before.presenter.id === state.selfId;
        return {
          ...state, presence: null, role: "none",
          note: mine ? state.note : { kind: "ended", name: before.presenter.name, at: action.at, reason: action.reason ?? null },
          rejoin: rejoinAfter(state, action.reason, action.at),
        };
      }
      const rejoin = state.rejoin;
      if (rejoin && state.role === "none" && next.presenter.id === rejoin.presenterId && action.at < rejoin.until
        && (!before || before.presentationId !== next.presentationId)) {
        // The presenter whose screen went away is back: follow them again, as before, without a tap.
        return { ...state, presence: next, role: "following", rejoin: null, note: { kind: "rejoined", name: next.presenter.name, at: action.at } };
      }
      if (before && before.presentationId !== next.presentationId && before.presenter.id !== next.presenter.id && state.role === "following") {
        // Followers follow the preview, not the person: a takeover carries them along.
        return { ...state, presence: next, note: { kind: "takeover", from: before.presenter.name, to: next.presenter.name, at: action.at } };
      }
      if (before && before.presentationId !== next.presentationId && state.role === "stopped-following") {
        // A new presentation: the "Follow again" is about the old one.
        return { ...state, presence: next, role: "none" };
      }
      return { ...state, presence: next };
    }
    case "follow":
      if (!state.presence || state.role === "presenting") return state;
      return { ...state, role: "following", note: null };
    case "stop-following":
      if (state.role !== "following" && state.role !== "stopped-following") return state;
      return { ...state, role: "none" };
    case "interact":
      return state.role === "following" ? { ...state, role: "stopped-following" } : state;
    case "ended": {
      if (state.role === "presenting") return { ...state, presence: null, role: "none", ownPresentationId: null };
      const name = state.presence?.presenter.name;
      const mine = Boolean(state.selfId) && state.presence?.presenter.id === state.selfId;
      return {
        ...state, presence: null, role: "none",
        note: name && !mine ? { kind: "ended", name, at: action.at, reason: action.reason ?? null } : state.note,
        rejoin: rejoinAfter(state, action.reason, action.at),
      };
    }
    case "clear-note":
      return state.note ? { ...state, note: null } : state;
    default:
      return state;
  }
}

/** The words each state shows: one place, so the bar, the phone pill and the chip agree. */
export type FollowLabels = {
  /** The bar chip or the phone pill's text; null when nobody presents. */
  status: string | null;
  /** The action beside it. */
  action: "stop-presenting" | "stop-elsewhere" | "follow" | "follow-again" | "stop-following" | null;
  actionText: string | null;
  /** A short-lived line ("Lena took over from Kim"). */
  note: string | null;
};

function endedText(name: string, reason: FollowEndReason | null | undefined): string {
  switch (reason) {
    case "timeout": return `${name} went away, so following stopped`;
    case "closed": return `${name}'s site was closed`;
    case "access": return "You can no longer see this site";
    default: return `${name} stopped presenting`;
  }
}

function noteText(note: FollowNote | null): string | null {
  if (!note) return null;
  switch (note.kind) {
    case "takeover": return `${note.to} took over from ${note.from}`;
    case "ended": return endedText(note.name, note.reason);
    case "own-ended": return "Your presentation ended while you were away";
    case "rejoined": return `${note.name} is back: following again`;
    default: return `${note.by} is presenting now`;
  }
}

export function followLabels(state: FollowState): FollowLabels {
  const note = noteText(state.note);
  const presence = state.presence;
  if (state.role === "presenting") return { status: "Presenting", action: "stop-presenting", actionText: "Stop", note };
  if (!presence) return { status: null, action: null, actionText: null, note };
  // My own presentation from another screen: stop it from here, never follow myself.
  if (presentsElsewhere(state) && state.role !== "following") {
    return { status: "You're presenting on another screen", action: "stop-elsewhere", actionText: "Stop", note };
  }
  const name = presence.presenter.name;
  const away = presence.state === "away";
  if (state.role === "following") return { status: away ? `${name} is away` : `Following ${name}`, action: "stop-following", actionText: "Stop", note };
  if (state.role === "stopped-following") return { status: away ? `${name} is away` : `${name} is presenting`, action: "follow-again", actionText: "Follow again", note };
  return { status: away ? `${name} is away` : `${name} is presenting`, action: "follow", actionText: "Follow", note };
}

/**
 * "Present to the space", "Present instead of Kim", or why it is greyed out.
 * `short` is the button's visible word, which says a takeover too, since
 * touch screens show no tooltip.
 */
export function presentMenuLabel(input: { supportsView: boolean; state: FollowState }): { text: string; short: string; disabled: boolean; detail: string | null } {
  if (!input.supportsView) return { text: "Present: this site can't share its view yet", short: "Present", disabled: true, detail: null };
  const presence = input.state.presence;
  if (presentsElsewhere(input.state)) return { text: "Present from here", short: "Present here", disabled: false, detail: "You're presenting on another screen" };
  if (presence && input.state.role !== "presenting") {
    return { text: `Present instead of ${presence.presenter.name}`, short: "Present instead", disabled: false, detail: `${presence.presenter.name}'s followers will follow you` };
  }
  return { text: "Present to the space", short: "Present", disabled: false, detail: "Others in the space can follow your view" };
}
