import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Lock, WebWindow } from "iconoir-react";
import { Text } from "../../../components/Text";
import { useOptionalRuntimeState } from "../../../runtime/RuntimeStateProvider";
import { ControllerApiError } from "../../../services/runtimeController/core";
import {
  getSitePreview,
  sitePreviewProblem,
  sitePreviewRecordState,
  type ControllerSitePreview,
} from "../../../services/runtimeController/previews";
import { useConversationPreviewOpener } from "../../../workspace/ConversationPreviewContext";
import { ChatActionCard, type ChatActionCardAction } from "./ChatActionCard";
import type { SitePreviewRequest } from "./sitePreviewRequest";

export type SitePreviewState = "checking" | "live" | "not_responding" | "unavailable" | "stopped";

/** How often a card whose pane is on screen, or whose site has no settled state, asks again. */
const SITE_PREVIEW_FOLLOW_MS = 15_000;
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
const ENDED_GRANT_STATUSES: ReadonlySet<string> = new Set(["revoked", "expired", "closed", "failed"]);
const ENDED_RUNTIME_STATUSES: ReadonlySet<string> = new Set(["stopped", "stopping", "terminated", "released", "failed"]);

/**
 * What a card says about its site. Only the controller's record (grant and
 * probe) and the store's tunnel and runtime events decide it, never the
 * message's text, and Live needs a probe that saw the site answer, so an old
 * card never claims Live.
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
  switch (sitePreviewRecordState(input.preview)) {
    case "stopped":
      return "stopped";
    case "live":
      return "live";
    case "not_responding":
      return "not_responding";
    case "unverified":
      return "unavailable";
    default:
      return "checking";
  }
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

export function sitePreviewStateLabel(state: SitePreviewState, port: number | null): string {
  switch (state) {
    case "live":
      return "Live";
    case "not_responding":
      return port ? `Not responding on port ${port}` : "Not responding";
    case "stopped":
      return "Stopped";
    case "unavailable":
      return "Status unavailable";
    default:
      return "Checking…";
  }
}

const STATE_DOT: Record<SitePreviewState, string> = {
  checking: "bg-slate-300 motion-safe:animate-pulse dark:bg-slate-600",
  live: "bg-emerald-500 dark:bg-emerald-400",
  not_responding: "bg-secondary-500 dark:bg-secondary-400",
  unavailable: "bg-slate-300 dark:bg-slate-600",
  stopped: "bg-slate-400 dark:bg-slate-500",
};

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
  };
}

/**
 * Octo's "Ready to preview" card for a site running in the space. It names
 * the site, says whether it is live, and opens it in the conversation's side
 * pane on a press, through ConversationPreviewContext as a chat link opens a
 * file. It never opens by itself, not even when it is new, and holds no URL.
 */
export function SitePreviewCard({
  preview,
  projectId,
}: {
  preview: SitePreviewRequest;
  projectId: string | null;
}) {
  const opener = useConversationPreviewOpener();
  const [server, setServer] = useState<ControllerSitePreview | null>(null);
  const [gone, setGone] = useState(false);
  // Failed checks in a row, and whether the controller said it will not answer.
  const [failures, setFailures] = useState(0);
  const [cannotCheck, setCannotCheck] = useState(false);
  // Follow-up checks made while the card's pane was not on screen, and
  // whether they ran out.
  const unseenFollows = useRef(0);
  const [followsSpent, setFollowsSpent] = useState(false);
  const signals = useStoreSignals(preview.previewId, server?.runtimeId ?? null);
  const request = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const next = await getSitePreview(projectId, preview.previewId, controller.signal);
      if (controller.signal.aborted) return;
      setServer(next);
      setGone(false);
      setFailures(0);
      setCannotCheck(false);
    } catch (error) {
      if (controller.signal.aborted) return;
      const failure = checkFailure(error);
      if (failure === "gone") setGone(true);
      else if (failure === "final") setCannotCheck(true);
      else setFailures((count) => count + 1);
    }
  }, [preview.previewId, projectId]);

  // Something new happened (a press, a tunnel or runtime event): every
  // automatic check the card gave up on may answer now, so ask again.
  const renew = useCallback(() => {
    setFailures(0);
    setCannotCheck(false);
    unseenFollows.current = 0;
    setFollowsSpent(false);
    void refresh();
  }, [refresh]);

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
  const state = sitePreviewState({
    preview: server,
    gone,
    unavailable,
    grantStatus: signals.grantStatus,
    runtimeStatus: signals.runtimeStatus,
  });
  const showing = state !== "stopped" && opener?.visiblePreviewId === preview.previewId;

  // While its pane is on screen, the card keeps up with the site, so it never
  // reads Live beside a site that stopped answering. A card whose site has no
  // settled state keeps asking for a while too, so it sees the site come up.
  // Nothing follows while a failed check is being retried or after the
  // controller said it will not answer.
  const settled = state === "live" || state === "stopped";
  const following = !failures && !cannotCheck && !gone &&
    (showing || (!settled && !followsSpent));
  useEffect(() => {
    if (!following) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      if (!showing) {
        if (unseenFollows.current >= MAX_UNSEEN_FOLLOWS) {
          window.clearInterval(timer);
          setFollowsSpent(true);
          return;
        }
        unseenFollows.current += 1;
      }
      void refresh();
    }, SITE_PREVIEW_FOLLOW_MS);
    return () => window.clearInterval(timer);
  }, [following, refresh, showing]);

  // The preview comes from the stored card, parsed once: nothing a press
  // carries is trusted. Opening only selects the conversation's view; the
  // pane mints its own viewer session.
  const open = () => {
    renew();
    opener?.openPreview({ previewId: preview.previewId, title: preview.title });
  };

  const label = sitePreviewStateLabel(state, server?.port ?? preview.port);
  const actions: ChatActionCardAction[] = opener
    ? [{
        id: "open-preview",
        label: showing ? "Showing" : "Open",
        variant: showing || state === "not_responding" || state === "unavailable" ? "outline" : "primary",
        onPress: open,
        isDisabled: showing || state === "stopped",
        testId: "preview-ready-open",
      }]
    : [];

  return (
    <ChatActionCard
      testId="preview-ready-card"
      icon={<WebWindow className="h-4 w-4 text-slate-500 dark:text-slate-400" aria-hidden="true" />}
      overline="Ready to preview"
      title={preview.title}
      actions={actions}
    >
      {/* Gaps, not a "·" separator, so a wrapped line never ends in a stray dot. */}
      <Text as="div" variant="caption" tone="muted" className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        <span
          role="status"
          aria-live="polite"
          className="inline-flex items-center gap-1.5"
          data-testid="preview-ready-status"
          data-state={state}
        >
          <span className={`h-2 w-2 shrink-0 rounded-full ${STATE_DOT[state]}`} aria-hidden="true" />
          {label}
        </span>
        <span className="inline-flex items-center gap-1">
          <Lock className="h-3 w-3" aria-hidden="true" />
          Only space members
        </span>
      </Text>
    </ChatActionCard>
  );
}
