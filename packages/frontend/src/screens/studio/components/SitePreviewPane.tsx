import { useCallback, useEffect, useRef, useState } from "react";
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
import { reserveExternalWindow } from "../../../utils/openExternalUrl";
import { BrowserChromeShell, BrowserStatusPill, type BrowserChromeState } from "./BrowserChromeShell";
import { withHostQuery } from "./previewHost/hostMessages";
import { useSiteHost, type SiteMessageEvent, type SiteRecord } from "./previewHost/useSiteHost";
import { setLocationStopped } from "./previewHost/locationSites";
import { LocationBarControl, LocationBlockedNotice, LocationToast } from "./previewHost/PreviewLocation";
import { followLabels } from "./previewHost/followMode";
import { FollowRing, FollowRipples, FollowToast, SitePreviewFollowControls } from "./previewHost/FollowControls";
import { PreviewWakeError, wakeUntilLive } from "./sitePreviewWake";

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

/** What the pane says in place of the site. Reload is offered only where asking again can help. */
const PROBLEM_TEXT: Record<Exclude<SitePreviewPaneState, "opening" | "starting" | "checking" | "live">, { title: string | null; body: string; reload: boolean }> = {
  not_responding: { title: null, body: "The site stopped answering. Reload once it is back, or ask Octo to start it again.", reload: true },
  stopped: { title: null, body: "The machine or the site stopped. Ask Octo to start it again.", reload: true },
  missing: { title: "This preview no longer exists", body: "It was closed. Ask Octo to open the site again.", reload: false },
  no_access: { title: "You can't open this preview", body: "You may no longer have access to it.", reload: false },
  ended: { title: "This preview session ended", body: "Reload to open a new session.", reload: true },
  busy: { title: "Too many previews opened", body: "Too many previews were opened just now. Wait a minute, then reload.", reload: true },
  unavailable: { title: UNAVAILABLE_TEXT, body: "This server does not offer site previews.", reload: false },
};

/** A site `instafy preview open` knows how to start: the pane starts it itself, without Octo. */
const WAKE_TEXT: Partial<Record<SitePreviewPaneState, string>> = {
  not_responding: "The site stopped answering. Start it again, or reload once it is back.",
  stopped: "The machine or the site stopped. Start it again to pick up where it was.",
};

function chromeState(state: SitePreviewPaneState): BrowserChromeState {
  if (state === "live") return "ready";
  return state === "opening" || state === "starting" || state === "checking" ? "starting" : "unavailable";
}

function statusDetail(state: SitePreviewPaneState, port: number | null): string | null {
  switch (state) {
    case "opening": return "Opening";
    case "starting": return "Starting";
    case "checking": return "Checking";
    case "live": return "Live";
    case "not_responding": return port ? `Not responding on port ${port}` : "Not responding";
    case "stopped": return "Stopped";
    case "missing": return "Closed";
    case "no_access": return "No access";
    case "ended": return "Session ended";
    case "busy": return "Try again shortly";
    default: return UNAVAILABLE_TEXT;
  }
}

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
export function SitePreviewPane({ projectId, previewId, title, visible, spaceName = null }: {
  projectId: string;
  previewId: string;
  title: string;
  /** On screen now: health polls and heartbeats run only while it is. */
  visible: boolean;
  /** The space's name, for the list of sites that received the person's location. */
  spaceName?: string | null;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [session, setSession] = useState<SessionState>("opening");
  const [health, setHealth] = useState<HealthState>("checking");
  const [port, setPort] = useState<number | null>(null);
  /** The record's title, port and path: what keys this site for location. */
  const [record, setRecord] = useState<SiteRecord | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [openingTab, setOpeningTab] = useState(false);
  /** The record says how to start the site again (`instafy preview open` recorded it). */
  const [restartable, setRestartable] = useState(false);
  const [waking, setWaking] = useState(false);
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
      if (problem) { setSession(problem); return; }
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
      setPort(preview.port);
      setRecord(current => current && current.title === preview.title && current.port === preview.port && current.path === preview.path
        ? current : { title: preview.title, port: preview.port, path: preview.path });
      setRestartable(preview.restartable === true);
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

  /** "Start again": the model-free wake the card uses, then a fresh session. */
  const wakeSite = useCallback(async () => {
    if (waking) return;
    setWaking(true);
    setFeedback(null);
    try {
      await wakeUntilLive({
        wake: signal => wakeSitePreview(projectId, previewId, signal),
        get: signal => getSitePreview(projectId, previewId, signal, { fresh: true }),
      });
      if (!mounted.current) return;
      reminted.current = false;
      setHealth("checking");
      replaceSession();
      void checkHealth(undefined, true);
    } catch (cause) {
      if (mounted.current) setFeedback(cause instanceof PreviewWakeError ? cause.message : "Couldn't start it.");
    } finally {
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
  const frameShown = Boolean(viewerUrl) && session === "ready" && (shown === "checking" || shown === "live" || shown === "not_responding");
  const frameOnScreen = visible && frameShown;
  const host = useSiteHost({
    frame, viewerUrl: frameShown ? viewerUrl : null, frameKey, projectId, previewId, frameOnScreen, record, spaceName,
    onError: message => { if (mounted.current) setFeedback(message); },
  });
  siteMessage.current = host.handleSiteMessage;
  const follow = host.follow;
  const followNote = followLabels(follow.state).note;
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

  const detail = statusDetail(shown, port);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="site-preview-pane" data-state={shown}>
      <BrowserChromeShell
        label={`${title} controls`}
        testId="site-preview-chrome"
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
          <BrowserStatusPill state={chromeState(shown)} detail={detail} testId="site-preview-status" />
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
            onLoad={host.onFrameLoad}
          />
        ) : null}
        {frameShown && follow.state.role === "following" ? <FollowRing /> : null}
        {frameShown ? <FollowRipples ripples={follow.ripples} /> : null}
        {host.location.blocked ? <LocationBlockedNotice onDismiss={host.location.dismissBlocked} /> : null}
        {host.location.toast && host.location.site ? (
          <LocationToast title={host.location.site.title} onDismiss={host.location.dismissToast}
            onStop={() => { if (host.location.site) setLocationStopped(host.location.site, true); host.location.dismissToast(); }} />
        ) : followNote ? <FollowToast text={followNote} />
          : follow.locationLeftOut && follow.state.role === "presenting" ? <FollowToast text="📍 Your location is left out" testId="follow-location-toast" /> : null}
        {shown === "opening" || shown === "starting" ? (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-slate-500 dark:text-slate-400" data-testid="site-preview-progress">
            <Spinner aria-hidden="true" tone="slate" size="sm" /> {shown === "starting" ? "Starting" : "Opening"} {title}…
          </div>
        ) : null}
        {shown !== "opening" && shown !== "starting" && shown !== "checking" && shown !== "live" ? (
          <div className="absolute inset-0 flex items-center justify-center bg-white/95 p-6 dark:bg-[var(--color-studio-dark-canvas)]/95" data-testid="site-preview-problem">
            <div className="max-w-sm space-y-3 text-center">
              <Text as="div" variant="bodyStrong" tone="primary">{PROBLEM_TEXT[shown].title ?? detail}</Text>
              <Text as="div" variant="caption" tone="muted">{restartable && WAKE_TEXT[shown] ? WAKE_TEXT[shown] : PROBLEM_TEXT[shown].body}</Text>
              <div className="flex flex-wrap items-center justify-center gap-2">
                {PROBLEM_TEXT[shown].reload ? (
                  <Button variant="outline" size="sm" radius="full" onPress={reload}>Reload</Button>
                ) : null}
                {restartable && WAKE_TEXT[shown] ? (
                  // Started the way it was opened: no Octo turn, no message.
                  <Button variant="primary" size="sm" radius="full" data-testid="site-preview-wake" onPress={() => void wakeSite()}>Start again</Button>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
