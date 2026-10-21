import { useSyncExternalStore } from "react";
import { PREVIEW_FOLLOW_EVENT, mapFollowPresenceEvent, stopPresenting, type FollowPerson } from "../../../../services/runtimeController/previewFollow";
import type { FollowEndReason, FollowPresence, FollowRole } from "./followMode";

/**
 * What Studio knows about follow mode per preview, shared between the pane and
 * its card in chat:
 * - `presence`: who presents (from `preview.follow` events, GET follow, the
 *   follow stream, or this device presenting);
 * - `role`: what this device's pane is doing;
 * - `followRequested`: the card's Follow was pressed and the pane, once open, follows.
 */
export type FollowEntry = {
  presence: FollowPresence | null;
  /** Why the last presentation ended, when the relay said ("timeout": the presenter's screen went away). */
  endReason?: FollowEndReason | null;
  role: FollowRole;
  followRequested: boolean;
};

const EMPTY: FollowEntry = { presence: null, endReason: null, role: "none", followRequested: false };
const entries = new Map<string, FollowEntry>();
const listeners = new Set<() => void>();

function update(previewId: string, change: (entry: FollowEntry) => FollowEntry) {
  const before = entries.get(previewId) ?? EMPTY;
  const after = change(before);
  if (after === before) return;
  if (after.presence === null && !after.endReason && after.role === "none" && !after.followRequested) entries.delete(previewId);
  else entries.set(previewId, after);
  for (const listener of listeners) listener();
}

const samePresence = (a: FollowPresence | null, b: FollowPresence | null) => JSON.stringify(a) === JSON.stringify(b);

export function setFollowPresence(previewId: string, presence: FollowPresence | null, endReason: FollowEndReason | null = null) {
  update(previewId, entry => samePresence(entry.presence, presence) && (entry.endReason ?? null) === endReason
    ? entry : { ...entry, presence, endReason: presence ? null : endReason });
}

export function publishFollowRole(previewId: string, role: FollowRole) {
  update(previewId, entry => entry.role === role ? entry : { ...entry, role });
}

const endedPresentations: string[] = [];

/**
 * A `preview.follow` event. Events about a presentation that already ended, or
 * an "ended" about one that is no longer the current one (it was taken over),
 * change nothing: they arrive after what replaced them.
 */
export function applyFollowPresenceEvent(previewId: string, presentationId: string | null, presence: FollowPresence | null, reason: FollowEndReason | null = null) {
  if (presentationId && endedPresentations.includes(presentationId)) return;
  if (!presence) {
    if (presentationId) {
      endedPresentations.push(presentationId);
      if (endedPresentations.length > 64) endedPresentations.shift();
    }
    const current = followEntry(previewId).presence;
    if (current && presentationId && current.presentationId !== presentationId) return;
    if (!current) return; // already gone (the follow stream's end got here first, with its reason)
  }
  setFollowPresence(previewId, presence, reason);
}

/** Reads the controller's `preview.follow` events (raised on window by the controller sync). */
export function handleFollowPresenceWindowEvent(event: Event) {
  const parsed = mapFollowPresenceEvent((event as CustomEvent<unknown>).detail);
  if (parsed) applyFollowPresenceEvent(parsed.previewId, parsed.presentationId, parsed.presence, parsed.reason);
}
if (typeof window !== "undefined") window.addEventListener(PREVIEW_FOLLOW_EVENT, handleFollowPresenceWindowEvent);

/** The card's Follow: the pane follows as soon as it is open (it may first need to mint a session). */
export function requestFollow(previewId: string) {
  update(previewId, entry => entry.followRequested ? entry : { ...entry, followRequested: true });
}

/** True once per request: the pane that takes it follows. */
export function takeFollowRequest(previewId: string): boolean {
  const entry = entries.get(previewId);
  if (!entry?.followRequested) return false;
  update(previewId, current => ({ ...current, followRequested: false }));
  return true;
}

/**
 * The presentations this page started, by preview. A presentation belongs to
 * the page, not to the pane: switching to a run tab or another conversation
 * unmounts the pane but must not end it silently. While no pane sends
 * heartbeats the relay shows the presenter as away (and ends it 120 s
 * later); a pane for the same preview that mounts again picks it up.
 * Closing the preview's tab, Stop, or leaving the page ends it.
 */
export type OwnPresentation = {
  projectId: string; presentationId: string; presenter: FollowPerson;
  /**
   * The last seq this page sent for it. The relay drops a view or heartbeat
   * whose seq is not above the last one it took, so a pane that picks the
   * presentation up again continues from here instead of from 0.
   */
  lastSeq?: number;
};
const ownPresentations = new Map<string, OwnPresentation>();

/** The next seq for this page's own presentation, above every one any pane of this page sent for it. */
export function nextOwnSeq(previewId: string, presentationId: string, local: number): number {
  const own = ownPresentations.get(previewId);
  if (!own || own.presentationId !== presentationId) return local + 1;
  const seq = Math.max(local, own.lastSeq ?? 0) + 1;
  own.lastSeq = seq;
  return seq;
}

export function rememberOwnPresentation(previewId: string, own: OwnPresentation) {
  ownPresentations.set(previewId, own);
}

export function ownPresentation(previewId: string): OwnPresentation | null {
  return ownPresentations.get(previewId) ?? null;
}

/** Forgets `presentationId` (or any) for this preview; true when it was remembered. */
export function forgetOwnPresentation(previewId: string, presentationId?: string): boolean {
  const own = ownPresentations.get(previewId);
  if (!own || (presentationId && own.presentationId !== presentationId)) return false;
  ownPresentations.delete(previewId);
  return true;
}

/** The preview's tab was closed: a presentation this page runs for it ends for everyone. */
export function endOwnPresentation(previewId: string) {
  const own = ownPresentations.get(previewId);
  if (!own) return;
  ownPresentations.delete(previewId);
  applyFollowPresenceEvent(previewId, own.presentationId, null);
  void stopPresenting(own.projectId, previewId, own.presentationId, { keepalive: true }).catch(() => undefined);
}

// Leaving the page ends every presentation it runs, mounted pane or not (docs/Follow-Mode.md).
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    for (const previewId of [...ownPresentations.keys()]) endOwnPresentation(previewId);
  });
}

export function followEntry(previewId: string): FollowEntry {
  return entries.get(previewId) ?? EMPTY;
}

/**
 * Who is signed in, set by AuthProvider (as for location's sites), so the
 * pane and card know a presentation is the person's own without importing the
 * auth provider's graph.
 */
let account: string | null = null;
const accountListeners = new Set<() => void>();

export function setFollowAccount(userId: string | null) {
  if (account === userId) return;
  account = userId;
  for (const listener of accountListeners) listener();
}

/** The signed-in person's id, or null (signed out, or a component rendered on its own). */
export function useFollowAccount(): string | null {
  return useSyncExternalStore(
    listener => { accountListeners.add(listener); return () => { accountListeners.delete(listener); }; },
    () => account,
    () => null,
  );
}

export function resetFollowStoreForTests() {
  setFollowAccount(null);
  entries.clear();
  ownPresentations.clear();
  endedPresentations.length = 0;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useFollowEntry(previewId: string | null | undefined): FollowEntry {
  return useSyncExternalStore(subscribe, () => previewId ? followEntry(previewId) : EMPTY, () => EMPTY);
}
