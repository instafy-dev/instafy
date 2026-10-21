import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ControllerApiError } from "../../../../services/runtimeController/core";
import {
  FollowRateLimitedError,
  FollowReplacedError,
  getFollowState,
  openFollowStream,
  sendFollowTap,
  sendFollowView,
  startPresenting,
  stopPresenting,
  type FollowPerson,
  type FollowPresence,
} from "../../../../services/runtimeController/previewFollow";
import {
  FOLLOW_ENDED_NOTE_MS,
  FOLLOW_HEARTBEAT_MS,
  FOLLOW_RIPPLE_MS,
  FOLLOW_TAKEOVER_NOTE_MS,
  FOLLOW_TAPS_PER_SECOND,
  INITIAL_FOLLOW_STATE,
  buildApplyTapMessage,
  buildApplyViewMessage,
  buildPresentMessage,
  createCoalescer,
  encodeFollowPayload,
  interactStopsFollowing,
  payloadHasPosition,
  readFollowTap,
  reduceFollow,
  type Coalescer,
  type FollowState,
  type GuardPosition,
} from "./followMode";
import {
  applyFollowPresenceEvent,
  followEntry,
  forgetOwnPresentation,
  ownPresentation,
  publishFollowRole,
  nextOwnSeq,
  rememberOwnPresentation,
  setFollowPresence,
  takeFollowRequest,
  useFollowEntry,
} from "./followStore";
import type { SiteEvent } from "./hostMessages";

/** The presenter refreshes who watches this often (the presence event only carries a count). */
export const FOLLOW_FOLLOWERS_POLL_MS = 15_000;

export type FollowRipple = { id: number; x: number; y: number; name: string };

type Deps = {
  projectId: string;
  previewId: string;
  /** The frame is mounted, live and on screen. */
  frameOnScreen: boolean;
  /** Posts to this pane's frame at the viewer's origin; false when there is no frame. */
  postToFrame: (message: unknown) => boolean;
  /** What the site's `layout-ack` listed. Studio sends `present` and `apply-view` only to a site that supports "view". */
  supportsView: boolean;
  supportsTap: boolean;
  /** Changes with each new document in the frame, which must be told again that it presents. */
  documentKey: string;
  /** The person's positions this frame was given since it last loaded fresh: views holding one are not sent (the location guard). */
  recentPositions: () => GuardPosition[];
  /** The frame element, to notice the person's own clicks into it. */
  frameElement: () => HTMLIFrameElement | null;
  /** The signed-in person: a presentation of theirs from another screen is theirs to stop, not to follow. */
  selfId?: string | null;
  onError?: (message: string) => void;
  now?: () => number;
};

/**
 * One pane's follow mode: presenting (forwarding the site's views, coalesced,
 * to the relay) or following (applying the relay's views to the site), with
 * the presence everyone sees. See docs/Follow-Mode.md.
 */
export function usePreviewFollow(deps: Deps) {
  const { projectId, previewId, frameOnScreen, supportsView, documentKey } = deps;
  const now = deps.now ?? Date.now;
  const [state, dispatch] = useReducer(reduceFollow, INITIAL_FOLLOW_STATE);
  const stateRef = useRef<FollowState>(state);
  stateRef.current = state;
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const entry = useFollowEntry(previewId);
  const [followers, setFollowers] = useState<FollowPerson[]>([]);
  const [ripples, setRipples] = useState<FollowRipple[]>([]);
  const [locationLeftOut, setLocationLeftOut] = useState(false);
  const [checked, setChecked] = useState(false);
  const fetchGeneration = useRef(0);

  // What the space knows → this pane's state.
  useEffect(() => { dispatch({ type: "self", id: deps.selfId ?? null }); }, [deps.selfId]);
  useEffect(() => {
    dispatch({ type: "presence", presence: entry.presence, reason: entry.endReason ?? null, at: now() });
  }, [entry.presence, entry.endReason, now]);
  useEffect(() => { publishFollowRole(previewId, state.role); }, [previewId, state.role]);
  useEffect(() => () => publishFollowRole(previewId, "none"), [previewId]);

  const refresh = useCallback(async () => {
    const generation = ++fetchGeneration.current;
    try {
      const snapshot = await getFollowState(projectId, previewId);
      // A present or stop since the request started is newer than this answer.
      if (generation !== fetchGeneration.current) return;
      setFollowPresence(previewId, snapshot.presence);
      setFollowers(snapshot.followers);
    } catch {
      // An older controller without follow mode, or a passing error: nobody presents as far as we know.
    } finally {
      if (generation === fetchGeneration.current) setChecked(true);
    }
  }, [previewId, projectId]);

  // Once the site is on screen: is someone presenting it?
  const askedOnce = useRef(false);
  useEffect(() => {
    if (!frameOnScreen || askedOnce.current) return;
    askedOnce.current = true;
    void refresh();
  }, [frameOnScreen, refresh]);

  // ---------------------------------------------------------------- presenting
  const seq = useRef(0);
  const lastSentAt = useRef(0);
  const latestView = useRef<string | null>(null);
  const coalescer = useRef<Coalescer<string> | null>(null);
  const tapTimes = useRef<number[]>([]);
  const presenting = state.role === "presenting" ? state.ownPresentationId : null;
  /** Studio's own seq for the presentation, increasing across every pane of this page that presents it. */
  const nextSeq = useCallback((presentationId: string) => {
    seq.current = nextOwnSeq(previewId, presentationId, seq.current);
    return seq.current;
  }, [previewId]);

  const endOwn = useCallback((reason: "stopped" | "replaced" | "gone" | "ended", by: FollowPerson | null = null) => {
    const own = stateRef.current.ownPresentationId;
    if (own) forgetOwnPresentation(previewId, own);
    depsRef.current.postToFrame(buildPresentMessage(false));
    fetchGeneration.current += 1;
    if (reason === "replaced") dispatch({ type: "replaced", by, at: now() });
    // The relay ended it while this page was away (the phone went to the call screen): say so.
    else if (reason === "ended") dispatch({ type: "own-ended", at: now() });
    else dispatch({ type: "stop-presenting" });
    setLocationLeftOut(false);
    // Who presents now: the relay's answer only named them.
    if (reason === "replaced") void refresh();
  }, [now, previewId, refresh]);

  const handleSendError = useCallback((cause: unknown, retry: string | null) => {
    if (cause instanceof FollowReplacedError) { endOwn("replaced", cause.presenter); return; }
    if (cause instanceof FollowRateLimitedError) {
      coalescer.current?.pauseUntil(cause.retryAt);
      // The newest view, not the one that was refused: a newer one may have been queued meanwhile.
      if (retry) coalescer.current?.push(latestView.current ?? retry);
      return;
    }
    if (cause instanceof ControllerApiError && [403, 404, 410].includes(cause.status)) {
      setFollowPresence(previewId, null);
      endOwn(cause.status === 410 ? "ended" : "gone");
    }
  }, [endOwn, previewId]);

  // A presentation this page started for this preview whose pane went away
  // (a run tab, another conversation) and came back: present again from here.
  // The first heartbeat says whether the relay still has it; if it ended
  // meanwhile, the pane says so ("Your presentation ended while you were away").
  const resumeBeat = useRef(false);
  useEffect(() => {
    const own = ownPresentation(previewId);
    if (!own || own.projectId !== projectId || stateRef.current.role === "presenting") return;
    const known = followEntry(previewId).presence;
    const presence: FollowPresence = known && known.presentationId === own.presentationId
      ? known : { presentationId: own.presentationId, presenter: own.presenter, state: "live", followers: 0 };
    resumeBeat.current = true;
    dispatch({ type: "presented", presence, at: now() });
    setFollowPresence(previewId, presence);
  }, [now, previewId, projectId]);
  // Own presentation over for any reason this pane saw (taken over, timed out, stopped elsewhere): forget it.
  const lastOwn = useRef<string | null>(null);
  useEffect(() => {
    const before = lastOwn.current;
    lastOwn.current = state.ownPresentationId;
    if (before && before !== state.ownPresentationId) forgetOwnPresentation(previewId, before);
  }, [previewId, state.ownPresentationId]);

  useEffect(() => {
    if (!presenting) return;
    const sender = createCoalescer<string>({
      send: payloadJson => {
        lastSentAt.current = now();
        void sendFollowView(projectId, previewId, { presentationId: presenting, seq: nextSeq(presenting), payloadJson })
          .catch(cause => handleSendError(cause, payloadJson));
      },
      now,
    });
    coalescer.current = sender;
    lastSentAt.current = now();
    if (resumeBeat.current) {
      resumeBeat.current = false;
      void sendFollowView(projectId, previewId, { presentationId: presenting, seq: nextSeq(presenting) }).catch(cause => handleSendError(cause, null));
    }
    // Heartbeat: a presenter who sends no view stays "live" while the page is visible.
    const heartbeat = window.setInterval(() => {
      if (document.visibilityState === "hidden" || now() - lastSentAt.current < FOLLOW_HEARTBEAT_MS) return;
      lastSentAt.current = now();
      void sendFollowView(projectId, previewId, { presentationId: presenting, seq: nextSeq(presenting) })
        .catch(cause => handleSendError(cause, null));
    }, 1_000);
    // Back from the background: the latest view at once, so followers see "live" again.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (latestView.current) sender.push(latestView.current);
      else {
        lastSentAt.current = now();
        void sendFollowView(projectId, previewId, { presentationId: presenting, seq: nextSeq(presenting) }).catch(cause => handleSendError(cause, null));
      }
    };
    // Leaving the page ends it for everyone (followStore's pagehide, docs/Follow-Mode.md).
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      sender.dispose();
      if (coalescer.current === sender) coalescer.current = null;
      window.clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [handleSendError, nextSeq, now, presenting, previewId, projectId]);

  // Unmounting the pane does not end a presentation (otherwise opening a run
  // tab would end it for everyone without a word). Without this pane's
  // heartbeats the relay shows the presenter as away, and ends it 120 s later
  // unless a pane for this preview picks it up again. Closing the preview's
  // tab ends it (followStore.endOwnPresentation, from the panel).

  // A new document in the frame, or a site that just said it can share views: tell it again that it presents.
  useEffect(() => {
    if (presenting && supportsView) depsRef.current.postToFrame(buildPresentMessage(true));
  }, [documentKey, presenting, supportsView]);

  // Who watches: the presence event only carries a count.
  const followerCount = state.presence?.followers ?? 0;
  useEffect(() => {
    if (!presenting) return;
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, FOLLOW_FOLLOWERS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [followerCount, presenting, refresh]);

  const present = useCallback(async () => {
    if (!depsRef.current.supportsView || stateRef.current.role === "presenting") return;
    fetchGeneration.current += 1;
    try {
      const result = await startPresenting(projectId, previewId);
      const presence: FollowPresence = { presentationId: result.presentationId, presenter: result.presenter, state: "live", followers: 0 };
      seq.current = 0;
      latestView.current = null;
      tapTimes.current = [];
      setLocationLeftOut(false);
      setFollowers([]);
      dispatch({ type: "presented", presence, at: now() });
      rememberOwnPresentation(previewId, { projectId, presentationId: result.presentationId, presenter: result.presenter });
      // The site hears `present` from the effect below, once, as for a reloaded frame.
      setFollowPresence(previewId, presence);
    } catch (cause) {
      depsRef.current.onError?.(cause instanceof ControllerApiError && cause.status === 429
        ? "You are presenting too many sites at once." : "Couldn't start presenting.");
    }
  }, [now, previewId, projectId]);

  const stopOwn = useCallback(() => {
    const id = stateRef.current.ownPresentationId;
    if (!id) return;
    forgetOwnPresentation(previewId, id);
    applyFollowPresenceEvent(previewId, id, null);
    endOwn("stopped");
    void stopPresenting(projectId, previewId, id).catch(() => undefined);
  }, [endOwn, previewId, projectId]);

  /** My own presentation from another screen (a second device, a closed tab): end it from here. */
  const stopElsewhere = useCallback(() => {
    const presence = stateRef.current.presence;
    if (!presence || stateRef.current.role === "presenting") return;
    applyFollowPresenceEvent(previewId, presence.presentationId, null);
    void stopPresenting(projectId, previewId, presence.presentationId).catch(() => undefined);
  }, [previewId, projectId]);

  // ----------------------------------------------------------------- following
  const following = state.role === "following";
  const lastApplyAt = useRef<number | null>(null);
  const lastView = useRef<{ seq: number; payload: unknown } | null>(null);
  const jumpNext = useRef(true);
  const presenterRef = useRef<FollowPerson | null>(null);
  presenterRef.current = state.presence?.presenter ?? null;

  const applyView = useCallback((smooth: boolean) => {
    const view = lastView.current;
    const from = presenterRef.current;
    if (!view || !from || !depsRef.current.supportsView) return false;
    if (!depsRef.current.postToFrame(buildApplyViewMessage({ seq: view.seq, payload: view.payload, from, smooth }))) return false;
    lastApplyAt.current = now();
    return true;
  }, [now]);

  useEffect(() => {
    if (!following) return;
    jumpNext.current = true;
    const stream = openFollowStream(projectId, previewId, {
      onOpen: () => { jumpNext.current = true; },
      onGone: () => { setFollowPresence(previewId, null); dispatch({ type: "ended", at: now() }); },
      onEvent: event => {
        if (event.type === "state") {
          setFollowPresence(previewId, event.snapshot.presence);
          setFollowers(event.snapshot.followers);
          return;
        }
        if (event.type === "view") {
          lastView.current = { seq: event.seq, payload: event.payload };
          if (applyView(!jumpNext.current)) jumpNext.current = false;
          return;
        }
        if (event.type === "tap") {
          const tap = readFollowTap(event.payload);
          const from = presenterRef.current;
          if (!tap || !from) return;
          if (depsRef.current.supportsTap) { depsRef.current.postToFrame(buildApplyTapMessage(tap, from)); return; }
          const id = now() + Math.random();
          setRipples(current => [...current.slice(-4), { id, x: tap.x, y: tap.y, name: from.name }]);
          window.setTimeout(() => setRipples(current => current.filter(ripple => ripple.id !== id)), FOLLOW_RIPPLE_MS);
          return;
        }
        if (event.type === "end" && event.reason !== "replaced") {
          dispatch({ type: "ended", reason: event.reason ?? null, at: now() });
          setFollowPresence(previewId, null, event.reason ?? null);
        }
      },
    });
    return () => { stream.close(); setRipples([]); };
  }, [applyView, following, now, previewId, projectId]);

  // The site said it can take views (first load, or a reload): catch it up at once.
  useEffect(() => {
    if (following && supportsView) { jumpNext.current = true; if (applyView(false)) jumpNext.current = false; }
  }, [applyView, documentKey, following, supportsView]);

  const follow = useCallback(() => {
    // The reducer checks there is a presentation: it may have arrived in this same commit.
    if (stateRef.current.role === "presenting") return;
    lastView.current = null;
    lastApplyAt.current = null;
    dispatch({ type: "follow" });
  }, []);
  const stopFollowing = useCallback(() => dispatch({ type: "stop-following" }), []);

  /** The person's own gesture on the site: following stops, unless it is the echo of an apply. */
  const personInteracted = useCallback(() => {
    if (stateRef.current.role !== "following") return;
    if (!interactStopsFollowing(now(), lastApplyAt.current)) return;
    dispatch({ type: "interact" });
  }, [now]);

  // A site that never reports `interact`: a click into the frame moves focus into it.
  useEffect(() => {
    if (!following) return;
    const onBlur = () => {
      window.setTimeout(() => {
        const frame = depsRef.current.frameElement();
        if (frame && document.activeElement === frame) personInteracted();
      }, 0);
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [following, personInteracted]);

  // The card's Follow: follow once the site is on screen and the presentation is known.
  // (The store's presence, not the reducer's: both may change in the commit that brings the answer.)
  useEffect(() => {
    if (!entry.followRequested || !frameOnScreen) return;
    if (entry.presence) { if (takeFollowRequest(previewId)) follow(); return; }
    if (checked) takeFollowRequest(previewId);
  }, [checked, entry.followRequested, entry.presence, follow, frameOnScreen, previewId]);

  // Short-lived notes: "Lena took over from Kim" for 3 s, "Kim stopped presenting" for 4 s.
  useEffect(() => {
    if (!state.note) return;
    const timer = window.setTimeout(() => dispatch({ type: "clear-note" }), state.note.kind === "ended" ? FOLLOW_ENDED_NOTE_MS : FOLLOW_TAKEOVER_NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [state.note]);

  // A phone held during a call must not dim while presenting or following (no prompt; where supported).
  const keepAwake = state.role === "presenting" || state.role === "following";
  useEffect(() => {
    if (!keepAwake) return;
    const wakeLock = (navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock;
    if (!wakeLock) return;
    let sentinel: { release: () => Promise<void> } | null = null;
    let active = true;
    const acquire = () => {
      if (document.visibilityState !== "visible") return;
      void wakeLock.request("screen").then(lock => {
        if (active) sentinel = lock; else void lock.release().catch(() => undefined);
      }).catch(() => undefined);
    };
    acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", acquire);
      void sentinel?.release().catch(() => undefined);
    };
  }, [keepAwake]);

  /** Follow mode's share of the site's messages; true when it consumed one. */
  const handleSiteEvent = useCallback((event: SiteEvent): boolean => {
    if (event.type === "interact") { personInteracted(); return true; }
    if (event.type !== "view" && event.type !== "tap") return false;
    const current = stateRef.current;
    if (current.role !== "presenting" || !current.ownPresentationId) return true;
    if (event.type === "view") {
      const json = encodeFollowPayload(event.payload);
      if (!json) return true;
      // The person's own position never leaves in a view (the location guard).
      if (payloadHasPosition(event.payload, depsRef.current.recentPositions())) {
        setLocationLeftOut(true);
        return true;
      }
      latestView.current = json;
      coalescer.current?.push(json);
      return true;
    }
    const tap = readFollowTap(event.payload);
    if (!tap) return true;
    if (tap.at !== undefined && payloadHasPosition(tap.at, depsRef.current.recentPositions())) {
      setLocationLeftOut(true);
      return true;
    }
    const at = now();
    tapTimes.current = tapTimes.current.filter(time => at - time < 1_000);
    if (tapTimes.current.length >= FOLLOW_TAPS_PER_SECOND) return true;
    tapTimes.current.push(at);
    const presentationId = current.ownPresentationId;
    void sendFollowTap(projectId, previewId, { presentationId, seq: nextSeq(presentationId), payloadJson: JSON.stringify(tap) })
      .catch(cause => handleSendError(cause, null));
    return true;
  }, [handleSendError, nextSeq, now, personInteracted, previewId, projectId]);

  return {
    state,
    followers,
    ripples,
    locationLeftOut,
    present,
    stopPresenting: stopOwn,
    stopElsewhere,
    follow,
    stopFollowing,
    personInteracted,
    handleSiteEvent,
  };
}
