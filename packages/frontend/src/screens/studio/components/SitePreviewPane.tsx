import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { OpenNewWindow, Refresh } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { Spinner } from "../../../components/Spinner";
import { Text } from "../../../components/Text";
import {
  createSitePreviewViewer,
  getSitePreview,
  heartbeatSitePreviewViewer,
  isSitePreviewRateLimited,
  revokeSitePreviewViewer,
  sitePreviewProblem,
  sitePreviewShownState,
  wakeSitePreview,
  type SitePreviewProblem,
  type SitePreviewShownState,
} from "../../../services/runtimeController/previews";
import { useBreakpoint } from "../../../hooks/useBreakpoint";
import { reserveExternalWindow } from "../../../utils/openExternalUrl";
import { BrowserChromeShell, BrowserStatusPill } from "./BrowserChromeShell";
import { withHostQuery } from "./previewHost/hostMessages";
import { useSiteHost, type SiteMessageEvent, type SiteRecord } from "./previewHost/useSiteHost";
import { setLocationStopped } from "./previewHost/locationSites";
import { LocationBarControl, LocationBlockedNotice, LocationToast } from "./previewHost/PreviewLocation";
import { followLabels } from "./previewHost/followMode";
import { FollowRing, FollowRipples, FollowToast, SitePreviewFollowControls } from "./previewHost/FollowControls";
import { AskConfirmStrip } from "./previewHost/AskConfirmStrip";
import type { SiteAskHost } from "./previewHost/useSiteAsks";
import { PreviewWakeError, START_NEEDS_BUILDER_TEXT, wakeUntilLive } from "./sitePreviewWake";
import { holdSitePreviewPage, registerSitePreviewPaneCheck, shareSitePreviewPageShown, shareSitePreviewRecord } from "./SitePreviewCard";

export const SITE_PREVIEW_HEALTH_POLL_MS = 15_000;
/** While the frame is on screen: keeps a quiet site's session alive. */
export const SITE_PREVIEW_HEARTBEAT_MS = 60_000;
export const SITE_PREVIEW_FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads";
export const SITE_PREVIEW_FRAME_ALLOW = "fullscreen; clipboard-write";

/**
 * The status message the pane reads from its frame. The broker's error pages
 * report their status with it, but any page on this preview's origin can send
 * it, the site itself included. Everything else from the frame goes to the
 * site host channel (previewHost/useSiteHost): the layout handshake, location
 * requests and follow mode, read as data, never as commands.
 */
export const SITE_PREVIEW_MESSAGE_TYPE = "instafy-preview";

/** `busy`: the controller refused a new session because too many were opened in the last minute. */
type SessionState = "opening" | "ready" | "ended" | "busy" | SitePreviewProblem;

/**
 * What the pane says from the record, as the card does (a tunnel not active
 * yet, or one the broker could not probe, reads Checking and the frame stays,
 * so the person sees for themselves), or why it could not ask.
 */
type HealthState = SitePreviewShownState | Exclude<SitePreviewProblem, "unavailable">;
export type SitePreviewPaneState = "opening" | "ended" | "busy" | "starting" | HealthState | SitePreviewProblem;

const UNAVAILABLE_TEXT = "Previews are not available here";
const POPUP_BLOCKED_TEXT = "Your browser blocked the new tab. Allow pop-ups for this site and try again.";
const BUSY_TEXT = "Too many previews were opened just now. Wait a minute and try again.";

/** The panes kept mounted in one conversation's view scope. */
export type MountedSitePreviews = { scope: string | null; ids: readonly string[] };
export const NO_MOUNTED_SITE_PREVIEWS: MountedSitePreviews = { scope: null, ids: [] };

/**
 * Which panes stay mounted: each one from the first time it is on screen until
 * its tab closes, and none carried over from another conversation's scope.
 * Returns `current` itself when nothing changed.
 */
export function nextMountedSitePreviews(current: MountedSitePreviews, scope: string | null, openPreviewIds: readonly string[], shownPreviewId: string | null): MountedSitePreviews {
  const sameScope = current.scope === scope;
  const previous = sameScope ? current.ids : [];
  const kept = previous.filter(id => openPreviewIds.includes(id));
  const add = shownPreviewId && openPreviewIds.includes(shownPreviewId) && !kept.includes(shownPreviewId);
  if (sameScope && !add && kept.length === previous.length) return current;
  return { scope, ids: add ? [...kept, shownPreviewId] : kept };
}

/**
 * What the pane says in place of a site that stopped, or stopped answering (to the person, both are stopped): one
 * line, and Start again where the record knows how to start it. It comes back by itself once it answers again.
 */
const STOPPED_TEXT = "This site is stopped.";
const STOPPED_ASK_OCTO_TEXT = `${STOPPED_TEXT} Ask Octo to start it again.`;

type ProblemText = { title: string; body: string; reload: boolean };

/** What the pane says in place of the site otherwise. Reload is offered only where asking again can help. */
const PROBLEM_TEXT = {
  missing: { title: "This preview no longer exists", body: "It was closed. Ask Octo to open the site again.", reload: false },
  no_access: { title: "You can't open this preview", body: "You may no longer have access to it.", reload: false },
  ended: { title: "This preview session ended", body: "Reload to open a new session.", reload: true },
  busy: { title: "Too many previews opened", body: "Too many previews were opened just now. Wait a minute, then reload.", reload: true },
  unavailable: { title: UNAVAILABLE_TEXT, body: "This server does not offer site previews.", reload: false },
} satisfies Record<Exclude<SitePreviewPaneState, "opening" | "starting" | "checking" | "live" | "not_responding" | "stopped">, ProblemText>;

function problemText(state: SitePreviewPaneState): ProblemText | null {
  return (PROBLEM_TEXT as Partial<Record<SitePreviewPaneState, ProblemText>>)[state] ?? null;
}

/** The pill's words while the site is on its way or there; in place of the site, the pane's message says the rest. */
const PILL_DETAIL: Partial<Record<SitePreviewPaneState, string>> = { opening: "Opening", starting: "Starting", checking: "Checking", live: "Live" };

/**
 * One running site in a conversation's side pane, inside upstream's browser bar.
 *
 * The viewer address is a member-only capability. It is minted when the pane
 * mounts, lives only in this component's memory (never stored, logged or shown;
 * the bar shows the title) and is revoked when the pane unmounts, which is what
 * the tab's × does, and when Studio itself is closed or reloaded (`pagehide`,
 * which does not unmount anything).
 *
 * Open in new tab is different: it mints a separate session for a top-level
 * tab, so that address is a bearer link. It shows in that tab's address bar
 * and history, anyone it is copied to can open the site with it, it is kept
 * alive by the tab's own traffic up to the controller's maximum session age
 * (12 hours), and closing the pane does not end it.
 *
 * The frame can tell the pane one thing: `{type: "instafy-preview", status}`,
 * read only from this frame's window and this capability's origin. The
 * broker's error pages send it, but so can any page on that origin, the site
 * itself included, so the worst a message can do is end or relabel this one
 * pane. A 401 (the session idled out or was revoked) and a 410 from the
 * heartbeat each mint one new session; a second loss in a row ends it, so a
 * removed member never loops. Showing the pane again allows one more.
 */
export function SitePreviewPane({ projectId, previewId, title, visible, spaceName = null, asks = null }: {
  projectId: string;
  previewId: string;
  title: string;
  /** On screen now: health polls and heartbeats run only while it is. */
  visible: boolean;
  /** The space's name, for the list of sites that received the person's location. */
  spaceName?: string | null;
  /** Ask Octo from the site, as the person's own message in this conversation; null where asks are not taken. */
  asks?: SiteAskHost | null;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [session, setSession] = useState<SessionState>("opening");
  const [health, setHealth] = useState<HealthState>("checking");
  /** The record's title, port and path: what keys this site for location. */
  const [record, setRecord] = useState<SiteRecord | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  /** The frame the site's page last loaded in (its key and address); until then the pane says "Loading…". */
  const [loadedFrame, setLoadedFrame] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [openingTab, setOpeningTab] = useState(false);
  /** The record says how to start the site again (`instafy preview open` recorded it); null until a record says. */
  const [restartable, setRestartable] = useState<boolean | null>(null);
  /** False when the person may not start the stopped machine (the controller says so up front). */
  const [canStart, setCanStart] = useState<boolean | null>(null);
  const [waking, setWaking] = useState(false);
  /** The wake under way, aborted when the pane closes or shows another preview. */
  const wakeRequest = useRef<AbortController | null>(null);
  const live = useRef<string | null>(null);
  const reminted = useRef(false);
  const mounted = useRef(true);
  const mintAttempt = useRef(0);
  const wasVisible = useRef(visible);
  const beatWhenShown = useRef(false);
  /** The site host channel's reader, set once the hook below has run. */
  const siteMessage = useRef<(event: SiteMessageEvent) => boolean>(() => false);

  const revoke = useCallback((url: string | null) => {
    if (url) void revokeSitePreviewViewer(projectId, previewId, url).catch(() => undefined);
  }, [previewId, projectId]);

  const mint = useCallback(async () => {
    const attempt = ++mintAttempt.current;
    setSession("opening");
    try {
      const viewer = await createSitePreviewViewer(projectId, previewId);
      // A superseded or unmounted mint must not leave a live capability behind.
      if (!mounted.current || attempt !== mintAttempt.current) { revoke(viewer.viewerUrl); return; }
      live.current = viewer.viewerUrl;
      setViewerUrl(viewer.viewerUrl);
      setSession("ready");
    } catch (cause) {
      if (!mounted.current || attempt !== mintAttempt.current) return;
      const problem = sitePreviewProblem(cause);
      if (problem) {
        // The controller just said the site stopped: a Live health read before
        // it is no sign the site is back, so only a later read may reopen it.
        // Otherwise each refusal re-mints at once, until the rate limit says
        // "Too many previews opened".
        if (problem === "stopped") setHealth("stopped");
        setSession(problem);
        return;
      }
      if (isSitePreviewRateLimited(cause)) { setSession("busy"); return; }
      setSession("ended");
      setFeedback(cause instanceof Error ? cause.message : "Could not open the preview.");
    }
  }, [previewId, projectId, revoke]);

  /** Ends the current capability and mints the next one. */
  const replaceSession = useCallback(() => {
    revoke(live.current);
    live.current = null;
    setViewerUrl(null);
    void mint();
  }, [mint, revoke]);

  /** The capability stopped working: one new session, then give up. */
  const sessionLost = useCallback(() => {
    if (reminted.current) {
      revoke(live.current);
      live.current = null;
      setViewerUrl(null);
      setSession("ended");
      return;
    }
    reminted.current = true;
    replaceSession();
  }, [replaceSession, revoke]);

  useEffect(() => {
    mounted.current = true;
    reminted.current = false;
    void mint();
    return () => {
      mounted.current = false;
      mintAttempt.current += 1;
      revoke(live.current);
      live.current = null;
    };
  }, [mint, revoke]);

  // Closing or reloading Studio does not unmount the pane, so its session is revoked as the page goes
  // (keepalive lets that request finish after it); otherwise each reload would leave one live until it
  // idles out, and the controller's per-person cap would start ending the person's other sessions.
  // A page restored from the back-forward cache opens a new session.
  useEffect(() => {
    let revokedOnHide = false;
    const onPageHide = () => {
      revokedOnHide = true;
      mintAttempt.current += 1; // A mint still in flight is revoked when it lands.
      const url = live.current;
      live.current = null;
      if (url) void revokeSitePreviewViewer(projectId, previewId, url, { keepalive: true }).catch(() => undefined);
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted || !revokedOnHide) return;
      revokedOnHide = false;
      reminted.current = false;
      replaceSession();
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [previewId, projectId, replaceSession]);

  const checkHealth = useCallback(async (signal?: AbortSignal, fresh = false) => {
    try {
      const preview = await getSitePreview(projectId, previewId, signal, fresh ? { fresh } : undefined);
      if (signal?.aborted || !mounted.current) return;
      // The cards of this preview read it too, instead of asking themselves.
      shareSitePreviewRecord(previewId, preview);
      setRecord(current => current && current.title === preview.title && current.port === preview.port && current.path === preview.path
        ? current : { title: preview.title, port: preview.port, path: preview.path });
      setRestartable(preview.restartable === true);
      setCanStart(preview.canStart ?? null);
      setHealth(sitePreviewShownState(preview));
    } catch (cause) {
      if (signal?.aborted || !mounted.current) return;
      const problem = sitePreviewProblem(cause);
      if (problem && problem !== "unavailable") setHealth(problem);
    }
  }, [previewId, projectId]);

  // A preview that is gone or forbidden stays so: nothing more is asked until Reload.
  const healthSettled = health === "missing" || health === "no_access";
  // A session refused because the site stopped keeps asking too: the site may
  // come back (Octo restarted it, someone woke it), and then the pane opens it.
  const sessionWaits = session === "ready" || session === "stopped";
  useEffect(() => {
    if (!visible || !sessionWaits || healthSettled) return;
    const controller = new AbortController();
    const tick = () => { if (document.visibilityState !== "hidden") void checkHealth(controller.signal); };
    tick();
    const timer = window.setInterval(tick, SITE_PREVIEW_HEALTH_POLL_MS);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [checkHealth, healthSettled, sessionWaits, visible]);
  // While on screen, the cards of this preview have the pane check the site (a turn ended, a card started it), so
  // the two never read it two ways.
  useEffect(() => {
    if (!visible || !sessionWaits || healthSettled) return;
    return registerSitePreviewPaneCheck(previewId, () => { void checkHealth(undefined, true); });
  }, [checkHealth, healthSettled, previewId, sessionWaits, visible]);

  // The site answers again while this pane's session was refused as stopped:
  // open a new session, once each time the record turns live.
  const recovered = useRef(false);
  useEffect(() => {
    if (session !== "stopped" || health !== "live" || !visible) { recovered.current = false; return; }
    if (recovered.current || waking) return;
    recovered.current = true;
    reminted.current = false;
    replaceSession();
  }, [health, replaceSession, session, visible, waking]);

  // Closing the pane, or showing another preview in it, ends a wake it follows: no more polls for it.
  useEffect(() => () => {
    wakeRequest.current?.abort();
    wakeRequest.current = null;
  }, [previewId, projectId]);

  /** "Start again": the model-free wake the card uses, then a fresh session. */
  const wakeSite = useCallback(async () => {
    if (waking || wakeRequest.current) return;
    const controller = new AbortController();
    wakeRequest.current = controller;
    setWaking(true);
    setFeedback(null);
    try {
      await wakeUntilLive({
        signal: controller.signal,
        wake: signal => wakeSitePreview(projectId, previewId, signal),
        get: signal => getSitePreview(projectId, previewId, signal, { fresh: true }),
      });
      if (!mounted.current || controller.signal.aborted) return;
      reminted.current = false;
      setHealth("checking");
      replaceSession();
      void checkHealth(undefined, true);
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) {
        setFeedback(cause instanceof PreviewWakeError ? cause.message : "Couldn't start it.");
      }
    } finally {
      if (wakeRequest.current === controller) wakeRequest.current = null;
      if (mounted.current) setWaking(false);
    }
  }, [checkHealth, previewId, projectId, replaceSession, waking]);

  // Shown again after being hidden: the session may have idled out meanwhile,
  // so check it at once, and allow one more re-mint.
  useEffect(() => {
    if (visible && !wasVisible.current) { reminted.current = false; beatWhenShown.current = true; }
    wasVisible.current = visible;
  }, [visible]);

  const shown: SitePreviewPaneState = waking ? "starting" : session === "ready" ? health : session === "stopped" && health === "not_responding" ? "stopped" : session;
  const down = shown === "stopped" || shown === "not_responding";
  // The controller says who may start it: a stopped machine needs someone who may change the space; a site that
  // stopped answering on a running one restarts for anyone who may view it.
  const startBlocked = down && canStart === false;
  // A site that stopped answering has no frame: its frame would hold the broker's error page, showing through the
  // pane's own message, and still showing once the site is back. The frame loads again when it answers.
  const frameShown = Boolean(viewerUrl) && session === "ready" && (shown === "checking" || shown === "live");
  const frameOnScreen = visible && frameShown;
  const host = useSiteHost({
    frame, viewerUrl: frameShown ? viewerUrl : null, frameKey, projectId, previewId, frameOnScreen, record, title, spaceName, asks,
    onError: message => { if (mounted.current) setFeedback(message); },
  });
  siteMessage.current = host.handleSiteMessage;
  const follow = host.follow;
  const followLine = followLabels(follow.state);
  const followNote = followLine.note;
  useEffect(() => {
    if (!frameOnScreen || !viewerUrl) return;
    const controller = new AbortController();
    const beat = async () => {
      if (document.visibilityState === "hidden") return;
      let result: "live" | "gone";
      try {
        result = await heartbeatSitePreviewViewer(projectId, previewId, viewerUrl, controller.signal);
      } catch {
        return; // A passing network or server error: the next beat tries again.
      }
      if (controller.signal.aborted || live.current !== viewerUrl) return;
      if (result === "live") { reminted.current = false; return; }
      sessionLost();
    };
    if (beatWhenShown.current) { beatWhenShown.current = false; void beat(); }
    const timer = window.setInterval(() => { void beat(); }, SITE_PREVIEW_HEARTBEAT_MS);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [frameOnScreen, previewId, projectId, sessionLost, viewerUrl]);

  useEffect(() => {
    if (!viewerUrl) return;
    let origin: string;
    try { origin = new URL(viewerUrl).origin; } catch { return; }
    const onMessage = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow || event.origin !== origin) return;
      const data = event.data as { type?: unknown; status?: unknown } | null;
      if (!data || typeof data !== "object") return;
      if (data.type !== SITE_PREVIEW_MESSAGE_TYPE || typeof data.status !== "number") { siteMessage.current(event); return; }
      if (data.status === 401) { sessionLost(); return; }
      if (data.status >= 502 && data.status <= 504) setHealth("not_responding");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [sessionLost, viewerUrl]);

  const reload = useCallback(() => {
    setFeedback(null);
    if (session === "ready" && viewerUrl) {
      setHealth("checking");
      setFrameKey(value => value + 1);
      void checkHealth(undefined, true);
      return;
    }
    // A stopped, ended or unavailable pane asks again; the person pressed Reload.
    reminted.current = false;
    setHealth("checking");
    replaceSession();
  }, [checkHealth, replaceSession, session, viewerUrl]);

  /** Synchronous up to the reservation: the tab opens while the browser still counts the press. */
  const openInNewTab = useCallback(() => {
    if (openingTab) return;
    setFeedback(null);
    const tab = reserveExternalWindow();
    // Nothing is minted for a tab the browser refused, so no session is left unused.
    if (tab.blocked) { setFeedback(POPUP_BLOCKED_TEXT); return; }
    setOpeningTab(true);
    void (async () => {
      try {
        // Its own capability, so closing this pane leaves the tab working.
        const viewer = await createSitePreviewViewer(projectId, previewId, { tab: true });
        if (await tab.open(viewer.viewerUrl)) return;
        revoke(viewer.viewerUrl);
        if (mounted.current) setFeedback(POPUP_BLOCKED_TEXT);
      } catch (cause) {
        tab.cancel();
        if (mounted.current) {
          setFeedback(sitePreviewProblem(cause) === "unavailable" ? UNAVAILABLE_TEXT
            : isSitePreviewRateLimited(cause) ? BUSY_TEXT
              : cause instanceof Error ? cause.message : "Could not open the preview.");
        }
      } finally {
        if (mounted.current) setOpeningTab(false);
      }
    })();
  }, [openingTab, previewId, projectId, revoke]);

  // A frame whose page has not loaded is blank (a site that just started can
  // take many seconds): the pane says so instead of showing nothing. A frame
  // that goes (the site stopped answering) loads anew when it comes back, at
  // the same address, so the page it loaded before counts for nothing.
  const frameIdentity = viewerUrl ? `${frameKey}:${viewerUrl}` : null;
  if (!frameShown && loadedFrame !== null) setLoadedFrame(null);
  const frameLoading = frameShown && frameIdentity !== null && loadedFrame !== frameIdentity;
  const onFrameLoad = () => {
    setLoadedFrame(frameIdentity);
    host.onFrameLoad();
  };
  // A card that started the site says "Starting…" until a pane shows its
  // page: this one while it holds the page, or none once it closes.
  const pageShown = frameShown && !frameLoading;
  useLayoutEffect(() => (pageShown ? holdSitePreviewPage(previewId) : undefined), [pageShown, previewId]);
  useEffect(() => () => shareSitePreviewPageShown(previewId), [previewId]);
  const problem = problemText(shown);
  // In place of the site, the pane's message is the one signal: no pill beside it saying the same.
  const problemShown = down || problem !== null;
  // On a phone the bar is one row: Present and Open in new tab sit beside the title, so the site keeps the room a
  // second row of chrome took (a map's panel ended up squeezed under the chat's title, the bar and that row). A follow
  // chip ("Following Kim · Stop") keeps its own row: beside the title it squeezed the title out and pushed Open in new
  // tab off a narrow screen.
  const oneRow = !useBreakpoint("sm") && followLine.status === null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="site-preview-pane" data-state={shown}>
      <BrowserChromeShell
        label={`${title} controls`}
        testId="site-preview-chrome"
        compact={oneRow}
        busy={shown === "opening" || shown === "starting"}
        navigation={
          <IconButton aria-label="Reload" title="Reload" className="max-[540px]:h-10 max-[540px]:w-10" data-testid="site-preview-reload"
            isDisabled={shown === "opening" || shown === "starting"} onPress={reload} radius="full" size="sm" variant="ghost">
            <Refresh className="h-4 w-4" aria-hidden="true" />
          </IconButton>
        }
        address={
          <div className="flex h-8 min-w-0 items-center px-2 text-sm text-slate-900 dark:text-slate-100">
            <span className="min-w-0 truncate font-medium" data-testid="site-preview-title" title={title}>{title}</span>
          </div>
        }
        status={<>
          <LocationBarControl site={host.location.site} status={host.location.status} />
          <SitePreviewFollowControls follow={follow} supportsView={host.supportsView && frameOnScreen} />
          {/* While opening or starting, the pane's own line is the one loading signal on screen. */}
          {problemShown ? null : (
            <BrowserStatusPill state={shown === "live" ? "ready" : "starting"} detail={PILL_DETAIL[shown] ?? null} testId="site-preview-status"
              startingShownInView={shown === "opening" || shown === "starting"} />
          )}
        </>}
        actions={
          <IconButton aria-label="Open in new tab" title="Open in new tab" className="max-[540px]:h-10 max-[540px]:w-10" data-testid="site-preview-open-tab"
            isDisabled={session !== "ready" || openingTab} onPress={openInNewTab} radius="full" size="sm" variant="ghost">
            <OpenNewWindow className="h-4 w-4" aria-hidden="true" />
          </IconButton>
        }
        feedback={feedback}
        feedbackTestId="site-preview-feedback"
        onDismissFeedback={feedback ? () => setFeedback(null) : null}
      />
      <div className="relative min-h-0 flex-1 bg-white dark:bg-[var(--color-studio-dark-canvas)]">
        {frameShown && viewerUrl ? (
          <iframe
            key={frameKey}
            ref={frame}
            src={withHostQuery(viewerUrl)}
            title={title}
            sandbox={SITE_PREVIEW_FRAME_SANDBOX}
            allow={SITE_PREVIEW_FRAME_ALLOW}
            referrerPolicy="no-referrer"
            className="h-full w-full border-0"
            data-testid="site-preview-frame"
            onLoad={onFrameLoad}
          />
        ) : null}
        {frameShown && follow.state.role === "following" ? <FollowRing /> : null}
        {frameShown ? <FollowRipples ripples={follow.ripples} /> : null}
        {host.location.blocked ? <LocationBlockedNotice onDismiss={host.location.dismissBlocked} /> : null}
        {host.askConfirm ? <AskConfirmStrip line={host.askConfirm.line} onSend={host.askConfirm.send} onCancel={host.askConfirm.cancel} /> : null}
        {host.location.toast && host.location.site ? (
          <LocationToast title={host.location.site.title} onDismiss={host.location.dismissToast}
            onStop={() => { if (host.location.site) setLocationStopped(host.location.site, true); host.location.dismissToast(); }} />
        ) : followNote ? <FollowToast text={followNote} />
          : follow.locationLeftOut && follow.state.role === "presenting" ? <FollowToast text="📍 Your location is left out" testId="follow-location-toast" /> : null}
        {shown === "opening" || shown === "starting" || frameLoading ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-sm text-slate-500 dark:text-slate-400" data-testid="site-preview-progress">
            <Spinner aria-hidden="true" tone="slate" size="sm" />{" "}
            {shown === "starting" ? `Starting ${title}…` : shown === "opening" ? `Opening ${title}…` : "Loading…"}
          </div>
        ) : null}
        {problemShown ? (
          <div className="absolute inset-0 flex items-center justify-center bg-white p-6 dark:bg-[var(--color-studio-dark-canvas)]" data-testid="site-preview-problem">
            {down ? (
              <div className="max-w-sm space-y-3 text-center">
                <Text as="div" variant="body" tone="primary" role="status" aria-live="polite">
                  {/* Until a record says whether Start again can work, nothing more than what is true. */}
                  {restartable === false ? STOPPED_ASK_OCTO_TEXT : restartable && startBlocked ? `${STOPPED_TEXT} ${START_NEEDS_BUILDER_TEXT}` : STOPPED_TEXT}
                </Text>
                {restartable && !startBlocked ? (
                  // Started the way it was opened: no Octo turn, no message.
                  <Button variant="primary" size="sm" radius="full" data-testid="site-preview-wake" onPress={() => void wakeSite()}>Start again</Button>
                ) : null}
              </div>
            ) : problem ? (
              <div className="max-w-sm space-y-3 text-center" role="status" aria-live="polite">
                <Text as="div" variant="bodyStrong" tone="primary">{problem.title}</Text>
                <Text as="div" variant="caption" tone="muted">{problem.body}</Text>
                {problem.reload ? (
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <Button variant="outline" size="sm" radius="full" onPress={reload}>Reload</Button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
