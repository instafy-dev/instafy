import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Lock, WebWindow } from "iconoir-react";
import { Text } from "../../../components/Text";
import { useOptionalRuntimeState } from "../../../runtime/RuntimeStateProvider";
import { ControllerApiError } from "../../../services/runtimeController/core";
import {
  getSitePreview,
  sitePreviewRecordState,
  type ControllerSitePreview,
} from "../../../services/runtimeController/previews";
import { useConversationPreviewOpener } from "../../../workspace/ConversationPreviewContext";
import { ChatActionCard, type ChatActionCardAction } from "./ChatActionCard";
import type { SitePreviewRequest } from "./sitePreviewRequest";

export type SitePreviewState = "checking" | "live" | "not_responding" | "stopped";

/** How often a card whose pane is on screen, or whose site is not responding, asks again. */
const SITE_PREVIEW_FOLLOW_MS = 15_000;
/** Pauses before asking again after a check failed for another reason than the preview being gone. */
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];
const ENDED_GRANT_STATUSES: ReadonlySet<string> = new Set(["revoked", "expired", "closed", "failed"]);
const ENDED_RUNTIME_STATUSES: ReadonlySet<string> = new Set(["stopped", "stopping", "terminated", "released", "failed"]);

/**
 * What a card says about its site. Only the controller's record (grant and
 * probe) and the store's tunnel and runtime events decide it, never the
 * message's text, so an old card never claims Live.
 */
export function sitePreviewState(input: {
  preview: Pick<ControllerSitePreview, "status" | "health"> | null;
  gone: boolean;
  grantStatus: string | null;
  runtimeStatus: string | null;
}): SitePreviewState {
  if (input.gone) return "stopped";
  if (input.grantStatus && ENDED_GRANT_STATUSES.has(input.grantStatus)) return "stopped";
  if (input.runtimeStatus && ENDED_RUNTIME_STATUSES.has(input.runtimeStatus)) return "stopped";
  return input.preview ? sitePreviewRecordState(input.preview) : "checking";
}

export function sitePreviewStateLabel(state: SitePreviewState, port: number | null): string {
  switch (state) {
    case "live":
      return "Live";
    case "not_responding":
      return port ? `Not responding on port ${port}` : "Not responding";
    case "stopped":
      return "Stopped";
    default:
      return "Checking…";
  }
}

const STATE_DOT: Record<SitePreviewState, string> = {
  checking: "bg-slate-300 motion-safe:animate-pulse dark:bg-slate-600",
  live: "bg-emerald-500 dark:bg-emerald-400",
  not_responding: "bg-secondary-500 dark:bg-secondary-400",
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
  const [failures, setFailures] = useState(0);
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
    } catch (error) {
      if (controller.signal.aborted) return;
      // A preview this viewer cannot see, or one already removed, reads as Stopped.
      if (error instanceof ControllerApiError && [403, 404, 410].includes(error.status)) {
        setGone(true);
        return;
      }
      setFailures((count) => count + 1);
    }
  }, [preview.previewId, projectId]);

  // A failed check is no answer: ask again, more slowly each time.
  useEffect(() => {
    if (!failures) return;
    const delay = RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length) - 1];
    const timer = window.setTimeout(() => void refresh(), delay);
    return () => window.clearTimeout(timer);
  }, [failures, refresh]);

  // A tunnel event for this grant (it was revoked, say) asks again at once.
  useEffect(() => {
    void refresh();
    return () => request.current?.abort();
  }, [refresh, signals.grantStatus]);

  const state = sitePreviewState({
    preview: server,
    gone,
    grantStatus: signals.grantStatus,
    runtimeStatus: signals.runtimeStatus,
  });
  const showing = state !== "stopped" && opener?.visiblePreviewId === preview.previewId;

  // While its pane is on screen, the card keeps up with the site, so it never
  // reads Live beside a site that stopped answering. A card that reads Not
  // responding keeps asking too, so it sees the site come back.
  const following = showing || state === "not_responding";
  useEffect(() => {
    if (!following) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, SITE_PREVIEW_FOLLOW_MS);
    return () => window.clearInterval(timer);
  }, [following, refresh]);

  // The preview comes from the stored card, parsed once: nothing a press
  // carries is trusted. Opening only selects the conversation's view; the
  // pane mints its own viewer session.
  const open = () => {
    void refresh();
    opener?.openPreview({ previewId: preview.previewId, title: preview.title });
  };

  const label = state === "checking" && failures > 0 ? "Status unavailable" : sitePreviewStateLabel(state, server?.port ?? preview.port);
  const actions: ChatActionCardAction[] = opener
    ? [{
        id: "open-preview",
        label: showing ? "Showing" : "Open",
        variant: showing || state === "not_responding" ? "outline" : "primary",
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
