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
import { controllerClient, type WorkspaceGitHistoryEntry } from "../../../sdk/instafy";
import { useWorkspaceTabs } from "../../../workspace/WorkspaceTabsProvider";
import type { ActiveWorkspaceVersioning } from "../../../workspace/useActiveWorkspaceVersioning";
import { DesktopChangesLine } from "./DesktopChangesLine";
import { HistoryConfirmDialog } from "./HistoryConfirmDialog";
import { UnsavedWorkSection } from "./UnsavedWorkSection";
import {
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
const LEASE_RETRY_DELAY_MS = 1_500;
const WORKSPACE_COMMIT_EVENT = "instafy:workspace-commit";

const HISTORY_LOAD_ERROR_COPY = "Couldn't load saved versions. Try Refresh.";
const HISTORY_MORE_ERROR_COPY = "Couldn't load more saved versions. Try again.";

type HistoryListState = {
  status: "idle" | "loading" | "ok" | "error";
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
}: {
  versioning: ActiveWorkspaceVersioning;
  onRequestClose?: () => void;
}) {
  const { projectCapabilitiesResolved, canWriteProject } = useProject();
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
  const [notice, setNotice] = useState<HistoryNotice | null>(null);
  const [pendingRevert, setPendingRevert] = useState<WorkspaceGitHistoryEntry | null>(null);
  const [revertingCommit, setRevertingCommit] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [statusRefreshKey, setStatusRefreshKey] = useState(0);
  const historySeqRef = useRef(0);
  const lastHistoryLoadRef = useRef(0);
  const focusCommitRef = useRef<string | null>(null);
  const rowButtonsRef = useRef(new Map<string, HTMLButtonElement>());

  /** Load the first page; resolves to the newest saved version (`main`). */
  const loadHistory = useCallback(
    async (options?: { silent?: boolean }): Promise<string | null> => {
      if (!ready || !projectId || !originId) {
        return null;
      }
      const seq = ++historySeqRef.current;
      if (!options?.silent) {
        setHistory((previous) => ({ ...previous, status: previous.entries.length > 0 ? previous.status : "loading" }));
      }
      const page = await controllerClient.workspace.git
        .fetchHistory({ projectId, originId, routing: "default", limit: HISTORY_PAGE_SIZE })
        .catch(() => null);
      if (seq !== historySeqRef.current) {
        return null;
      }
      lastHistoryLoadRef.current = Date.now();
      if (!page) {
        setHistory((previous) => ({ ...previous, status: "error", error: HISTORY_LOAD_ERROR_COPY }));
        return null;
      }
      if (page.busy) {
        setHistory((previous) => ({ ...previous, status: previous.status === "loading" ? "ok" : previous.status }));
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
    [originId, projectId, ready],
  );

  const loadHistoryRef = useRef(loadHistory);
  loadHistoryRef.current = loadHistory;

  // Opening (or a new project or origin): one load, no timer.
  useEffect(() => {
    historySeqRef.current += 1;
    setHistory(EMPTY_HISTORY);
    setExpanded(new Set());
    setNotice(null);
    if (!ready) {
      return;
    }
    // The Desktop line checks its own count when it mounts.
    void loadHistoryRef.current();
  }, [originId, projectId, ready]);

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

  // Show more keeps focus on the first new row.
  useEffect(() => {
    const commit = focusCommitRef.current;
    if (!commit) {
      return;
    }
    focusCommitRef.current = null;
    rowButtonsRef.current.get(commit)?.focus();
  }, [history.entries]);

  const handleRefresh = useCallback(() => {
    void versioning.refresh();
    void loadHistory();
    setStatusRefreshKey((key) => key + 1);
  }, [loadHistory, versioning]);

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
    if (!page || page.error || !page.supported) {
      setNotice({ tone: "error", text: HISTORY_MORE_ERROR_COPY });
      return;
    }
    const seen = new Set(known.map((entry) => entry.commit));
    const fresh = page.entries.filter((entry) => !seen.has(entry.commit));
    if (fresh.length === 0) {
      // A server that ignores `skip` answers the first page again: stop here.
      setHistory((previous) => ({ ...previous, hasMore: false }));
      return;
    }
    focusCommitRef.current = fresh[0]?.commit ?? null;
    setHistory((previous) => ({
      ...previous,
      entries: [...previous.entries, ...fresh],
      hasMore: page.hasMore === true,
    }));
  }, [history.entries, loadingMore, originId, projectId, ready]);

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
          setNotice({
            tone: result.committed === false ? "info" : "success",
            text: revertSuccessCopy(result.committed),
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
    [askAgent, canWrite, handleCommitted, originId, originKind, projectId, ready],
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
              isDisabled={!ready || history.status === "loading"}
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

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <div role="status" aria-live="polite" data-testid="history-status" className="px-1">
          {notice ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5">
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

        {!ready ? (
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
              />
            ) : null}

            <section aria-labelledby={savedVersionsLabelId} className="flex flex-col gap-1">
              <Text
                as="h3"
                id={savedVersionsLabelId}
                variant="caption"
                tone="muted"
                className="px-1 py-1.5 font-medium"
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
