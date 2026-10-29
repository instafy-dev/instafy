import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WebWindow } from "iconoir-react";
import { Text } from "../../../components/Text";
import { useOptionalRuntimeState } from "../../../runtime/RuntimeStateProvider";
import type { RunRecord } from "../../../types";
import { ControllerApiError } from "../../../services/runtimeController/core";
import {
  SITE_PREVIEW_THUMBNAIL_EVENT,
  getSitePreview,
  getSitePreviewThumbnail,
  sitePreviewFacts,
  sitePreviewProblem,
  sitePreviewShownState,
  wakeSitePreview,
  type ControllerSitePreview,
  type SitePreviewThumbnailEventDetail,
} from "../../../services/runtimeController/previews";
import { useConversationPreviewOpener } from "../../../workspace/ConversationPreviewContext";
import { sitePreviewCardTitle, type SitePreviewRequest } from "./sitePreviewRequest";
import { requestFollow, setFollowPresence, useFollowAccount, useFollowEntry } from "./previewHost/followStore";
import { getFollowState } from "../../../services/runtimeController/previewFollow";
import { PreviewWakeError, START_NEEDS_BUILDER_TEXT, wakeUntilLive } from "./sitePreviewWake";
import { SitePreviewCardView, type SitePreviewCardAction, type SitePreviewCardStatus, type SitePreviewCardViewProps } from "./SitePreviewCardView";
import { useAuthorizedImage, useNearViewport } from "./useAuthorizedImage";

export type SitePreviewState = "checking" | "live" | "not_responding" | "unavailable" | "stopped";

/**
 * How often a card whose pane is on screen, or whose site has no settled
 * state, asks again. Only the newest card for a preview asks; every card for
 * it reads the answer.
 */
const SITE_PREVIEW_FOLLOW_MS = 15_000;
/** How often a card follows a wake someone else started, so it says Live as soon as the site answers. */
const SITE_PREVIEW_WAKE_FOLLOW_MS = 3_000;
/**
 * How many times a card whose pane is not on screen follows a site with no
 * settled state (Checking, Not responding, Status unavailable) before it stops
 * asking. A press, or a tunnel or runtime event, asks again.
 */
const MAX_UNSEEN_FOLLOWS = 8;
/**
 * Pauses before asking again after a check failed, one per retry. After the
 * last one the card stops asking until a press or a tunnel or runtime event.
 */
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];
/** A card says "Checking the site…" only once a check has taken this long; most answer before. */
export const SITE_PREVIEW_CHECKING_QUIET_MS = 3_000;
/**
 * How long a card that started its site says "Starting…" after the site
 * answered, while the pane it opened has not shown the page.
 */
export const SITE_PREVIEW_PAGE_WAIT_MS = 60_000;
const ENDED_GRANT_STATUSES: ReadonlySet<string> = new Set(["revoked", "expired", "closed", "failed"]);
const ENDED_RUNTIME_STATUSES: ReadonlySet<string> = new Set(["stopped", "stopping", "terminated", "released", "failed"]);
/** A turn in one of these has ended: whatever it did to a site is done. */
const ENDED_RUN_STATUSES: ReadonlySet<string> = new Set(["success", "failed", "canceled", "merged"]);

/**
 * What a card says about its site. Only the controller's record (grant and
 * probe) and the store's tunnel and runtime events decide it, never the
 * message's text, and Live needs a probe that saw the site answer, so an old
 * card never claims Live. The record reads as it does in the pane.
 */
export function sitePreviewState(input: {
  preview: Pick<ControllerSitePreview, "status" | "health"> | null;
  gone: boolean;
  /** The last check failed, so the card cannot say anything about the site. */
  unavailable: boolean;
  grantStatus: string | null;
  runtimeStatus: string | null;
}): SitePreviewState {
  if (input.gone) return "stopped";
  if (input.grantStatus && ENDED_GRANT_STATUSES.has(input.grantStatus)) return "stopped";
  if (input.runtimeStatus && ENDED_RUNTIME_STATUSES.has(input.runtimeStatus)) return "stopped";
  if (input.unavailable) return "unavailable";
  if (!input.preview) return "checking";
  return sitePreviewShownState(input.preview);
}

/** A settled answer about a preview, which every card for it reads. */
type SharedAnswer = { preview: ControllerSitePreview } | { gone: true };
type CardMember = {
  read: (answer: SharedAnswer) => void;
  setLeads: (leads: boolean) => void;
  setLatest: (latest: boolean) => void;
  /** Whether this card would follow its site now, if it were the one to. */
  wants: boolean;
  /** When its message was posted, and which message it is (a message drawn twice is one card). */
  postedAt: number;
  messageKey: string;
};
type PreviewCards = { members: Set<CardMember>; unseenFollows: number };

/**
 * The cards on the page for each preview. Octo may post several for one site
 * (each run that opens it again posts its own). Only the latest posted card is
 * drawn in full; an earlier one shrinks to a line that points to it, so a
 * conversation shows one card per site. Only the latest card that would
 * follow the site does, every card reads each answer, and follow-ups made
 * while the pane is not on screen are counted once per preview, so N cards
 * never ask N times.
 */
const cardsByPreview = new Map<string, PreviewCards>();

function latestKey(cards: PreviewCards): string | null {
  let latest: CardMember | null = null;
  for (const member of cards.members) {
    if (!latest || member.postedAt > latest.postedAt || (member.postedAt === latest.postedAt && member.messageKey > latest.messageKey)) {
      latest = member;
    }
  }
  return latest?.messageKey ?? null;
}

function electFollower(cards: PreviewCards) {
  const key = latestKey(cards);
  for (const member of cards.members) member.setLatest(member.messageKey === key);
  const follower = [...cards.members].reverse().find((member) => member.wants && member.messageKey === key)
    ?? [...cards.members].reverse().find((member) => member.wants)
    ?? null;
  for (const member of cards.members) member.setLeads(member === follower);
}

function joinPreviewCards(previewId: string, member: CardMember): () => void {
  const cards = cardsByPreview.get(previewId) ?? { members: new Set<CardMember>(), unseenFollows: 0 };
  cardsByPreview.set(previewId, cards);
  cards.members.add(member);
  electFollower(cards);
  return () => {
    cards.members.delete(member);
    if (cards.members.size) electFollower(cards);
    else cardsByPreview.delete(previewId);
  };
}

function setWantsToFollow(previewId: string, member: CardMember, wants: boolean) {
  member.wants = wants;
  const cards = cardsByPreview.get(previewId);
  if (cards?.members.has(member)) electFollower(cards);
}

function shareAnswer(previewId: string, from: CardMember, answer: SharedAnswer) {
  for (const member of cardsByPreview.get(previewId)?.members ?? []) {
    if (member !== from) member.read(answer);
  }
}

/**
 * A record the preview's pane just read, for every card of that preview: the
 * pane checks its site every 15 s while it is on screen, so a card beside it
 * reads those answers instead of asking the controller the same thing.
 */
export function shareSitePreviewRecord(previewId: string, preview: ControllerSitePreview) {
  for (const member of cardsByPreview.get(previewId)?.members ?? []) member.read({ preview });
}

/** The cards that started a site and wait for its page to show in the pane, per preview. */
const pageWaiters = new Map<string, Set<() => void>>();

/**
 * The pane showed the site's page (its frame loaded): a card that started
 * the site says "Starting…" until then, since a site that answers its first
 * check can take many seconds more to show its page.
 */
export function shareSitePreviewPageShown(previewId: string) {
  for (const shown of [...(pageWaiters.get(previewId) ?? [])]) shown();
}

/** Calls `shown` when a pane shows this preview's page. Returns the unregister. */
export function waitForSitePreviewPage(previewId: string, shown: () => void): () => void {
  const waiters = pageWaiters.get(previewId) ?? new Set<() => void>();
  pageWaiters.set(previewId, waiters);
  waiters.add(shown);
  return () => {
    waiters.delete(shown);
    if (!waiters.size) pageWaiters.delete(previewId);
  };
}

/** The pane on screen for each preview, as its own "check the site now". */
const paneChecks = new Map<string, () => void>();

/**
 * While a preview's pane is on screen, its cards ask the pane to check the site instead of asking themselves, so the
 * pane and the cards read the same answer. Returns the unregister.
 */
export function registerSitePreviewPaneCheck(previewId: string, check: () => void): () => void {
  paneChecks.set(previewId, check);
  return () => {
    if (paneChecks.get(previewId) === check) paneChecks.delete(previewId);
  };
}

/**
 * What a failed check means for the card: `gone` (the preview does not exist,
 * this viewer may not see it, or it stopped) reads Stopped; `final` (this
 * server offers no previews, or the session is gone) reads Status unavailable
 * and is not asked again by itself; `passing` is retried.
 */
function checkFailure(error: unknown): "gone" | "final" | "passing" {
  const problem = sitePreviewProblem(error);
  if (problem === "missing" || problem === "no_access" || problem === "stopped") return "gone";
  if (problem === "unavailable") return "final";
  if (error instanceof ControllerApiError && (error.status === 401 || error.status === 503)) return "final";
  return "passing";
}

/** Runs `run` now if the page is visible, or once it next becomes visible. Returns a cancel. */
function whenVisible(run: () => void): () => void {
  if (typeof document === "undefined" || document.visibilityState !== "hidden") {
    run();
    return () => {};
  }
  const onChange = () => {
    if (document.visibilityState === "hidden") return;
    document.removeEventListener("visibilitychange", onChange);
    run();
  };
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/**
 * What the card says under its title in each state that is not the normal live one. A site that stopped answering
 * reads as stopped: to the person it is, whether its server was stopped or its machine was.
 */
export const SITE_PREVIEW_STATUS_TEXT = {
  checking: "Checking the site…",
  starting: "Starting…",
  unavailable: "Status unavailable",
  // Not known yet whether a press can start it: nothing more than what is true.
  stopped: "Stopped",
  // Nothing here can start it, so the line says who can: the pane says the same.
  stoppedAskOcto: "Stopped · ask Octo to start it again",
  stoppedRestarts: "Stopped · opening restarts it",
  stoppedNeedsBuilder: "Stopped · only people who can edit this space can start it",
  couldNotStart: "Couldn't start",
} as const;

/** A failed wake as one short line: "Couldn't start · {why}". */
export function couldNotStartText(error: string): string {
  const why = error.replace(/^Couldn't start(?: it)?[:.]?\s*/i, "").replace(/\.$/, "").trim();
  return why ? `${SITE_PREVIEW_STATUS_TEXT.couldNotStart} · ${why}` : SITE_PREVIEW_STATUS_TEXT.couldNotStart;
}

/** What the runtime store already knows: `tunnel.*` and runtime events land there at once. */
function useStoreSignals(previewId: string, runtimeId: string | null) {
  const runtime = useOptionalRuntimeState();
  const tunnelGrants = runtime?.tunnelGrants;
  const runtimeStatuses = runtime?.runtimeStatuses;
  const grant = useMemo(
    () => Object.values(tunnelGrants ?? {}).find((entry) => entry.id === previewId || entry.tunnelId === previewId) ?? null,
    [previewId, tunnelGrants],
  );
  const runtimeEntry = runtimeId ? runtimeStatuses?.find((entry) => entry.runtimeId === runtimeId) ?? null : null;
  return {
    grantStatus: grant?.status ? grant.status.toLowerCase() : null,
    runtimeStatus: runtimeEntry?.status ? runtimeEntry.status.toLowerCase() : null,
    runs: runtime?.runs ?? null,
  };
}

/**
 * Calls `onEnded` when a turn in the space ends that this card saw running. Octo stops a site's server with a command,
 * which sends no event, so the end of the turn is the first moment anything can tell.
 */
function useTurnEnded(runs: Record<string, RunRecord> | null, onEnded: () => void) {
  const ended = useRef(onEnded);
  ended.current = onEnded;
  const running = useRef(new Map<string, boolean>());
  useEffect(() => {
    let news = false;
    for (const run of Object.values(runs ?? {})) {
      const done = ENDED_RUN_STATUSES.has(run.status);
      if (done && running.current.get(run.id) === true) news = true;
      running.current.set(run.id, !done);
    }
    if (news) ended.current();
  }, [runs]);
}

/**
 * Octo's preview card for a site running in the space, drawn as a link
 * preview (SitePreviewCardView). It names the site, says when it is not
 * simply live, and opens it in the conversation's side pane on a press,
 * through ConversationPreviewContext as a chat link opens a file. It never
 * opens by itself, not even when it is new, and holds no URL.
 */
export function SitePreviewCard({
  preview,
  projectId,
  postedAt = 0,
  messageKey = "",
}: {
  preview: SitePreviewRequest;
  projectId: string | null;
  /** When the card's message was posted: of several cards for one site, the latest is drawn in full. */
  postedAt?: number;
  /** The card's message id. */
  messageKey?: string;
}) {
  const opener = useConversationPreviewOpener();
  const [server, setServer] = useState<ControllerSitePreview | null>(null);
  const [gone, setGone] = useState(false);
  // Failed checks in a row, and whether the controller said it will not answer.
  const [failures, setFailures] = useState(0);
  const [cannotCheck, setCannotCheck] = useState(false);
  // Whether the follow-up checks made while the pane was not on screen (counted
  // per preview, in cardsByPreview) ran out.
  const [followsSpent, setFollowsSpent] = useState(false);
  const signals = useStoreSignals(preview.previewId, server?.runtimeId ?? null);
  const request = useRef<AbortController | null>(null);
  // Whether this is the card that follows its preview for every card of it.
  const [leads, setLeads] = useState(false);
  // Whether this is the latest card posted for its preview on the page (drawn in full).
  const [latest, setLatest] = useState(true);
  const member = useMemo<CardMember>(() => ({
    read: (answer) => {
      if ("gone" in answer) {
        setGone(true);
        return;
      }
      setServer(answer.preview);
      setGone(false);
      setFailures(0);
      setCannotCheck(false);
    },
    setLeads,
    setLatest,
    wants: false,
    postedAt: Number.isFinite(postedAt) ? postedAt : 0,
    messageKey,
    // A card's message keeps its time and id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);
  useEffect(() => joinPreviewCards(preview.previewId, member), [member, preview.previewId]);

  // `fresh`: a new probe of the site, not the controller's answer of a few seconds ago.
  const refresh = useCallback(async (fresh = false) => {
    if (!projectId) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const next = fresh
        ? await getSitePreview(projectId, preview.previewId, controller.signal, { fresh: true })
        : await getSitePreview(projectId, preview.previewId, controller.signal);
      if (controller.signal.aborted) return;
      member.read({ preview: next });
      shareAnswer(preview.previewId, member, { preview: next });
    } catch (error) {
      if (controller.signal.aborted) return;
      const failure = checkFailure(error);
      if (failure === "gone") {
        member.read({ gone: true });
        shareAnswer(preview.previewId, member, { gone: true });
      } else if (failure === "final") setCannotCheck(true);
      else setFailures((count) => count + 1);
    }
  }, [member, preview.previewId, projectId]);

  // Something new happened (a press, a tunnel or runtime event, a turn that
  // ended): every automatic check the card gave up on may answer now, so ask again.
  const renew = useCallback((fresh = false) => {
    setFailures(0);
    setCannotCheck(false);
    const cards = cardsByPreview.get(preview.previewId);
    if (cards) cards.unseenFollows = 0;
    setFollowsSpent(false);
    void refresh(fresh);
  }, [preview.previewId, refresh]);

  // Wake (a model-free restart): `instafy preview open` recorded how to start
  // this site, so Open on a stopped one starts it again without an Octo turn,
  // then opens it. Nothing here knows what the site is.
  const [waking, setWaking] = useState(false);
  // The site answered and its pane opened: the card keeps "Starting…" until
  // the pane shows the page, or for at most SITE_PREVIEW_PAGE_WAIT_MS.
  const [awaitingPage, setAwaitingPage] = useState(false);
  const [wakeError, setWakeError] = useState<string | null>(null);
  const wakeRequest = useRef<AbortController | null>(null);
  useEffect(() => () => wakeRequest.current?.abort(), []);
  const wake = useCallback(async (then: () => void) => {
    if (!projectId || wakeRequest.current) return;
    const controller = new AbortController();
    wakeRequest.current = controller;
    setWaking(true);
    setWakeError(null);
    try {
      const live = await wakeUntilLive({
        signal: controller.signal,
        wake: (signal) => wakeSitePreview(projectId, preview.previewId, signal),
        get: (signal) => getSitePreview(projectId, preview.previewId, signal, { fresh: true }),
        onPreview: (next) => { if (!controller.signal.aborted) member.read({ preview: next }); },
      });
      if (controller.signal.aborted) return;
      if (live) {
        member.read({ preview: live });
        shareAnswer(preview.previewId, member, { preview: live });
      } else renew();
      // A pane already showing the stopped site opens it again now, not at its next check.
      paneChecks.get(preview.previewId)?.();
      setAwaitingPage(true);
      then();
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof PreviewWakeError && cause.gone) member.read({ gone: true });
      setWakeError(cause instanceof PreviewWakeError ? cause.message : "Couldn't start it.");
    } finally {
      if (wakeRequest.current === controller) {
        wakeRequest.current = null;
        setWaking(false);
      }
    }
  }, [member, preview.previewId, projectId, renew]);

  // Until the pane it opened shows the page (or the wait runs out).
  useEffect(() => {
    if (!awaitingPage) return;
    const done = () => setAwaitingPage(false);
    const stopWaiting = waitForSitePreviewPage(preview.previewId, done);
    const timer = window.setTimeout(done, SITE_PREVIEW_PAGE_WAIT_MS);
    return () => {
      stopWaiting();
      window.clearTimeout(timer);
    };
  }, [awaitingPage, preview.previewId]);

  // A failed check is no answer: ask again a few times, more slowly each
  // time and only while the page is visible, then stop.
  useEffect(() => {
    if (!failures || failures > RETRY_DELAYS_MS.length) return;
    let cancelVisible = () => {};
    const timer = window.setTimeout(() => {
      cancelVisible = whenVisible(() => void refresh());
    }, RETRY_DELAYS_MS[failures - 1]);
    return () => {
      window.clearTimeout(timer);
      cancelVisible();
    };
  }, [failures, refresh]);

  useEffect(() => {
    renew();
    return () => request.current?.abort();
  }, [renew]);

  // A tunnel or runtime event for this preview (its grant was revoked, its
  // runtime came back) asks again at once. What the store already showed when
  // the card first checked, or what the controller just said, is no news.
  const serverStatus = server?.status ?? null;
  const seenSignals = useRef({ grantStatus: signals.grantStatus, runtimeStatus: signals.runtimeStatus });
  useEffect(() => {
    const seen = seenSignals.current;
    seenSignals.current = { grantStatus: signals.grantStatus, runtimeStatus: signals.runtimeStatus };
    const grantNews = signals.grantStatus !== seen.grantStatus && signals.grantStatus !== serverStatus;
    const runtimeNews = seen.runtimeStatus !== null && signals.runtimeStatus !== seen.runtimeStatus;
    if (grantNews || runtimeNews) renew();
  }, [renew, serverStatus, signals.grantStatus, signals.runtimeStatus]);

  const unavailable = cannotCheck || failures > 0;
  // A preview is keyed by its machine and port, so a later site on the same
  // port takes over its record: a card whose title the record no longer has
  // is about a site that is not there any more, whatever the record says.
  const replaced = server !== null && sitePreviewCardTitle(server.title) !== preview.title;
  const state = sitePreviewState({
    preview: server,
    gone: gone || replaced,
    unavailable,
    grantStatus: signals.grantStatus,
    runtimeStatus: signals.runtimeStatus,
  });
  const showing = state !== "stopped" && opener?.visiblePreviewId === preview.previewId;
  // Stopped, or nothing answers (Octo stopped its server): to the person, either way the site is stopped.
  const down = state === "stopped" || state === "not_responding";
  // Only a record that says how to start the site can be woken; a preview that is gone cannot.
  const wakeable = server?.restartable === true && !gone && !replaced;
  // Starting its stopped machine takes someone who may change the space: others see why before they press Open.
  const startBlocked = wakeable && down && server?.canStart === false;
  // Someone else (another member, another tab) is waking it: follow along.
  const wakingElsewhere = !waking && !replaced && server?.wake?.state === "waking";
  const starting = waking || wakingElsewhere || awaitingPage;
  // The site came back some other way (Octo restarted it, someone else woke it): the failure is old news.
  useEffect(() => { if (state === "live" && wakeError && !waking) setWakeError(null); }, [state, wakeError, waking]);

  // While its pane is on screen, the card reads the pane's own checks of the
  // site (shareSitePreviewRecord), so it never reads Live beside a site that
  // stopped answering and asks nothing itself. A card whose site has no
  // settled state keeps asking for a while, so it sees the site come up, and
  // one follows a wake someone else started. Only the newest card for the
  // preview asks; the others read its answers. Nothing follows while a failed
  // check is being retried or after the controller said it will not answer.
  const settled = state === "live" || state === "stopped";
  const wantsToFollow = !failures && !cannotCheck && !gone &&
    (wakingElsewhere || (!showing && !settled && !followsSpent));
  useEffect(() => setWantsToFollow(preview.previewId, member, wantsToFollow), [member, preview.previewId, wantsToFollow]);
  const following = leads && wantsToFollow;
  useEffect(() => {
    if (!following) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      if (!showing) {
        const cards = cardsByPreview.get(preview.previewId);
        if (!cards || cards.unseenFollows >= MAX_UNSEEN_FOLLOWS) {
          window.clearInterval(timer);
          setFollowsSpent(true);
          return;
        }
        cards.unseenFollows += 1;
      }
      void refresh();
    }, wakingElsewhere ? SITE_PREVIEW_WAKE_FOLLOW_MS : SITE_PREVIEW_FOLLOW_MS);
    return () => window.clearInterval(timer);
  }, [following, preview.previewId, refresh, showing, wakingElsewhere]);

  // A turn ended: Octo may have stopped, restarted or replaced the site in it,
  // and a stopped server sends no event. The latest card for the preview asks
  // for a new probe at once (the pane does, when it is on screen), and every
  // card reads the answer, so none still looks live after "stop the preview".
  useTurnEnded(signals.runs, () => {
    if (!latest) return;
    const paneCheck = showing ? paneChecks.get(preview.previewId) : undefined;
    if (paneCheck) paneCheck();
    else renew(true);
  });

  // Follow mode: who presents this site now (events keep it current; one look when the card first reads Live).
  const followEntry = useFollowEntry(preview.previewId);
  const selfId = useFollowAccount();
  const askedFollow = useRef(false);
  useEffect(() => {
    if (!projectId || state !== "live" || askedFollow.current) return;
    askedFollow.current = true;
    const controller = new AbortController();
    void getFollowState(projectId, preview.previewId, controller.signal)
      .then((snapshot) => { if (!controller.signal.aborted) setFollowPresence(preview.previewId, snapshot.presence); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [preview.previewId, projectId, state]);
  // A stopped site has nothing to follow.
  const followPresence = down ? null : followEntry.presence;
  // My own presentation from another screen: never "Follow" myself.
  const mine = Boolean(selfId && followPresence?.presenter.id === selfId);
  const followable = Boolean(followPresence) && !mine && followEntry.role !== "presenting" && followEntry.role !== "following";
  const watching = followPresence?.followers ? ` · ${followPresence.followers} watching` : "";
  const followLine = !followPresence ? null
    : followEntry.role === "presenting" ? `You're presenting${watching}`
      : mine ? `You're presenting on another screen${watching}`
        : `${followPresence.presenter.name} ${followPresence.state === "away" ? "is away" : "is presenting"}${watching}`;

  // The preview comes from the stored card, parsed once: nothing a press
  // carries is trusted. Opening only selects the conversation's view; the
  // pane mints its own viewer session.
  const openNow = useCallback(() => {
    opener?.openPreview({ previewId: preview.previewId, title: preview.title });
  }, [opener, preview.previewId, preview.title]);
  const open = () => {
    // A stopped site that can be started: start it, then open it.
    if (down && wakeable) { if (!startBlocked) void wake(openNow); return; }
    renew();
    openNow();
  };

  // A check that has not answered for a while says so; most answer before anyone notices.
  const [checkingLong, setCheckingLong] = useState(false);
  useEffect(() => {
    if (state !== "checking") {
      setCheckingLong(false);
      return;
    }
    const timer = window.setTimeout(() => setCheckingLong(true), SITE_PREVIEW_CHECKING_QUIET_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  // A new picture of the site (`instafy preview open` or `check` took one): the latest card asks again, and every
  // card for the preview reads the answer.
  const thumbnailVersion = server?.thumbnail?.version ?? null;
  useEffect(() => {
    if (!latest || typeof window === "undefined") return;
    const onPicture = (event: Event) => {
      const detail = (event as CustomEvent<SitePreviewThumbnailEventDetail | null>).detail;
      if (detail?.previewId === preview.previewId && detail.version !== thumbnailVersion) renew();
    };
    window.addEventListener(SITE_PREVIEW_THUMBNAIL_EVENT, onPicture);
    return () => window.removeEventListener(SITE_PREVIEW_THUMBNAIL_EVENT, onPicture);
  }, [latest, preview.previewId, renew, thumbnailVersion]);

  // What the record says about the site (picture, facts) belongs to this card only while the record is still this
  // site's: a preview that is gone has none, and a later site on the same port must not lend this card its picture.
  const record = gone || replaced ? null : server;
  // The picture, with this person's own session, once the card is near the screen. Never a signed URL or a frame.
  const thumbnail = record?.thumbnail ?? null;
  const [pictureRef, near] = useNearViewport();
  const pictureKey = `preview-picture:${preview.previewId}:${thumbnail?.version ?? "none"}`;
  const { state: picture } = useAuthorizedImage(
    pictureKey,
    () => projectId && thumbnail
      ? getSitePreviewThumbnail(projectId, preview.previewId, thumbnail.version)
      : Promise.resolve({ ok: false, reason: "refused" } as const),
    Boolean(projectId && thumbnail && near && latest),
  );
  const pictureGone = picture.status === "unavailable" || picture.status === "failed";

  // Only an answer (a record, or the preview being gone) says a press cannot
  // start it; before one, "ask Octo" could send someone to spend a turn on a
  // site a press would have started.
  const stoppedText = !wakeable
    ? server || gone ? SITE_PREVIEW_STATUS_TEXT.stoppedAskOcto : SITE_PREVIEW_STATUS_TEXT.stopped
    : startBlocked
      ? SITE_PREVIEW_STATUS_TEXT.stoppedNeedsBuilder
      : SITE_PREVIEW_STATUS_TEXT.stoppedRestarts;
  let status: SitePreviewCardStatus | null = null;
  let pictureTone: SitePreviewCardViewProps["pictureTone"] = "normal";
  if (starting) {
    status = { text: SITE_PREVIEW_STATUS_TEXT.starting, busy: true };
    pictureTone = "dim";
  } else if (wakeError === START_NEEDS_BUILDER_TEXT) {
    status = { text: SITE_PREVIEW_STATUS_TEXT.stoppedNeedsBuilder };
    pictureTone = "gray";
  } else if (wakeError) {
    status = { text: couldNotStartText(wakeError) };
    pictureTone = "gray";
  } else if (down) {
    status = { text: stoppedText };
    pictureTone = "gray";
  } else if (state === "unavailable") {
    status = { text: SITE_PREVIEW_STATUS_TEXT.unavailable };
  } else if (state === "checking" && checkingLong) {
    status = { text: SITE_PREVIEW_STATUS_TEXT.checking };
  }
  // A card that can do nothing on a press does not look pressable.
  const pressable = Boolean(opener) && !starting && !(down && (!wakeable || startBlocked)) &&
    !(wakeError === START_NEEDS_BUILDER_TEXT);

  const actions: SitePreviewCardAction[] = [];
  if (opener && followable && followPresence) {
    // The pane follows as soon as it is open and knows the presentation.
    actions.push({
      id: "follow-preview", label: `Follow ${followPresence.presenter.name}`, testId: "preview-ready-follow",
      onPress: () => { requestFollow(preview.previewId); open(); },
    });
  }

  // An earlier card for a site Octo opened again: the latest one, further down, is the one to use.
  if (!latest) {
    return (
      <Text
        as="div"
        variant="caption"
        tone="muted"
        className="inline-flex items-center gap-1.5"
        data-testid="preview-ready-earlier"
      >
        <WebWindow className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {`${preview.title} · opened again further down`}
      </Text>
    );
  }

  return (
    <SitePreviewCardView
      title={preview.title}
      facts={sitePreviewFacts(record)}
      picture={thumbnail && !pictureGone ? { url: picture.status === "ready" ? picture.url : null } : null}
      pictureTone={pictureTone}
      visibility={server?.visibility === "private" ? "private" : null}
      status={status}
      state={state}
      wake={starting ? "waking" : wakeError ? "failed" : undefined}
      pressable={pressable}
      busy={starting}
      onOpen={open}
      followLine={followLine}
      actions={actions}
      pictureRef={pictureRef}
    />
  );
}
