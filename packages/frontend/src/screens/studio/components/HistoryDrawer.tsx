import { useCallback, useEffect, useId, useRef, useState } from "react";
import { GitBranch, NavArrowRight, Refresh, Xmark } from "iconoir-react";
import { Badge } from "../../../components/Badge";
import { Button, IconButton } from "../../../components/Button";
import { DrawerHeader } from "../../../components/DrawerHeader";
import { Text } from "../../../components/Text";
import {
  DRAWER_ICON_BUTTON_TONE_CLASS,
  LIST_ROW_FOCUS_RING,
  LIST_ROW_SURFACE_BASE,
} from "../../../components/listRowStyles";
import { DARK_DIVIDER_BORDER_CLASS } from "../../../theme/darkSurfaces";
import { useConversations } from "../../../conversations/ConversationsProvider";
import { useProject } from "../../../projects/useProject";
import { useAuth } from "../../../providers/AuthProvider";
import { controllerClient, type WorkspaceGitHistoryEntry } from "../../../sdk/instafy";
import { useWorkspaceTabs } from "../../../workspace/WorkspaceTabsProvider";
import { refreshUnsavedWork } from "../../../workspace/unsavedWorkStore";
import type { ActiveWorkspaceVersioning } from "../../../workspace/useActiveWorkspaceVersioning";
import { DesktopChangesLine } from "./DesktopChangesLine";
import { HistoryConfirmDialog } from "./HistoryConfirmDialog";
import { UnsavedWorkSection } from "./UnsavedWorkSection";
import { PROGRAMMATIC_FOCUS_CLASS, restoreLostFocus } from "./historyFocus";
import {
  conflictedOnComputerCopy,
  keptOnComputerCopy,
  resolveHistoryAuthor,
  REVERT_DIALOG,
  revertAskAgentPrompt,
  revertFailureCopy,
  revertSuccessCopy,
  type HistoryNotice,
  type HistoryOriginKind,
} from "./historyCopy";
import { formatRelativeCommitTime, parseSavedVersionSubject } from "./workspaceGitReviewShared";

export const HISTORY_PAGE_SIZE = 20;
export const HISTORY_COMMIT_DEBOUNCE_MS = 750;
export const HISTORY_FOCUS_REFRESH_MS = 60_000;
/** A busy origin (an apply or sync holds its lock) is asked again this often, a few times. */
export const HISTORY_BUSY_RETRY_MS = 1_500;
export const HISTORY_BUSY_RETRIES = 3;
const LEASE_RETRY_DELAY_MS = 1_500;
const WORKSPACE_COMMIT_EVENT = "instafy:workspace-commit";

const HISTORY_LOAD_ERROR_COPY = "Couldn't load saved versions. Try Refresh.";
const HISTORY_MORE_ERROR_COPY = "Couldn't load more saved versions. Try again.";
const HISTORY_BUSY_COPY = "Checking saved versions…";
const HISTORY_PROBE_ERROR_COPY = "Couldn't check this space's saved versions.";
const HISTORY_BUSY_ERROR_COPY = "The space is busy saving changes. Try Refresh in a moment.";
const HISTORY_MORE_BUSY_COPY = "The space is busy saving changes. Try Show more again in a moment.";

type HistoryListState = {
  /** `busy`: the origin answered busy before any version was shown; retrying. */
  status: "idle" | "loading" | "busy" | "ok" | "error";
  entries: WorkspaceGitHistoryEntry[];
  hasMore: boolean;
  error: string | null;
};

const EMPTY_HISTORY: HistoryListState = { status: "idle", entries: [], hasMore: false, error: null };

const NOTICE_TONE_CLASS: Record<HistoryNotice["tone"], string> = {
  success: "text-slate-700 dark:text-slate-200",
  info: "text-slate-700 dark:text-slate-200",
  warning: "text-secondary-800 dark:text-secondary-200",
  error: "text-rose-700 dark:text-rose-300",
};

function eventTargetsProject(event: Event, projectId: string): boolean {
  const detail = (event as CustomEvent<{ projectId?: string | null }>).detail;
  const target = detail && typeof detail.projectId === "string" ? detail.projectId : null;
  return !target || target === projectId;
}

/**
 * History (stateless and desktop modes): saved versions with Review and
 * Revert, plus, on a Desktop space, the files changed outside Studio. No
 * interval timer: it loads when it opens, on Refresh, on a workspace commit
 * (debounced) and on focus after a minute.
 */
export function HistoryDrawer({
  versioning,
  onRequestClose,
  probeFailed = false,
}: {
  versioning: ActiveWorkspaceVersioning;
  onRequestClose?: () => void;
  /** The mode probe made when the drawer opened got no answer. */
  probeFailed?: boolean;
}) {
  const { projectCapabilitiesResolved, canWriteProject } = useProject();
  const { user } = useAuth();
  const canWrite = projectCapabilitiesResolved === true && canWriteProject === true;
  const { activeConversationId, createConversation, setConversationDraft } = useConversations();
  const { openConversationTab, openGitReviewTab, requestUrlPush } = useWorkspaceTabs();
  const projectId = versioning.projectId;
  const originId = versioning.originId;
  const ready = versioning.historyReady && projectId !== null && originId !== null;
  const originKind: HistoryOriginKind = versioning.chromeMode === "desktop" ? "desktop" : "stateless";
  const savedVersionsLabelId = useId();

  const [history, setHistory] = useState<HistoryListState>(EMPTY_HISTORY);
  const [loadingMore, setLoadingMore] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // Each message gets a new node, so a repeated text ("Removed.") is announced again.
  const [notice, setNoticeState] = useState<(HistoryNotice & { id: number }) | null>(null);
  const noticeSeqRef = useRef(0);
  const setNotice = useCallback((next: HistoryNotice | null) => {
    setNoticeState(next ? { ...next, id: ++noticeSeqRef.current } : null);
  }, []);
  const [pendingRevert, setPendingRevert] = useState<WorkspaceGitHistoryEntry | null>(null);
  const [revertingCommit, setRevertingCommit] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [statusRefreshKey, setStatusRefreshKey] = useState(0);
  const historySeqRef = useRef(0);
  const lastHistoryLoadRef = useRef(0);
  const busyRetryRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  // Probes asked from here while the mode is still unknown.
  const [probeRetry, setProbeRetry] = useState<"idle" | "running" | "answered" | "failed">("idle");
  const probeUnanswered =
    !ready && (probeRetry === "failed" || (probeRetry === "idle" && probeFailed));
  const focusCommitRef = useRef<string | null>(null);
  // Bumped when Show more goes away under the keyboard.
  const [headingFocusRequests, setHeadingFocusRequests] = useState(0);
  const rowButtonsRef = useRef(new Map<string, HTMLButtonElement>());

  const cancelBusyRetry = useCallback(() => {
    if (busyRetryRef.current !== null) {
      window.clearTimeout(busyRetryRef.current);
      busyRetryRef.current = null;
    }
  }, []);

  /** Load the first page; resolves to the newest saved version (`main`). */
  const loadHistory = useCallback(
    async (options?: { silent?: boolean; busyAttempt?: number }): Promise<string | null> => {
      if (!ready || !projectId || !originId) {
        return null;
      }
      cancelBusyRetry();
      const seq = ++historySeqRef.current;
      if (!options?.silent) {
        setHistory((previous) => ({ ...previous, status: previous.entries.length > 0 ? previous.status : "loading" }));
      }
      const page = await controllerClient.workspace.git
        .fetchHistory({ projectId, originId, routing: "default", limit: HISTORY_PAGE_SIZE })
        .catch(() => null);
      // A newer load, or the drawer closed while this one was out: drop it,
      // and never arm a busy retry for a drawer that is gone.
      if (seq !== historySeqRef.current || !mountedRef.current) {
        return null;
      }
      lastHistoryLoadRef.current = Date.now();
      if (!page) {
        setHistory((previous) => ({ ...previous, status: "error", error: HISTORY_LOAD_ERROR_COPY }));
        return null;
      }
      if (page.busy) {
        // Busy is not empty: keep what is shown (or a busy frame) and ask again.
        const attempt = options?.busyAttempt ?? 0;
        if (attempt < HISTORY_BUSY_RETRIES) {
          setHistory((previous) =>
            previous.entries.length > 0 ? previous : { ...previous, status: "busy", error: null },
          );
          busyRetryRef.current = window.setTimeout(() => {
            busyRetryRef.current = null;
            void loadHistoryRef.current({ silent: true, busyAttempt: attempt + 1 });
          }, HISTORY_BUSY_RETRY_MS);
        } else {
          setHistory((previous) =>
            previous.entries.length > 0 ? previous : { ...previous, status: "error", error: HISTORY_BUSY_ERROR_COPY },
          );
        }
        return null;
      }
      if (!page.supported) {
        setHistory({ status: "ok", entries: [], hasMore: false, error: null });
        return null;
      }
      if (page.error) {
        setHistory((previous) => ({
          status: "error",
          entries: page.entries.length > 0 ? page.entries : previous.entries,
          hasMore: false,
          error: page.error ?? HISTORY_LOAD_ERROR_COPY,
        }));
        return null;
      }
      setHistory({
        status: "ok",
        entries: page.entries,
        hasMore: page.hasMore === true && page.entries.length > 0,
        error: null,
      });
      return page.entries[0]?.commit ?? null;
    },
    [cancelBusyRetry, originId, projectId, ready],
  );

  const loadHistoryRef = useRef(loadHistory);
  loadHistoryRef.current = loadHistory;

  // Opening (or a new project or origin): one load, no timer.
  useEffect(() => {
    historySeqRef.current += 1;
    cancelBusyRetry();
    setHistory(EMPTY_HISTORY);
    setExpanded(new Set());
    setNotice(null);
    if (!ready) {
      return;
    }
    // The Desktop line checks its own count when it mounts.
    void loadHistoryRef.current();
  }, [cancelBusyRetry, originId, projectId, ready, setNotice]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Loads still out when the drawer closes answer into nothing.
      historySeqRef.current += 1;
      cancelBusyRetry();
    };
  }, [cancelBusyRetry]);

  useEffect(() => {
    setProbeRetry("idle");
  }, [originId, projectId]);

  // A saved version landed somewhere: reload the list once the burst settles.
  useEffect(() => {
    if (!ready || !projectId || typeof window === "undefined") {
      return undefined;
    }
    let debounce: number | null = null;
    const handleCommit = (event: Event) => {
      if (!eventTargetsProject(event, projectId)) {
        return;
      }
      if (debounce !== null) {
        window.clearTimeout(debounce);
      }
      debounce = window.setTimeout(() => {
        debounce = null;
        void loadHistoryRef.current({ silent: true });
      }, HISTORY_COMMIT_DEBOUNCE_MS);
    };
    const handleFocus = () => {
      if (Date.now() - lastHistoryLoadRef.current >= HISTORY_FOCUS_REFRESH_MS) {
        void loadHistoryRef.current({ silent: true });
      }
    };
    window.addEventListener(WORKSPACE_COMMIT_EVENT, handleCommit);
    window.addEventListener("focus", handleFocus);
    return () => {
      if (debounce !== null) {
        window.clearTimeout(debounce);
      }
      window.removeEventListener(WORKSPACE_COMMIT_EVENT, handleCommit);
      window.removeEventListener("focus", handleFocus);
    };
  }, [projectId, ready]);

  /** The stable place focus falls back to: the Saved versions heading. */
  const focusSavedVersionsHeading = useCallback(() => {
    restoreLostFocus(document.getElementById(savedVersionsLabelId));
  }, [savedVersionsLabelId]);

  useEffect(() => {
    if (headingFocusRequests > 0) {
      focusSavedVersionsHeading();
    }
  }, [focusSavedVersionsHeading, headingFocusRequests]);

  // Show more keeps focus on the first new row.
  useEffect(() => {
    const commit = focusCommitRef.current;
    if (!commit) {
      return;
    }
    focusCommitRef.current = null;
    rowButtonsRef.current.get(commit)?.focus();
  }, [history.entries]);

  // The header's Refresh reloads the whole drawer: mode, saved versions,
  // the Desktop line and Unsaved work (no event announces new recovery refs).
  const handleRefresh = useCallback(() => {
    if (!ready) {
      // The mode is not known yet: Refresh (and Retry) asks the origin again.
      setProbeRetry("running");
      void versioning.refresh().then((result) => {
        if (mountedRef.current) {
          setProbeRetry(result ? "answered" : "failed");
        }
      });
      return;
    }
    void versioning.refresh();
    void loadHistory();
    setStatusRefreshKey((key) => key + 1);
    if (ready && projectId && originId) {
      void refreshUnsavedWork({ projectId, originId, force: true });
    }
  }, [loadHistory, originId, projectId, ready, versioning]);

  const handleShowMore = useCallback(async () => {
    if (!ready || !projectId || !originId || loadingMore) {
      return;
    }
    const seq = historySeqRef.current;
    const known = history.entries;
    setLoadingMore(true);
    const page = await controllerClient.workspace.git
      .fetchHistory({ projectId, originId, routing: "default", limit: HISTORY_PAGE_SIZE, skip: known.length })
      .catch(() => null);
    setLoadingMore(false);
    if (seq !== historySeqRef.current) {
      return;
    }
    if (page?.busy) {
      // Older versions are still there: keep Show more and say why nothing came.
      setNotice({ tone: "info", text: HISTORY_MORE_BUSY_COPY });
      return;
    }
    if (!page || page.error || !page.supported) {
      setNotice({ tone: "error", text: HISTORY_MORE_ERROR_COPY });
      return;
    }
    const seen = new Set(known.map((entry) => entry.commit));
    const fresh = page.entries.filter((entry) => !seen.has(entry.commit));
    if (fresh.length === 0) {
      // A server that ignores `skip` answers the first page again: stop here.
      setHistory((previous) => ({ ...previous, hasMore: false }));
      setHeadingFocusRequests((value) => value + 1);
      return;
    }
    focusCommitRef.current = fresh[0]?.commit ?? null;
    setHistory((previous) => ({
      ...previous,
      entries: [...previous.entries, ...fresh],
      hasMore: page.hasMore === true,
    }));
  }, [history.entries, loadingMore, originId, projectId, ready, setNotice]);

  const handleCommitted = useCallback(
    (rev: string | null) => {
      if (typeof window === "undefined" || !projectId) {
        return;
      }
      window.dispatchEvent(
        new CustomEvent(WORKSPACE_COMMIT_EVENT, {
          detail: { projectId, kind: "workspace.commit", data: rev ? { rev } : null },
        }),
      );
    },
    [projectId],
  );

  const askAgent = useCallback(
    (prompt: string, title: string) => {
      const conversationId = activeConversationId ?? createConversation({ title, select: true }).localId;
      setConversationDraft(conversationId, prompt);
      openConversationTab(conversationId);
      onRequestClose?.();
    },
    [activeConversationId, createConversation, onRequestClose, openConversationTab, setConversationDraft],
  );

  const openSavedVersion = useCallback(
    (entry: WorkspaceGitHistoryEntry) => {
      const parsed = parseSavedVersionSubject(entry.subject);
      requestUrlPush();
      openGitReviewTab({
        kind: "savedVersion",
        commit: entry.commit,
        shortCommit: entry.shortCommit,
        title: parsed.summary,
        committedAt: entry.committedAt,
        initialMode: "all",
        routing: "default",
        originId,
      });
    },
    [openGitReviewTab, originId, requestUrlPush],
  );

  const runRevert = useCallback(
    async (entry: WorkspaceGitHistoryEntry) => {
      setPendingRevert(null);
      if (!canWrite || !ready || !projectId || !originId) {
        return;
      }
      setRevertingCommit(entry.commit);
      setActionBusy(true);
      try {
        const result = await controllerClient.workspace.git.revertCommit({
          projectId,
          commit: entry.commit,
          base: entry.firstParent ?? null,
          originId,
          routing: "default",
          leaseConflictRetryDelayMs: LEASE_RETRY_DELAY_MS,
        });
        if (result?.ok) {
          // Desktop: publishing the revert can leave files in the folder
          // only (they changed in the space, or the space refuses them).
          const report = originKind === "desktop" ? result.report : null;
          const conflicted = report?.conflictedPaths ?? [];
          const leftOnComputer = [
            ...(conflicted.length > 0 ? [conflictedOnComputerCopy(conflicted)] : []),
            ...keptOnComputerCopy(report?.rejectedPaths ?? []),
          ];
          setNotice({
            tone: leftOnComputer.length > 0 ? "warning" : result.committed === false ? "info" : "success",
            text: [revertSuccessCopy(result.committed), ...leftOnComputer].join(" "),
          });
          if (result.committed !== false) {
            handleCommitted(result.rev ?? null);
          }
          return;
        }
        const copy = revertFailureCopy(result, originKind);
        const subject = entry.subject.trim() || parseSavedVersionSubject(entry.subject).summary;
        setNotice({
          tone: copy.tone,
          text: copy.text,
          action: copy.askAgent
            ? {
                label: "Ask the agent",
                testId: "history-revert-ask-agent",
                onPress: () => askAgent(revertAskAgentPrompt(subject, entry.shortCommit), "Undo a version"),
              }
            : null,
        });
      } finally {
        setRevertingCommit(null);
        setActionBusy(false);
        setStatusRefreshKey((key) => key + 1);
      }
    },
    [askAgent, canWrite, handleCommitted, originId, originKind, projectId, ready, setNotice],
  );

  const toggleExpanded = useCallback((commit: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(commit)) {
        next.delete(commit);
      } else {
        next.add(commit);
      }
      return next;
    });
  }, []);

  const entries = history.entries;

  return (
    <div className="@container relative flex h-full min-h-0 flex-col" data-testid="source-control-drawer" data-mode="history">
      <DrawerHeader
        frame="rail"
        title="History"
        icon={<GitBranch className="h-4 w-4 text-slate-400 dark:text-slate-500" aria-hidden="true" />}
        actions={
          <>
            <IconButton
              variant="ghost"
              size="sm"
              radius="full"
              aria-label="Refresh history"
              title="Refresh"
              data-testid="source-control-refresh"
              onPress={handleRefresh}
              isDisabled={ready ? history.status === "loading" : probeRetry === "running"}
              className={`max-[899px]:h-11 max-[899px]:w-11 ${DRAWER_ICON_BUTTON_TONE_CLASS}`}
            >
              <Refresh className="h-4 w-4" aria-hidden="true" />
            </IconButton>
            {onRequestClose ? (
              <IconButton
                variant="ghost"
                size="sm"
                radius="full"
                aria-label="Close history"
                title="Close"
                data-testid="source-control-close"
                onPress={onRequestClose}
                className={`max-[899px]:h-11 max-[899px]:w-11 ${DRAWER_ICON_BUTTON_TONE_CLASS}`}
              >
                <Xmark className="h-4 w-4" aria-hidden="true" />
              </IconButton>
            ) : null}
          </>
        }
      />

      {/* Outside the scrolling list, so a result stays in view of the row
          (or the Show more button) that caused it. */}
      <div role="status" aria-live="polite" data-testid="history-status" className="shrink-0 px-5">
        {notice ? (
          <div key={notice.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5">
            <Text as="span" variant="body" tone="inherit" className={NOTICE_TONE_CLASS[notice.tone]}>
              {notice.text}
            </Text>
            {notice.action ? (
              <Button
                variant="ghost"
                size="xs"
                radius="xl"
                onPress={notice.action.onPress}
                data-testid={notice.action.testId}
              >
                {notice.action.label}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4" data-testid="history-scroll">
        {!ready && probeUnanswered ? (
          <div
            className="flex flex-wrap items-center justify-center gap-2 px-2 py-10"
            data-testid="history-probe-error"
          >
            <Text as="span" tone="muted">
              {HISTORY_PROBE_ERROR_COPY}
            </Text>
            <Button variant="ghost" size="xs" radius="xl" onPress={handleRefresh} data-testid="history-probe-retry">
              Retry
            </Button>
          </div>
        ) : !ready ? (
          <div className="flex items-center justify-center px-2 py-10">
            <Text tone="muted">Loading history…</Text>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {originKind === "desktop" && projectId && originId ? (
              <DesktopChangesLine
                projectId={projectId}
                originId={originId}
                canWrite={canWrite}
                disabled={actionBusy}
                refreshKey={statusRefreshKey}
                onBusyChange={setActionBusy}
                onNotice={setNotice}
                onCommitted={(rev) => {
                  handleCommitted(rev);
                  setStatusRefreshKey((key) => key + 1);
                }}
                onFocusFallback={focusSavedVersionsHeading}
              />
            ) : null}

            {projectId && originId ? (
              <UnsavedWorkSection
                projectId={projectId}
                originId={originId}
                originKind={originKind}
                canWrite={canWrite}
                disabled={actionBusy}
                headRev={entries[0]?.commit ?? null}
                onBusyChange={setActionBusy}
                onNotice={setNotice}
                onCommitted={(rev) => {
                  handleCommitted(rev);
                  setStatusRefreshKey((key) => key + 1);
                }}
                onAskAgent={askAgent}
                onReloadHistory={() => loadHistory({ silent: true })}
                onFocusFallback={focusSavedVersionsHeading}
                userId={user?.id ?? null}
              />
            ) : null}

            <section aria-labelledby={savedVersionsLabelId} className="flex flex-col gap-1">
              <Text
                as="h3"
                id={savedVersionsLabelId}
                tabIndex={-1}
                variant="caption"
                tone="muted"
                className={`px-1 py-1.5 font-medium ${PROGRAMMATIC_FOCUS_CLASS}`}
              >
                Saved versions
              </Text>
              {history.error ? (
                <Text variant="body" tone="danger" className="px-1" data-testid="history-error">
                  {history.error}
                </Text>
              ) : null}
              {history.status === "loading" && entries.length === 0 ? (
                <Text tone="muted" className="px-1 py-3">
                  Loading saved versions…
                </Text>
              ) : history.status === "busy" && entries.length === 0 ? (
                <Text tone="muted" className="px-1 py-3" data-testid="history-busy">
                  {HISTORY_BUSY_COPY}
                </Text>
              ) : entries.length === 0 && history.status === "ok" ? (
                <Text tone="muted" className="px-1 py-3" data-testid="history-empty">
                  No saved versions yet.
                </Text>
              ) : (
                <div className="flex flex-col gap-1" data-testid="source-control-history">
                  {entries.map((entry) => {
                    const parsed = parseSavedVersionSubject(entry.subject);
                    const author = resolveHistoryAuthor(entry);
                    const isExpanded = expanded.has(entry.commit);
                    const reverting = revertingCommit === entry.commit;
                    return (
                      <div
                        key={entry.commit}
                        className={[LIST_ROW_SURFACE_BASE, "pl-1 pr-2 py-1.5"].join(" ")}
                        data-testid="source-control-history-entry"
                        data-expanded={isExpanded ? "true" : "false"}
                      >
                        <div className="flex items-center gap-2">
                          <button
                            ref={(element) => {
                              if (element) {
                                rowButtonsRef.current.set(entry.commit, element);
                              } else {
                                rowButtonsRef.current.delete(entry.commit);
                              }
                            }}
                            type="button"
                            className={[
                              "flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 text-left",
                              LIST_ROW_FOCUS_RING,
                            ].join(" ")}
                            onClick={() => openSavedVersion(entry)}
                            data-testid="source-control-history-review"
                          >
                            <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                              {parsed.summary}
                            </span>
                            {entry.resolvedBy ? (
                              <Badge
                                tone="warning"
                                title="The Assistant resolved a merge conflict in this version. Review it to confirm the result."
                                data-testid="source-control-history-resolved-badge"
                              >
                                Assistant-resolved
                              </Badge>
                            ) : null}
                            <span className="ml-auto flex shrink-0 items-center gap-2 pl-1 text-xxs text-slate-500 dark:text-slate-400">
                              {author.kind === "service" ? (
                                <Badge tone="neutral" data-testid="history-author-instafy">
                                  Instafy
                                </Badge>
                              ) : author.label ? (
                                <span className="max-w-[8rem] truncate" data-testid="history-author">
                                  {author.label}
                                </span>
                              ) : null}
                              <span className="shrink-0 whitespace-nowrap">
                                {formatRelativeCommitTime(entry.committedAt)}
                              </span>
                            </span>
                          </button>
                          <IconButton
                            variant="ghost"
                            size="xs"
                            radius="full"
                            onPress={() => toggleExpanded(entry.commit)}
                            data-testid="source-control-history-toggle"
                            aria-expanded={isExpanded}
                            aria-label={isExpanded ? "Collapse saved version details" : "Expand saved version details"}
                            title={isExpanded ? "Collapse" : "Expand"}
                            className={DRAWER_ICON_BUTTON_TONE_CLASS}
                          >
                            <NavArrowRight
                              className={`h-4 w-4 shrink-0 text-slate-400 transition-transform dark:text-slate-500 ${
                                isExpanded ? "rotate-90" : ""
                              }`}
                              aria-hidden="true"
                            />
                          </IconButton>
                        </div>
                        {isExpanded ? (
                          <div
                            className={`mt-2 border-t border-slate-200/70 pt-2 text-xs text-slate-500 ${DARK_DIVIDER_BORDER_CLASS} dark:text-slate-400`}
                          >
                            <div className="text-slate-600 dark:text-slate-300">{parsed.fullSubject}</div>
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <span className="font-mono" data-testid="source-control-history-short-commit">
                                {entry.shortCommit}
                              </span>
                              <Button
                                variant="ghost"
                                size="sm"
                                radius="xl"
                                onPress={() => openSavedVersion(entry)}
                                data-testid="source-control-history-review-inline"
                              >
                                Review version
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                radius="xl"
                                isPending={reverting}
                                isDisabled={!canWrite || (actionBusy && !reverting)}
                                onPress={() => setPendingRevert(entry)}
                                data-testid="source-control-history-revert"
                              >
                                Revert
                              </Button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
              {history.hasMore ? (
                <div className="px-1 pt-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    radius="xl"
                    onPress={() => void handleShowMore()}
                    isPending={loadingMore}
                    data-testid="history-show-more"
                  >
                    Show more
                  </Button>
                </div>
              ) : null}
            </section>
          </div>
        )}
      </div>

      <HistoryConfirmDialog
        isOpen={pendingRevert !== null}
        title={REVERT_DIALOG.title}
        detail={
          pendingRevert
            ? `${parseSavedVersionSubject(pendingRevert.subject).summary} (${pendingRevert.shortCommit})`
            : null
        }
        body={REVERT_DIALOG.body}
        cancelLabel={REVERT_DIALOG.cancel}
        confirmLabel={REVERT_DIALOG.confirm}
        onCancel={() => setPendingRevert(null)}
        onConfirm={() => {
          if (pendingRevert) {
            void runRevert(pendingRevert);
          }
        }}
        testId="history-revert-dialog"
      />
    </div>
  );
}
