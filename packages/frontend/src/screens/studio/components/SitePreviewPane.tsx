import { useCallback, useEffect, useRef, useState } from "react";
import { OpenNewWindow, Refresh } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { Spinner } from "../../../components/Spinner";
import { Text } from "../../../components/Text";
import { ControllerApiError } from "../../../services/runtimeController/core";
import {
  createSitePreviewViewer,
  getSitePreview,
  heartbeatSitePreviewViewer,
  isSitePreviewsUnavailable,
  revokeSitePreviewViewer,
  sitePreviewRecordState,
  type SitePreviewRecordState,
} from "../../../services/runtimeController/previews";
import { openExternalUrl } from "../../../utils/openExternalUrl";
import { BrowserChromeShell, BrowserStatusPill, type BrowserChromeState } from "./BrowserChromeShell";

export const SITE_PREVIEW_HEALTH_POLL_MS = 15_000;
/** While the frame is on screen: keeps a quiet site's session alive. */
export const SITE_PREVIEW_HEARTBEAT_MS = 60_000;
export const SITE_PREVIEW_FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads";
export const SITE_PREVIEW_FRAME_ALLOW = "fullscreen; clipboard-write";

/** The only message the pane reads from its frame: the broker's own error pages report their status with it. */
export const SITE_PREVIEW_MESSAGE_TYPE = "instafy-preview";

type SessionState = "opening" | "ready" | "stopped" | "ended" | "unavailable";
export type SitePreviewPaneState = "opening" | "checking" | SitePreviewRecordState | "ended" | "unavailable";

const UNAVAILABLE_TEXT = "Previews are not available here";

/**
 * Which panes stay mounted: each one from the first time it is on screen until
 * its tab closes. Returns `current` itself when nothing changed.
 */
export function nextMountedSitePreviews(current: readonly string[], openPreviewIds: readonly string[], shownPreviewId: string | null): readonly string[] {
  const kept = current.filter(id => openPreviewIds.includes(id));
  const add = shownPreviewId && openPreviewIds.includes(shownPreviewId) && !kept.includes(shownPreviewId);
  if (!add && kept.length === current.length) return current;
  return add ? [...kept, shownPreviewId] : kept;
}

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
 * The frame may only tell the pane one thing: the broker's error pages post
 * `{type: "instafy-preview", status}`, read only from this frame's window and
 * this capability's origin. A 401 (the session idled out or was revoked) and a
 * 410 from the heartbeat each mint one new session; a second loss in a row ends
 * it, so a removed member never loops.
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
  const [health, setHealth] = useState<"checking" | SitePreviewRecordState>("checking");
  const [port, setPort] = useState<number | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [openingTab, setOpeningTab] = useState(false);
  const live = useRef<string | null>(null);
  const reminted = useRef(false);
  const mounted = useRef(true);
  const mintAttempt = useRef(0);

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
      if (isSitePreviewsUnavailable(cause)) { setSession("unavailable"); return; }
      if (cause instanceof ControllerApiError && [403, 409, 410].includes(cause.status)) { setSession("stopped"); return; }
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
      setHealth(sitePreviewRecordState(preview));
    } catch (cause) {
      if (signal?.aborted || !mounted.current) return;
      if (cause instanceof ControllerApiError && [403, 404, 410].includes(cause.status)) setHealth("stopped");
    }
  }, [previewId, projectId]);

  useEffect(() => {
    if (!visible || session !== "ready") return;
    const controller = new AbortController();
    const tick = () => { if (document.visibilityState !== "hidden") void checkHealth(controller.signal); };
    tick();
    const timer = window.setInterval(tick, SITE_PREVIEW_HEALTH_POLL_MS);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [checkHealth, session, visible]);

  const frameOnScreen = visible && session === "ready" && Boolean(viewerUrl);
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

  const openInNewTab = useCallback(async () => {
    if (openingTab) return;
    setOpeningTab(true);
    setFeedback(null);
    try {
      // Its own capability, so closing this pane leaves the tab working.
      const viewer = await createSitePreviewViewer(projectId, previewId, { tab: true });
      await openExternalUrl(viewer.viewerUrl);
    } catch (cause) {
      if (mounted.current) setFeedback(isSitePreviewsUnavailable(cause) ? UNAVAILABLE_TEXT : cause instanceof Error ? cause.message : "Could not open the preview.");
    } finally {
      if (mounted.current) setOpeningTab(false);
    }
  }, [openingTab, previewId, projectId]);

  const shown: SitePreviewPaneState = session === "ready" ? health : session;
  const frameShown = Boolean(viewerUrl) && session === "ready" && shown !== "stopped";
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
            isDisabled={session !== "ready" || openingTab} onPress={() => void openInNewTab()} radius="full" size="sm" variant="ghost">
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
        {shown === "not_responding" || shown === "stopped" || shown === "ended" || shown === "unavailable" ? (
          <div className="absolute inset-0 flex items-center justify-center bg-white/95 p-6 dark:bg-[var(--color-studio-dark-canvas)]/95" data-testid="site-preview-problem">
            <div className="max-w-sm space-y-3 text-center">
              <Text as="div" variant="bodyStrong" tone="primary">
                {shown === "unavailable" ? UNAVAILABLE_TEXT : shown === "ended" ? "This preview session ended" : detail}
              </Text>
              <Text as="div" variant="caption" tone="muted">
                {shown === "unavailable" ? "This server does not offer site previews."
                  : shown === "not_responding" ? "The site stopped answering. Reload once it is back, or ask Octo to start it again."
                    : shown === "stopped" ? "The machine or the site stopped. Ask Octo to start it again."
                      : "Reload to open a new session."}
              </Text>
              {shown === "unavailable" ? null : (
                <Button variant="outline" size="sm" radius="full" onPress={reload}>Reload</Button>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
