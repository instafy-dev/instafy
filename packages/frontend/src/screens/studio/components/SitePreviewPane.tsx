import { useCallback, useEffect, useRef, useState } from "react";
import { OpenNewWindow, Refresh } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { Spinner } from "../../../components/Spinner";
import { Text } from "../../../components/Text";
import {
  createSitePreviewViewer,
  getSitePreview,
  heartbeatSitePreviewViewer,
  revokeSitePreviewViewer,
  sitePreviewProblem,
  sitePreviewRecordState,
  type SitePreviewProblem,
  type SitePreviewRecordState,
} from "../../../services/runtimeController/previews";
import { reserveExternalWindow } from "../../../utils/openExternalUrl";
import { BrowserChromeShell, BrowserStatusPill, type BrowserChromeState } from "./BrowserChromeShell";

export const SITE_PREVIEW_HEALTH_POLL_MS = 15_000;
/** While the frame is on screen: keeps a quiet site's session alive. */
export const SITE_PREVIEW_HEARTBEAT_MS = 60_000;
export const SITE_PREVIEW_FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads";
export const SITE_PREVIEW_FRAME_ALLOW = "fullscreen; clipboard-write";

/**
 * The only message the pane reads from its frame. The broker's error pages
 * report their status with it, but any page on this preview's origin can send
 * it, the site itself included.
 */
export const SITE_PREVIEW_MESSAGE_TYPE = "instafy-preview";

type SessionState = "opening" | "ready" | "ended" | SitePreviewProblem;
type HealthState = "checking" | Exclude<SitePreviewRecordState, "pending" | "unverified"> | Exclude<SitePreviewProblem, "unavailable">;

/**
 * What the pane says from the record: a tunnel not active yet, or one the
 * broker could not probe, reads Checking (the frame stays, so the person sees
 * for themselves), never Live.
 */
function paneHealth(state: SitePreviewRecordState): HealthState {
  return state === "pending" || state === "unverified" ? "checking" : state;
}
export type SitePreviewPaneState = "opening" | "ended" | HealthState | SitePreviewProblem;

const UNAVAILABLE_TEXT = "Previews are not available here";
const POPUP_BLOCKED_TEXT = "Your browser blocked the new tab. Allow pop-ups for this site and try again.";

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
const PROBLEM_TEXT: Record<Exclude<SitePreviewPaneState, "opening" | "checking" | "live">, { title: string | null; body: string; reload: boolean }> = {
  not_responding: { title: null, body: "The site stopped answering. Reload once it is back, or ask Octo to start it again.", reload: true },
  stopped: { title: null, body: "The machine or the site stopped. Ask Octo to start it again.", reload: true },
  missing: { title: "This preview no longer exists", body: "It was closed. Ask Octo to open the site again.", reload: false },
  no_access: { title: "You can't open this preview", body: "You may no longer have access to it.", reload: false },
  ended: { title: "This preview session ended", body: "Reload to open a new session.", reload: true },
  unavailable: { title: UNAVAILABLE_TEXT, body: "This server does not offer site previews.", reload: false },
};

function chromeState(state: SitePreviewPaneState): BrowserChromeState {
  if (state === "live") return "ready";
  return state === "opening" || state === "checking" ? "starting" : "unavailable";
}

function statusDetail(state: SitePreviewPaneState, port: number | null): string | null {
  switch (state) {
    case "opening": return "Opening";
    case "checking": return "Checking";
    case "live": return "Live";
    case "not_responding": return port ? `Not responding on port ${port}` : "Not responding";
    case "stopped": return "Stopped";
    case "missing": return "Closed";
    case "no_access": return "No access";
    case "ended": return "Session ended";
    default: return UNAVAILABLE_TEXT;
  }
}

/**
 * One running site in a conversation's side pane, inside upstream's browser bar.
 *
 * The viewer address is a member-only capability. It is minted when the pane
 * mounts, lives only in this component's memory (never stored, logged or shown;
 * the bar shows the title) and is revoked when the pane unmounts, which is what
 * the tab's × does.
 *
 * The frame can tell the pane one thing: `{type: "instafy-preview", status}`,
 * read only from this frame's window and this capability's origin. The
 * broker's error pages send it, but so can any page on that origin, the site
 * itself included, so the worst a message can do is end or relabel this one
 * pane. A 401 (the session idled out or was revoked) and a 410 from the
 * heartbeat each mint one new session; a second loss in a row ends it, so a
 * removed member never loops. Showing the pane again allows one more.
 */
export function SitePreviewPane({ projectId, previewId, title, visible }: {
  projectId: string;
  previewId: string;
  title: string;
  /** On screen now: health polls and heartbeats run only while it is. */
  visible: boolean;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [session, setSession] = useState<SessionState>("opening");
  const [health, setHealth] = useState<HealthState>("checking");
  const [port, setPort] = useState<number | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [openingTab, setOpeningTab] = useState(false);
  const live = useRef<string | null>(null);
  const reminted = useRef(false);
  const mounted = useRef(true);
  const mintAttempt = useRef(0);
  const wasVisible = useRef(visible);
  const beatWhenShown = useRef(false);

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

  const checkHealth = useCallback(async (signal?: AbortSignal, fresh = false) => {
    try {
      const preview = await getSitePreview(projectId, previewId, signal, fresh ? { fresh } : undefined);
      if (signal?.aborted || !mounted.current) return;
      setPort(preview.port);
      setHealth(paneHealth(sitePreviewRecordState(preview)));
    } catch (cause) {
      if (signal?.aborted || !mounted.current) return;
      const problem = sitePreviewProblem(cause);
      if (problem && problem !== "unavailable") setHealth(problem);
    }
  }, [previewId, projectId]);

  // A preview that is gone or forbidden stays so: nothing more is asked until Reload.
  const healthSettled = health === "missing" || health === "no_access";
  useEffect(() => {
    if (!visible || session !== "ready" || healthSettled) return;
    const controller = new AbortController();
    const tick = () => { if (document.visibilityState !== "hidden") void checkHealth(controller.signal); };
    tick();
    const timer = window.setInterval(tick, SITE_PREVIEW_HEALTH_POLL_MS);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [checkHealth, healthSettled, session, visible]);

  // Shown again after being hidden: the session may have idled out meanwhile,
  // so check it at once, and allow one more re-mint.
  useEffect(() => {
    if (visible && !wasVisible.current) { reminted.current = false; beatWhenShown.current = true; }
    wasVisible.current = visible;
  }, [visible]);

  const shown: SitePreviewPaneState = session === "ready" ? health : session;
  const frameShown = Boolean(viewerUrl) && session === "ready" && (shown === "checking" || shown === "live" || shown === "not_responding");
  const frameOnScreen = visible && frameShown;
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
      if (!data || typeof data !== "object" || data.type !== SITE_PREVIEW_MESSAGE_TYPE || typeof data.status !== "number") return;
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
        if (mounted.current) setFeedback(sitePreviewProblem(cause) === "unavailable" ? UNAVAILABLE_TEXT : cause instanceof Error ? cause.message : "Could not open the preview.");
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
        busy={shown === "opening"}
        navigation={
          <IconButton aria-label="Reload" title="Reload" className="max-[540px]:h-10 max-[540px]:w-10" data-testid="site-preview-reload"
            isDisabled={shown === "opening"} onPress={reload} radius="full" size="sm" variant="ghost">
            <Refresh className="h-4 w-4" aria-hidden="true" />
          </IconButton>
        }
        address={
          <div className="flex h-8 min-w-0 items-center px-2 text-sm text-slate-900 dark:text-slate-100">
            <span className="min-w-0 truncate font-medium" data-testid="site-preview-title" title={title}>{title}</span>
          </div>
        }
        status={<BrowserStatusPill state={chromeState(shown)} detail={detail} testId="site-preview-status" />}
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
            src={viewerUrl}
            title={title}
            sandbox={SITE_PREVIEW_FRAME_SANDBOX}
            allow={SITE_PREVIEW_FRAME_ALLOW}
            referrerPolicy="no-referrer"
            className="h-full w-full border-0"
            data-testid="site-preview-frame"
          />
        ) : null}
        {shown === "opening" ? (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-slate-500 dark:text-slate-400">
            <Spinner aria-hidden="true" tone="slate" size="sm" /> Opening {title}…
          </div>
        ) : null}
        {shown !== "opening" && shown !== "checking" && shown !== "live" ? (
          <div className="absolute inset-0 flex items-center justify-center bg-white/95 p-6 dark:bg-[var(--color-studio-dark-canvas)]/95" data-testid="site-preview-problem">
            <div className="max-w-sm space-y-3 text-center">
              <Text as="div" variant="bodyStrong" tone="primary">{PROBLEM_TEXT[shown].title ?? detail}</Text>
              <Text as="div" variant="caption" tone="muted">{PROBLEM_TEXT[shown].body}</Text>
              {PROBLEM_TEXT[shown].reload ? (
                <Button variant="outline" size="sm" radius="full" onPress={reload}>Reload</Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
