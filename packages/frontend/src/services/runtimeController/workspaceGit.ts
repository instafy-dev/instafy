import { normalizeOriginEndpointForClient, runtimeControllerEnabled } from "./core";
import { logControllerRequestError } from "./logging";
import {
  originErrorFromException,
  parseOriginErrorText,
  parsePublishReport,
  readOriginPathList,
  type OriginError,
  type OriginPublishReport,
} from "./originErrors";
import {
  fetchWithOriginToken,
  originHeaders,
  originRoutingTokenParams,
  withWorkspaceWriteLease,
  type WorkspaceOriginRouting,
} from "./originRequest";
import { requestOriginAccessToken } from "./origins";
import { acquireWorkspaceLease, releaseWorkspaceLease, type WorkspaceLease } from "./workspaceLeases";
import { noteVersioningSignal } from "./workspaceVersioningCache";

const WORKSPACE_GIT_STATUS_TIMEOUT_MS = 15_000;
const TRANSIENT_BUSY_STATUS_PATTERN = /workspace is busy applying\/syncing changes/i;

export interface WorkspaceGitDirtyPath {
  path: string;
  code: string;
  embeddedRepoRoot?: string | null;
}

export interface WorkspaceGitPathGroup {
  prefix: string;
  label: string;
  count: number;
  embeddedRepoRoot?: string | null;
}

export interface WorkspaceGitStatus {
  supported: boolean;
  dirtyCount: number;
  dirtyPaths: WorkspaceGitDirtyPath[];
  pathGroups: WorkspaceGitPathGroup[];
  scopePrefix?: string | null;
  pageOffset?: number;
  pageLimit?: number;
  hasMoreFiles?: boolean;
  /** The origin keeps no working copy: every save is already a version. */
  stateless?: boolean;
  busy?: boolean;
  error?: string | null;
}

export interface WorkspaceGitDiff {
  supported: boolean;
  path: string | null;
  commit?: string | null;
  diff: string;
  truncated?: boolean | null;
  error?: string | null;
}

export interface WorkspaceGitHistoryEntry {
  commit: string;
  shortCommit: string;
  committedAt: string;
  authorName: string;
  authorEmail: string;
  subject: string;
  /** Value of the Instafy-Resolved-By trailer (e.g. "assistant"). */
  resolvedBy?: string | null;
  /** First parent of the commit (newer origins); the revert base for merges. */
  firstParent?: string | null;
  /** Who made the version, decided by the origin (newer origins only). */
  actor?: WorkspaceGitHistoryActor | null;
}

export type WorkspaceGitHistoryActor = "user" | "service" | "external";

export interface WorkspaceGitHistory {
  supported: boolean;
  entries: WorkspaceGitHistoryEntry[];
  branch?: string | null;
  headRef?: string | null;
  /** The origin says (or a full page suggests) that older versions exist. */
  hasMore?: boolean;
  busy?: boolean;
  error?: string | null;
}

const fetchWorkspaceOriginGitResponse = fetchWithOriginToken;

/** Legacy git calls prefer the hosted gateway; default routing pins the default origin. */
function gitRouting(routing: WorkspaceOriginRouting | undefined) {
  return originRoutingTokenParams(routing, { preferHosted: true });
}

export interface WorkspaceGitHistoryReview {
  supported: boolean;
  commit: string | null;
  entries: WorkspaceGitDirtyPath[];
  busy?: boolean;
  error?: string | null;
  /** The origin's structured answer when it refused the review (status, code, Retry-After). */
  errorInfo?: OriginError;
}

function isTransientWorkspaceBusyError(value: string | null | undefined): boolean {
  return typeof value === "string" && TRANSIENT_BUSY_STATUS_PATTERN.test(value);
}

export async function fetchWorkspaceGitStatusFromController(params: {
  projectId: string;
  accessToken?: string | null;
  runtimeId?: string | null;
  originId?: string | null;
  scope?: string | null;
  limit?: number;
  offset?: number;
  routing?: WorkspaceOriginRouting;
  /**
   * Report a `stateless: true` answer to the versioning cache (default). The
   * capability probe turns this off: it stores its own answer, and its own
   * response must not count as a signal that arrived while it was running.
   */
  noteVersioningSignals?: boolean;
}): Promise<WorkspaceGitStatus | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const projectId = params.projectId.trim();
  if (!projectId) {
    return null;
  }
  const scope =
    typeof params.scope === "string" && params.scope.trim().length > 0 ? params.scope.trim() : null;

  try {
    const request = await fetchWorkspaceOriginGitResponse(
      {
        projectId,
        protocol: "http",
        scopes: ["fs.read"],
        ...gitRouting(params.routing),
        originId: params.originId ?? null,
        accessToken: params.accessToken ?? null,
      },
      async (originToken, endpoint) => {
        const url = new URL(`${endpoint}/git/status`);
        if (scope) {
          url.searchParams.set("scope", scope);
        }
        if (typeof params.limit === "number" && Number.isFinite(params.limit) && params.limit > 0) {
          url.searchParams.set("limit", String(Math.max(1, Math.min(200, Math.floor(params.limit)))));
        }
        if (typeof params.offset === "number" && Number.isFinite(params.offset) && params.offset > 0) {
          url.searchParams.set("offset", String(Math.max(0, Math.floor(params.offset))));
        }
        const abortController =
          typeof AbortController === "function" ? new AbortController() : null;
        const timeoutHandle =
          abortController !== null
            ? setTimeout(() => {
                abortController.abort();
              }, WORKSPACE_GIT_STATUS_TIMEOUT_MS)
            : null;

        return await fetch(url.toString(), {
          headers: originHeaders(originToken.token, { accept: "application/json" }),
          cache: "no-store",
          signal: abortController?.signal,
        }).finally(() => {
          if (timeoutHandle !== null) {
            clearTimeout(timeoutHandle);
          }
        });
      },
    );

    if (!request) {
      return null;
    }
    const { response, originToken: statusToken } = request;

    if (response.status === 404) {
      return {
        supported: false,
        dirtyCount: 0,
        dirtyPaths: [],
        pathGroups: [],
        scopePrefix: scope,
        pageOffset: 0,
        pageLimit: typeof params.limit === "number" ? params.limit : undefined,
        hasMoreFiles: false,
        error: "git status unavailable",
      };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`origin git status failed (${response.status}): ${text}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const supported = payload.supported === true;
    const dirtyCount =
      typeof payload.dirtyCount === "number"
        ? payload.dirtyCount
        : typeof payload.dirty_count === "number"
          ? payload.dirty_count
          : 0;
    const dirtyPathsRaw =
      Array.isArray(payload.dirtyPaths) ? payload.dirtyPaths : Array.isArray(payload.dirty_paths) ? payload.dirty_paths : [];
    const pathGroupsRaw = Array.isArray(payload.pathGroups)
      ? payload.pathGroups
      : Array.isArray(payload.dirtyGroups)
        ? payload.dirtyGroups
        : Array.isArray(payload.dirty_groups)
          ? payload.dirty_groups
          : [];
    const dirtyPaths = dirtyPathsRaw.reduce<WorkspaceGitDirtyPath[]>((acc, entry) => {
        const record = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null;
        const path = typeof record?.path === "string" ? record.path : "";
        const code = typeof record?.code === "string" ? record.code : "";
        const embeddedRepoRoot =
          typeof record?.embeddedRepoRoot === "string"
            ? record.embeddedRepoRoot
            : typeof record?.embedded_repo_root === "string"
              ? record.embedded_repo_root
              : null;
        if (!path) {
          return acc;
        }
        acc.push({ path, code, embeddedRepoRoot });
        return acc;
      }, []);
    const pathGroups = pathGroupsRaw.reduce<WorkspaceGitPathGroup[]>((acc, entry) => {
      const record =
        entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null;
      const prefix = typeof record?.prefix === "string" ? record.prefix : "";
      const label = typeof record?.label === "string" ? record.label : "";
      const count =
        typeof record?.count === "number" ? record.count : typeof record?.dirtyCount === "number" ? record.dirtyCount : 0;
      const embeddedRepoRoot =
        typeof record?.embeddedRepoRoot === "string"
          ? record.embeddedRepoRoot
          : typeof record?.embedded_repo_root === "string"
            ? record.embedded_repo_root
            : null;
      if (!prefix || !label || count <= 0) {
        return acc;
      }
      acc.push({ prefix, label, count, embeddedRepoRoot });
      return acc;
    }, []);
    const scopePrefix =
      typeof payload.scopePrefix === "string"
        ? payload.scopePrefix
        : typeof payload.scope_prefix === "string"
          ? payload.scope_prefix
          : scope;
    const pageOffset =
      typeof payload.pageOffset === "number"
        ? payload.pageOffset
        : typeof payload.page_offset === "number"
          ? payload.page_offset
          : 0;
    const pageLimit =
      typeof payload.pageLimit === "number"
        ? payload.pageLimit
        : typeof payload.page_limit === "number"
          ? payload.page_limit
          : typeof params.limit === "number"
            ? params.limit
            : undefined;
    const hasMoreFiles =
      payload.hasMoreFiles === true ||
      payload.has_more_files === true;
    const payloadError =
      typeof payload.error === "string" && payload.error.trim().length > 0
        ? payload.error.trim()
        : null;
    const busy = isTransientWorkspaceBusyError(payloadError);
    const error = busy ? null : payloadError;
    const stateless = payload.stateless === true;
    if (stateless && params.noteVersioningSignals !== false) {
      noteVersioningSignal(statusToken.originId, "stateless");
    }

    return {
      supported,
      dirtyCount: dirtyCount > 0 ? dirtyCount : dirtyPaths.length,
      dirtyPaths,
      pathGroups,
      scopePrefix,
      pageOffset,
      pageLimit,
      hasMoreFiles,
      stateless,
      busy,
      error,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        supported: true,
        dirtyCount: 0,
        dirtyPaths: [],
        pathGroups: [],
        scopePrefix: null,
        pageOffset: 0,
        pageLimit: typeof params.limit === "number" ? params.limit : undefined,
        hasMoreFiles: false,
        busy: false,
        error:
          "Git status is taking longer than expected (workspace may still be importing/syncing). Try Refresh in a few seconds.",
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    logControllerRequestError("[runtime-controller] fetchWorkspaceGitStatus error:", error, {
      suppressLikelyConnectionNoise: true,
    });
    if (isTransientWorkspaceBusyError(message)) {
      return {
        supported: true,
        dirtyCount: 0,
        dirtyPaths: [],
        pathGroups: [],
        scopePrefix: scope,
        pageOffset: 0,
        pageLimit: typeof params.limit === "number" ? params.limit : undefined,
        hasMoreFiles: false,
        busy: true,
        error: null,
      };
    }
    return {
      supported: true,
      dirtyCount: 0,
      dirtyPaths: [],
      pathGroups: [],
      scopePrefix: scope,
      pageOffset: 0,
      pageLimit: typeof params.limit === "number" ? params.limit : undefined,
      hasMoreFiles: false,
      busy: false,
      error: "Unable to load changes right now. Try Refresh.",
    };
  }
}

/** Legacy origins serve at most 12 history entries; newer ones up to 50. */
const LEGACY_HISTORY_LIMIT_MAX = 12;
const DEFAULT_HISTORY_LIMIT_MAX = 50;

function parseHistoryActor(value: unknown): WorkspaceGitHistoryActor | null {
  return value === "user" || value === "service" || value === "external" ? value : null;
}

export async function fetchWorkspaceGitHistoryFromController(params: {
  projectId: string;
  accessToken?: string | null;
  runtimeId?: string | null;
  originId?: string | null;
  limit?: number;
  /** Entries to skip (paging); sent only when positive. */
  skip?: number;
  routing?: WorkspaceOriginRouting;
}): Promise<WorkspaceGitHistory | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const projectId = params.projectId.trim();
  if (!projectId) {
    return null;
  }

  const limitMax =
    params.routing === "default" ? DEFAULT_HISTORY_LIMIT_MAX : LEGACY_HISTORY_LIMIT_MAX;
  const requestedLimit =
    typeof params.limit === "number" && Number.isFinite(params.limit) && params.limit > 0
      ? Math.max(1, Math.min(limitMax, Math.floor(params.limit)))
      : null;

  try {
    const request = await fetchWorkspaceOriginGitResponse(
      {
        projectId,
        protocol: "http",
        scopes: ["fs.read"],
        ...gitRouting(params.routing),
        originId: params.originId ?? null,
        accessToken: params.accessToken ?? null,
      },
      async (originToken, endpoint) => {
        const url = new URL(`${endpoint}/git/history`);
        if (requestedLimit !== null) {
          url.searchParams.set("limit", String(requestedLimit));
        }
        if (typeof params.skip === "number" && Number.isFinite(params.skip) && params.skip > 0) {
          url.searchParams.set("skip", String(Math.floor(params.skip)));
        }

        return await fetch(url.toString(), {
          headers: originHeaders(originToken.token, { accept: "application/json" }),
          cache: "no-store",
        });
      },
    );

    if (!request) {
      return null;
    }
    const { response } = request;

    if (response.status === 404) {
      return { supported: false, entries: [], branch: null, headRef: null, error: null };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`origin git history failed (${response.status}): ${text}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const supported = payload.supported === true;
    const entriesRaw = Array.isArray(payload.entries) ? payload.entries : [];
    const entries = entriesRaw.reduce<WorkspaceGitHistoryEntry[]>((acc, entry) => {
      const record = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null;
      const commit = typeof record?.commit === "string" ? record.commit : "";
      const shortCommit =
        typeof record?.shortCommit === "string"
          ? record.shortCommit
          : typeof record?.short_commit === "string"
            ? record.short_commit
            : "";
      const committedAt =
        typeof record?.committedAt === "string"
          ? record.committedAt
          : typeof record?.committed_at === "string"
            ? record.committed_at
            : "";
      const authorName =
        typeof record?.authorName === "string"
          ? record.authorName
          : typeof record?.author_name === "string"
            ? record.author_name
            : "";
      const authorEmail =
        typeof record?.authorEmail === "string"
          ? record.authorEmail
          : typeof record?.author_email === "string"
            ? record.author_email
            : "";
      const subject = typeof record?.subject === "string" ? record.subject : "";
      const resolvedBy =
        typeof record?.resolvedBy === "string"
          ? record.resolvedBy
          : typeof record?.resolved_by === "string"
            ? record.resolved_by
            : null;
      if (!commit || !shortCommit || !subject) {
        return acc;
      }
      const historyEntry: WorkspaceGitHistoryEntry = {
        commit,
        shortCommit,
        committedAt,
        authorName,
        authorEmail,
        subject,
        resolvedBy,
      };
      const firstParent =
        typeof record?.firstParent === "string" && record.firstParent.trim().length > 0
          ? record.firstParent.trim()
          : typeof record?.first_parent === "string" && record.first_parent.trim().length > 0
            ? record.first_parent.trim()
            : null;
      if (firstParent) {
        historyEntry.firstParent = firstParent;
      }
      const actor = parseHistoryActor(record?.actor);
      if (actor) {
        historyEntry.actor = actor;
      }
      acc.push(historyEntry);
      return acc;
    }, []);
    const payloadError =
      typeof payload.error === "string" && payload.error.trim().length > 0 ? payload.error.trim() : null;
    const branch =
      typeof payload.branch === "string" && payload.branch.trim().length > 0
        ? payload.branch.trim()
        : null;
    const headRef =
      typeof payload.headRef === "string"
        ? payload.headRef.trim() || null
        : typeof payload.head_ref === "string"
          ? payload.head_ref.trim() || null
          : null;
    const busy = isTransientWorkspaceBusyError(payloadError);
    const error = busy ? null : payloadError;
    const serverHasMore =
      typeof payload.hasMore === "boolean"
        ? payload.hasMore
        : typeof payload.has_more === "boolean"
          ? payload.has_more
          : null;
    // Until origins report `hasMore`, a full page means there may be more.
    const hasMore =
      serverHasMore ?? (requestedLimit !== null && entriesRaw.length >= requestedLimit);

    return { supported, entries, branch, headRef, hasMore, busy, error };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] fetchWorkspaceGitHistory error:", message);
    if (isTransientWorkspaceBusyError(message)) {
      return {
        supported: true,
        entries: [],
        branch: null,
        headRef: null,
        busy: true,
        error: null,
      };
    }
    return {
      supported: true,
      entries: [],
      branch: null,
      headRef: null,
      busy: false,
      error: "Unable to load saved versions right now. Try Refresh.",
    };
  }
}

export async function fetchWorkspaceGitDiffFromController(params: {
  projectId: string;
  path: string;
  commit?: string | null;
  // When set, the origin diffs base→commit (or base→worktree) tree-to-tree,
  // which renders real edit diffs on snapshot-history origins.
  base?: string | null;
  /** Read objects from this recovery or salvage ref (newer origins). */
  ref?: string | null;
  accessToken?: string | null;
  runtimeId?: string | null;
  originId?: string | null;
  routing?: WorkspaceOriginRouting;
}): Promise<WorkspaceGitDiff | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const projectId = params.projectId.trim();
  const path = params.path.trim();
  if (!projectId || !path) {
    return null;
  }

  try {
    const request = await fetchWorkspaceOriginGitResponse(
      {
        projectId,
        protocol: "http",
        scopes: ["fs.read"],
        ...gitRouting(params.routing),
        originId: params.originId ?? null,
        accessToken: params.accessToken ?? null,
      },
      async (originToken, endpoint) => {
        const url = new URL(`${endpoint}/git/diff`);
        url.searchParams.set("path", path);
        if (typeof params.commit === "string" && params.commit.trim().length > 0) {
          url.searchParams.set("commit", params.commit.trim());
        }
        if (typeof params.base === "string" && params.base.trim().length > 0) {
          url.searchParams.set("base", params.base.trim());
        }
        if (typeof params.ref === "string" && params.ref.trim().length > 0) {
          url.searchParams.set("ref", params.ref.trim());
        }

        return await fetch(url.toString(), {
          headers: originHeaders(originToken.token, { accept: "application/json" }),
          cache: "no-store",
        });
      },
    );

    if (!request) {
      return null;
    }
    const { response } = request;

    if (response.status === 404) {
      return {
        supported: false,
        path,
        commit: typeof params.commit === "string" ? params.commit.trim() : null,
        diff: "",
        truncated: null,
        error: "git diff unavailable",
      };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`origin git diff failed (${response.status}): ${text}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const supported = payload.supported === true;
    const diff = typeof payload.diff === "string" ? payload.diff : "";
    const responsePath =
      typeof payload.path === "string" && payload.path.trim().length > 0 ? payload.path.trim() : path;
    const responseCommit =
      typeof payload.commit === "string" && payload.commit.trim().length > 0
        ? payload.commit.trim()
        : typeof params.commit === "string" && params.commit.trim().length > 0
          ? params.commit.trim()
          : null;
    const truncated = payload.truncated === true;
    const error =
      typeof payload.error === "string" && payload.error.trim().length > 0 ? payload.error.trim() : null;

    return {
      supported,
      path: responsePath,
      commit: responseCommit,
      diff,
      truncated,
      error,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] fetchWorkspaceGitDiff error:", message);
    return null;
  }
}

export async function fetchWorkspaceGitHistoryReviewFromController(params: {
  projectId: string;
  commit: string;
  /** Read objects from this recovery or salvage ref (newer origins). */
  ref?: string | null;
  accessToken?: string | null;
  runtimeId?: string | null;
  originId?: string | null;
  routing?: WorkspaceOriginRouting;
}): Promise<WorkspaceGitHistoryReview | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const projectId = params.projectId.trim();
  const commit = params.commit.trim();
  if (!projectId || !commit) {
    return null;
  }

  // Kept for the caller when the origin answers with an error, so it can
  // tell a gateway that is still fetching (503 fetch_pending) from others.
  let errorInfo: OriginError | undefined;
  try {
    const originToken = await requestOriginAccessToken({
      projectId,
      protocol: "http",
      scopes: ["fs.read"],
      ...gitRouting(params.routing),
      originId: params.originId ?? null,
      accessToken: params.accessToken ?? null,
    });

    if (!originToken) {
      return null;
    }

    const endpoint = normalizeOriginEndpointForClient(originToken.endpoint);
    const url = new URL(`${endpoint}/git/history/review`);
    url.searchParams.set("commit", commit);
    if (typeof params.ref === "string" && params.ref.trim().length > 0) {
      url.searchParams.set("ref", params.ref.trim());
    }

    const response = await fetch(url.toString(), {
      headers: originHeaders(originToken.token, { accept: "application/json" }),
      cache: "no-store",
    });

    if (response.status === 404) {
      return { supported: false, commit, entries: [], error: "git history review unavailable" };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      errorInfo = parseOriginErrorText(response.status, text, response.headers);
      throw new Error(`origin git history review failed (${response.status}): ${text}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const supported = payload.supported === true;
    const entriesRaw = Array.isArray(payload.entries) ? payload.entries : [];
    const entries = entriesRaw.reduce<WorkspaceGitDirtyPath[]>((acc, entry) => {
      const record =
        entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null;
      const path = typeof record?.path === "string" ? record.path : "";
      const code = typeof record?.code === "string" ? record.code : "";
      const embeddedRepoRoot =
        typeof record?.embeddedRepoRoot === "string"
          ? record.embeddedRepoRoot
          : typeof record?.embedded_repo_root === "string"
            ? record.embedded_repo_root
            : null;
      if (!path) {
        return acc;
      }
      acc.push({ path, code, embeddedRepoRoot });
      return acc;
    }, []);
    const payloadError =
      typeof payload.error === "string" && payload.error.trim().length > 0 ? payload.error.trim() : null;
    const busy = isTransientWorkspaceBusyError(payloadError);
    const error = busy ? null : payloadError;

    return { supported, commit, entries, busy, error };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] fetchWorkspaceGitHistoryReview error:", message);
    if (isTransientWorkspaceBusyError(message)) {
      return {
        supported: true,
        commit,
        entries: [],
        busy: true,
        error: null,
        ...(errorInfo ? { errorInfo } : {}),
      };
    }
    return {
      supported: true,
      commit,
      entries: [],
      busy: false,
      error: "Unable to load saved version changes right now. Try Refresh.",
      ...(errorInfo ? { errorInfo } : {}),
    };
  }
}

/** Neutral subject for a sync without a caller message; never omitted. */
export const DEFAULT_SYNC_MESSAGE = "instafy: sync";

export interface SyncWorkspaceGitParams {
  projectId: string;
  message?: string | null;
  paths?: string[] | null;
  accessToken?: string | null;
  runtimeId?: string | null;
  originId?: string | null;
  leaseId?: string | null;
  leaseSeconds?: number;
  retainLease?: boolean;
  /**
   * `default` runs through the shared write-lease helper: one origin (a
   * retried token never moves the write), typed lease and token errors.
   */
  routing?: WorkspaceOriginRouting;
  /** Default routing only: retry a lease held by someone else once after this delay. */
  leaseConflictRetryDelayMs?: number | null;
}

export interface SyncWorkspaceGitResult {
  ok: boolean;
  rev?: string | null;
  /** `main` before this sync, when the origin reports it. */
  baseRev?: string | null;
  /** Present only on origins that say whether a commit was made. */
  committed?: boolean;
  /** Desktop and runtime origins: what was published and what was kept aside. */
  report?: OriginPublishReport | null;
  conflict?: boolean;
  error?: string;
  errorInfo?: OriginError;
  leaseId?: string | null;
  originId?: string | null;
  originMode?: string | null;
  originEndpoint?: string | null;
}

type OriginCallMeta = {
  leaseId: string | null;
  originId: string | null;
  originMode: string | null;
  endpoint: string | null;
};

function buildSyncResult(captured: CapturedOriginResponse, meta: OriginCallMeta): SyncWorkspaceGitResult {
  if (!captured.ok) {
    const errorInfo = parseOriginErrorText(captured.status, captured.text, captured.headers);
    return {
      ok: false,
      conflict: captured.status === 409,
      leaseId: meta.leaseId,
      originId: meta.originId,
      originMode: meta.originMode,
      originEndpoint: meta.endpoint,
      error: `origin git sync failed (${captured.status}): ${captured.text}`,
      errorInfo,
      report: errorInfo.report ?? null,
    };
  }

  const payload = parseJsonRecord(captured.text);
  const result: SyncWorkspaceGitResult = {
    ok: true,
    rev: typeof payload?.rev === "string" ? payload.rev : null,
    conflict: false,
    leaseId: meta.leaseId,
    originId: meta.originId,
    originMode: meta.originMode,
    originEndpoint: meta.endpoint,
  };
  const baseRev =
    typeof payload?.baseRev === "string"
      ? payload.baseRev
      : typeof payload?.base_rev === "string"
        ? payload.base_rev
        : null;
  if (baseRev) {
    result.baseRev = baseRev;
  }
  if (typeof payload?.committed === "boolean") {
    result.committed = payload.committed;
  }
  const report = parsePublishReport(payload);
  if (report) {
    result.report = report;
  }
  return result;
}

/**
 * Run a default-routed write (`git/sync`, `git/revert`) through the shared
 * lease helper and capture the answer. Lease and token failures come back as
 * typed errors; the lease holder's id is never kept.
 */
async function postDefaultRoutedWrite(
  params: {
    projectId: string;
    originId?: string | null;
    runtimeId?: string | null;
    accessToken?: string | null;
    leaseId?: string | null;
    leaseSeconds?: number;
    retainLease?: boolean;
    leaseConflictRetryDelayMs?: number | null;
  },
  path: string,
  body: unknown,
): Promise<
  | { ok: true; captured: CapturedOriginResponse; meta: OriginCallMeta }
  | { ok: false; error: OriginError; meta: OriginCallMeta }
> {
  try {
    return await postDefaultRoutedWriteUnchecked(params, path, body);
  } catch (error) {
    // The helper resolves every failure it knows; this keeps the exported
    // calls from ever rejecting.
    return {
      ok: false,
      error: originErrorFromException(error),
      meta: { leaseId: params.leaseId ?? null, originId: params.originId ?? null, originMode: null, endpoint: null },
    };
  }
}

async function postDefaultRoutedWriteUnchecked(
  params: {
    projectId: string;
    originId?: string | null;
    runtimeId?: string | null;
    accessToken?: string | null;
    leaseId?: string | null;
    leaseSeconds?: number;
    retainLease?: boolean;
    leaseConflictRetryDelayMs?: number | null;
  },
  path: string,
  body: unknown,
): Promise<
  | { ok: true; captured: CapturedOriginResponse; meta: OriginCallMeta }
  | { ok: false; error: OriginError; meta: OriginCallMeta }
> {
  const outcome = await withWorkspaceWriteLease(
    {
      projectId: params.projectId,
      originId: params.originId ?? null,
      runtimeId: params.runtimeId ?? null,
      accessToken: params.accessToken ?? null,
      leaseId: params.leaseId ?? null,
      leaseSeconds: params.leaseSeconds,
      retainLease: params.retainLease === true,
      leaseConflictRetryDelayMs: params.leaseConflictRetryDelayMs ?? null,
    },
    async (context) =>
      captureOriginResponse(
        await context.fetch(path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(body),
        }),
      ),
  );
  const meta: OriginCallMeta = {
    leaseId: outcome.leaseId || null,
    originId: outcome.originId || null,
    originMode: outcome.originMode || null,
    endpoint: outcome.endpoint || null,
  };
  return outcome.ok
    ? { ok: true, captured: outcome.value, meta }
    : { ok: false, error: outcome.error, meta };
}

export async function syncWorkspaceGitToRemoteFromController(
  params: SyncWorkspaceGitParams,
): Promise<SyncWorkspaceGitResult | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const projectId = params.projectId.trim();
  if (!projectId) {
    return null;
  }

  // Always send a message: origins older than the plain-subject publish
  // (the stateful gateway, older Desktop apps) otherwise write a subject
  // that names the user into permanent history.
  const message =
    typeof params.message === "string" && params.message.trim().length > 0
      ? params.message.trim()
      : DEFAULT_SYNC_MESSAGE;
  const paths =
    Array.isArray(params.paths) && params.paths.length > 0
      ? params.paths.map((path) => String(path)).filter((path) => path.trim().length > 0)
      : undefined;
  const body: Record<string, unknown> = { message };
  if (paths && paths.length > 0) {
    body.paths = paths;
  }

  if (params.routing === "default") {
    const posted = await postDefaultRoutedWrite({ ...params, projectId }, "git/sync", body);
    if (!posted.ok) {
      return {
        ok: false,
        conflict: false,
        leaseId: posted.meta.leaseId,
        originId: posted.meta.originId,
        originMode: posted.meta.originMode,
        originEndpoint: posted.meta.endpoint,
        error: posted.error.message,
        errorInfo: posted.error,
      };
    }
    return buildSyncResult(posted.captured, posted.meta);
  }

  const runtimeHint = params.runtimeId ?? null;
  const retainLease = params.retainLease === true;
  let leaseId = params.leaseId ?? null;
  let leaseIdForRelease: string | null = null;
  let acquiredLease: WorkspaceLease | null = null;

  try {
    if (!leaseId) {
      acquiredLease = await acquireWorkspaceLease({
        projectId,
        runtimeId: runtimeHint,
        leaseSeconds: params.leaseSeconds,
        metadata: null,
        accessToken: params.accessToken ?? null,
      });
      leaseId = acquiredLease.leaseId;
      leaseIdForRelease = leaseId;
    } else {
      leaseIdForRelease = leaseId;
    }

    const request = await fetchWorkspaceOriginGitResponse(
      {
        projectId,
        protocol: "http",
        scopes: ["fs.write"],
        ...gitRouting(params.routing),
        originId: params.originId ?? null,
        leaseId,
        accessToken: params.accessToken ?? null,
      },
      async (originToken, endpoint) => {
        if (originToken.leaseId) {
          leaseId = originToken.leaseId;
          leaseIdForRelease = originToken.leaseId;
        }

        return await fetch(`${endpoint}/git/sync`, {
          method: "POST",
          headers: originHeaders(originToken.token, {
            "content-type": "application/json",
            accept: "application/json",
          }),
          body: JSON.stringify(body),
        });
      },
    );

    if (!request) {
      throw new Error("failed to obtain origin token");
    }

    const { endpoint, originToken, response } = request;
    return buildSyncResult(await captureOriginResponse(response), {
      leaseId: leaseId ?? null,
      originId: originToken.originId ?? null,
      originMode: originToken.mode ?? null,
      endpoint,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] syncWorkspaceGitToRemote error:", message);
    return { ok: false, conflict: false, leaseId: leaseId ?? null, error: message };
  } finally {
    if (acquiredLease && leaseIdForRelease && !retainLease) {
      await releaseWorkspaceLease({
        projectId,
        leaseId: leaseIdForRelease,
        runtimeId: runtimeHint,
        accessToken: params.accessToken ?? null,
      }).catch(() => {});
    }
  }
}

export interface RevertWorkspaceGitResult {
  ok: boolean;
  reverted?: string[] | null;
  removed?: string[] | null;
  conflict?: boolean;
  error?: string;
  errorInfo?: OriginError;
  leaseId?: string | null;
  originId?: string | null;
  originMode?: string | null;
  originEndpoint?: string | null;
}

function buildRevertPathsResult(
  captured: CapturedOriginResponse,
  meta: OriginCallMeta,
): RevertWorkspaceGitResult {
  if (!captured.ok) {
    const errorInfo = parseOriginErrorText(captured.status, captured.text, captured.headers);
    if (errorInfo.code === "not_supported") {
      // Only the stateless gateway refuses path discards outright.
      noteVersioningSignal(meta.originId, "not_supported");
    }
    return {
      ok: false,
      conflict: captured.status === 409,
      leaseId: meta.leaseId,
      originMode: meta.originMode,
      originEndpoint: meta.endpoint,
      error: `origin git revert failed (${captured.status}): ${captured.text}`,
      errorInfo,
    };
  }

  const payload = parseJsonRecord(captured.text);
  const reverted = Array.isArray(payload?.reverted) ? (payload?.reverted as string[]) : null;
  const removed = Array.isArray(payload?.removed) ? (payload?.removed as string[]) : null;
  return {
    ok: true,
    reverted,
    removed,
    conflict: false,
    leaseId: meta.leaseId,
    originMode: meta.originMode,
    originEndpoint: meta.endpoint,
  };
}

export async function revertWorkspaceGitPathsFromController(params: {
  projectId: string;
  paths: string[];
  accessToken?: string | null;
  runtimeId?: string | null;
  originId?: string | null;
  leaseId?: string | null;
  leaseSeconds?: number;
  retainLease?: boolean;
  /** `default` runs through the shared write-lease helper (one origin, typed errors). */
  routing?: WorkspaceOriginRouting;
  /** Default routing only: retry a lease held by someone else once after this delay. */
  leaseConflictRetryDelayMs?: number | null;
}): Promise<RevertWorkspaceGitResult | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const projectId = params.projectId.trim();
  if (!projectId) {
    return null;
  }

  const paths = Array.isArray(params.paths)
    ? params.paths.map((path) => String(path)).filter((path) => path.trim().length > 0)
    : [];
  const body = { paths };

  if (params.routing === "default") {
    const posted = await postDefaultRoutedWrite({ ...params, projectId }, "git/revert", body);
    if (!posted.ok) {
      return {
        ok: false,
        conflict: false,
        leaseId: posted.meta.leaseId,
        originId: posted.meta.originId,
        originMode: posted.meta.originMode,
        originEndpoint: posted.meta.endpoint,
        error: posted.error.message,
        errorInfo: posted.error,
      };
    }
    return { ...buildRevertPathsResult(posted.captured, posted.meta), originId: posted.meta.originId };
  }

  const runtimeHint = params.runtimeId ?? null;
  const retainLease = params.retainLease === true;
  let leaseId = params.leaseId ?? null;
  let leaseIdForRelease: string | null = null;
  let acquiredLease: WorkspaceLease | null = null;

  try {
    if (!leaseId) {
      acquiredLease = await acquireWorkspaceLease({
        projectId,
        runtimeId: runtimeHint,
        leaseSeconds: params.leaseSeconds,
        metadata: null,
        accessToken: params.accessToken ?? null,
      });
      leaseId = acquiredLease.leaseId;
      leaseIdForRelease = leaseId;
    } else {
      leaseIdForRelease = leaseId;
    }

    const request = await fetchWorkspaceOriginGitResponse(
      {
        projectId,
        protocol: "http",
        scopes: ["fs.write"],
        ...gitRouting(params.routing),
        originId: params.originId ?? null,
        leaseId,
        accessToken: params.accessToken ?? null,
      },
      async (originToken, endpoint) => {
        if (originToken.leaseId) {
          leaseId = originToken.leaseId;
          leaseIdForRelease = originToken.leaseId;
        }

        return await fetch(`${endpoint}/git/revert`, {
          method: "POST",
          headers: originHeaders(originToken.token, {
            "content-type": "application/json",
            accept: "application/json",
          }),
          body: JSON.stringify(body),
        });
      },
    );

    if (!request) {
      throw new Error("failed to obtain origin token");
    }

    const { endpoint, originToken, response } = request;
    return buildRevertPathsResult(await captureOriginResponse(response), {
      leaseId: leaseId ?? null,
      originId: originToken.originId ?? null,
      originMode: originToken.mode ?? null,
      endpoint,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] revertWorkspaceGitPaths error:", message);
    return { ok: false, conflict: false, leaseId: leaseId ?? null, error: message };
  } finally {
    if (acquiredLease && leaseIdForRelease && !retainLease) {
      await releaseWorkspaceLease({
        projectId,
        leaseId: leaseIdForRelease,
        runtimeId: runtimeHint,
        accessToken: params.accessToken ?? null,
      }).catch(() => {});
    }
  }
}

export interface RevertWorkspaceGitCommitResult {
  ok: boolean;
  rev?: string | null;
  baseRev?: string | null;
  /**
   * False when the change was already undone and nothing was committed.
   * Absent when the origin does not say (older origins).
   */
  committed?: boolean;
  /** Desktop and runtime origins answer with a publish report. */
  report?: OriginPublishReport | null;
  conflict?: boolean;
  code?: string;
  paths?: string[];
  /** The controller or origin has no revert route yet. */
  routeUnavailable?: boolean;
  error?: string;
  errorInfo?: OriginError;
  originId?: string | null;
  originMode?: string | null;
  originEndpoint?: string | null;
}

export const REVERT_ROUTE_UNAVAILABLE_MESSAGE =
  "Reverting isn't available on this server yet. Ask the agent to undo it instead.";

/**
 * What legacy mode answers. Reverting never worked against the stateful
 * gateway (the request could not get a write token), and it stays that way:
 * legacy callers get the same failure without any request being made.
 */
const LEGACY_REVERT_UNAVAILABLE_ERROR = "failed to obtain origin token";

type CapturedOriginResponse = {
  ok: boolean;
  status: number;
  text: string;
  headers: Headers;
};

async function captureOriginResponse(response: Response): Promise<CapturedOriginResponse> {
  const text = await response.text().catch(() => "");
  return { ok: response.ok, status: response.status, text, headers: response.headers };
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  if (!text) {
    return null;
  }
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch (_error) {
    return null;
  }
}

function readPayloadString(
  payload: Record<string, unknown> | null,
  ...keys: string[]
): string | null {
  if (!payload) {
    return null;
  }
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

/**
 * Forward-revert a commit that already landed on canonical main. History is
 * never rewritten; the origin creates and pushes a new revert commit.
 *
 * Only the `stateless` and `desktop` modes revert, and they call this with
 * `routing: "default"`. Legacy routing (the stateful gateway, the default
 * for older callers) makes no request at all and answers as it always has.
 *
 * The write token needs a project lease, so one is acquired for the call and
 * released after it. `base` (the first parent) lets newer origins revert a
 * merge; it is only sent when given.
 */
export async function revertWorkspaceGitCommitFromController(params: {
  projectId: string;
  commit: string;
  base?: string | null;
  accessToken?: string | null;
  originId?: string | null;
  runtimeId?: string | null;
  /** Must be `default`; anything else never reaches the origin. */
  routing?: WorkspaceOriginRouting;
  leaseConflictRetryDelayMs?: number | null;
}): Promise<RevertWorkspaceGitCommitResult | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const projectId = params.projectId.trim();
  const commit = params.commit.trim();
  if (!projectId || !commit) {
    return null;
  }

  if (params.routing !== "default") {
    return {
      ok: false,
      conflict: false,
      routeUnavailable: true,
      code: "not_supported",
      error: LEGACY_REVERT_UNAVAILABLE_ERROR,
      errorInfo: {
        status: 0,
        code: "not_supported",
        message: "reverting a saved version is not available in this mode",
        routeUnavailable: true,
      },
    };
  }

  const body: Record<string, unknown> = { commit };
  const base = typeof params.base === "string" ? params.base.trim() : "";
  if (base) {
    body.base = base;
  }

  try {
    const outcome = await withWorkspaceWriteLease(
      {
        projectId,
        originId: params.originId ?? null,
        runtimeId: params.runtimeId ?? null,
        accessToken: params.accessToken ?? null,
        leaseConflictRetryDelayMs: params.leaseConflictRetryDelayMs ?? null,
      },
      async (context) =>
        captureOriginResponse(
          await context.fetch("git/revert-commit", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify(body),
          }),
        ),
    );

    if (!outcome.ok) {
      return {
        ok: false,
        conflict: false,
        code: outcome.error.code,
        error: outcome.error.message,
        errorInfo: outcome.error,
        originId: outcome.originId,
        originMode: outcome.originMode,
        originEndpoint: outcome.endpoint,
      };
    }

    const { value: captured, originId, originMode, endpoint } = outcome;
    if (!captured.ok) {
      const errorInfo = parseOriginErrorText(captured.status, captured.text, captured.headers);
      const result: RevertWorkspaceGitCommitResult = {
        ok: false,
        conflict: captured.status === 409,
        routeUnavailable: errorInfo.routeUnavailable,
        error: errorInfo.routeUnavailable
          ? REVERT_ROUTE_UNAVAILABLE_MESSAGE
          : `origin git revert-commit failed (${captured.status}): ${captured.text}`,
        errorInfo,
        report: errorInfo.report ?? null,
        originId,
        originMode,
        originEndpoint: endpoint,
      };
      if (errorInfo.code) {
        result.code = errorInfo.code;
      }
      if (errorInfo.paths) {
        result.paths = errorInfo.paths;
      }
      return result;
    }

    const payload = parseJsonRecord(captured.text);
    const report = parsePublishReport(payload);
    const result: RevertWorkspaceGitCommitResult = {
      ok: true,
      rev: readPayloadString(payload, "rev"),
      conflict: false,
      originId,
      originMode,
      originEndpoint: endpoint,
    };
    const baseRev = readPayloadString(payload, "baseRev", "base_rev");
    if (baseRev) {
      result.baseRev = baseRev;
    }
    if (typeof payload?.committed === "boolean") {
      result.committed = payload.committed;
      if (payload.committed) {
        noteVersioningSignal(originId, "committed");
      }
    } else if (report?.gitSyncStatus === "unchanged") {
      result.committed = false;
    }
    if (report) {
      result.report = report;
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] revertWorkspaceGitCommit error:", message);
    return { ok: false, conflict: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Unsaved work (recovery and salvage refs)
// ---------------------------------------------------------------------------

export type WorkspaceRecoveryKind = "conflict" | "unpublished" | "unsaved" | "stale" | "salvage";

export interface WorkspaceRecoveryEntry {
  ref: string;
  rev: string;
  kind: WorkspaceRecoveryKind | (string & Record<never, never>);
  subject: string;
  date: string | null;
  /** The origin that kept the work, when the ref names one. */
  origin: string | null;
  /** For `conflict` entries only the conflicted paths; otherwise every path. */
  paths: string[];
  /** Merge base with `main`: the base for review and restore diffs. */
  base: string | null;
  /** Salvage entries are permanent and cannot be removed. */
  dismissible: boolean;
  /** Set when `main` already holds a restore of this entry (salvage refs stay). */
  restoredRev?: string | null;
}

export type WorkspaceRecoveryList =
  | {
      status: "ok";
      entries: WorkspaceRecoveryEntry[];
      originId: string | null;
      originMode: string | null;
    }
  | {
      /** No recovery route on this controller or origin (older servers). */
      status: "unsupported";
      entries: [];
      originId: string | null;
      originMode: string | null;
    }
  | {
      status: "error";
      entries: [];
      error: OriginError;
      originId: string | null;
      originMode: string | null;
    };

const SALVAGE_REF_PREFIX = "refs/instafy/salvage/";

function parseRecoveryEntry(value: unknown): WorkspaceRecoveryEntry | null {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const ref = readPayloadString(record, "ref");
  const rev = readPayloadString(record, "rev");
  if (!record || !ref || !rev) {
    return null;
  }
  // The git service treats salvage refs in any letter case.
  const isSalvage = ref.toLowerCase().startsWith(SALVAGE_REF_PREFIX);
  const entry: WorkspaceRecoveryEntry = {
    ref,
    rev,
    kind: readPayloadString(record, "kind") ?? (isSalvage ? "salvage" : "unpublished"),
    subject: readPayloadString(record, "subject") ?? "",
    date: readPayloadString(record, "date", "committedAt", "committed_at"),
    origin: readPayloadString(record, "origin", "originId", "origin_id"),
    paths: readOriginPathList(record.paths),
    base: readPayloadString(record, "base"),
    dismissible:
      typeof record.dismissible === "boolean" ? record.dismissible : !isSalvage,
  };
  const restoredRev = readPayloadString(record, "restoredRev", "restored_rev");
  if (restoredRev) {
    entry.restoredRev = restoredRev;
  }
  return entry;
}

/**
 * List unsaved work kept on recovery and salvage refs. A 404 (an older
 * controller or origin without the route) is `unsupported`, never an error.
 */
export async function fetchWorkspaceRecoveryFromController(params: {
  projectId: string;
  originId?: string | null;
  accessToken?: string | null;
}): Promise<WorkspaceRecoveryList | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }
  const projectId = params.projectId.trim();
  if (!projectId) {
    return null;
  }

  let originId: string | null = params.originId?.trim() || null;
  let originMode: string | null = null;
  try {
    const request = await fetchWorkspaceOriginGitResponse(
      {
        projectId,
        protocol: "http",
        scopes: ["fs.read"],
        originId,
        accessToken: params.accessToken ?? null,
      },
      async (originToken, endpoint) =>
        await fetch(`${endpoint}/git/recovery`, {
          headers: originHeaders(originToken.token, { accept: "application/json" }),
          cache: "no-store",
        }),
    );
    if (!request) {
      return {
        status: "error",
        entries: [],
        error: {
          status: 0,
          code: "token_unavailable",
          message: "failed to obtain origin token",
          routeUnavailable: false,
        },
        originId,
        originMode,
      };
    }
    originId = request.originToken.originId ?? originId;
    originMode = request.originToken.mode ?? null;
    const captured = await captureOriginResponse(request.response);
    if (captured.status === 404) {
      noteVersioningSignal(originId, "recovery_unsupported");
      return { status: "unsupported", entries: [], originId, originMode };
    }
    if (!captured.ok) {
      return {
        status: "error",
        entries: [],
        error: parseOriginErrorText(captured.status, captured.text, captured.headers),
        originId,
        originMode,
      };
    }
    let payload: unknown = null;
    try {
      payload = captured.text ? (JSON.parse(captured.text) as unknown) : null;
    } catch (_error) {
      payload = null;
    }
    const rawEntries = Array.isArray(payload)
      ? payload
      : payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>).entries)
        ? ((payload as Record<string, unknown>).entries as unknown[])
        : null;
    if (!rawEntries) {
      return {
        status: "error",
        entries: [],
        error: {
          status: captured.status,
          message: "unexpected recovery list response",
          routeUnavailable: false,
        },
        originId,
        originMode,
      };
    }
    noteVersioningSignal(originId, "recovery_supported");
    const entries = rawEntries
      .map(parseRecoveryEntry)
      .filter((entry): entry is WorkspaceRecoveryEntry => entry !== null);
    return { status: "ok", entries, originId, originMode };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] fetchWorkspaceRecovery error:", message);
    return {
      status: "error",
      entries: [],
      error: {
        status: 0,
        code: error instanceof Error && error.name === "AbortError" ? "timeout" : "network_error",
        message,
        routeUnavailable: false,
      },
      originId,
      originMode,
    };
  }
}

export interface WorkspaceRecoveryWriteFailure {
  ok: false;
  /** `lease`/`token`: before the request; `request`: no answer; `response`: an error answer. */
  stage: "lease" | "token" | "request" | "response";
  error: OriginError;
  originId: string | null;
  originMode: string | null;
}

export interface RestoreWorkspaceRecoveryParams {
  projectId: string;
  ref: string;
  /** The tip the user saw; a moved ref answers 409 `recovery_ref_moved`. */
  rev?: string | null;
  /** Newest known `main`, for the gateway's compare-and-swap. */
  baseRev?: string | null;
  /** Paths to leave as they are on `main` (reported back in `notRestored`). */
  keep?: string[] | null;
  originId?: string | null;
  runtimeId?: string | null;
  accessToken?: string | null;
  leaseConflictRetryDelayMs?: number | null;
}

export type RestoreWorkspaceRecoveryResult =
  | {
      ok: true;
      rev: string | null;
      baseRev: string | null;
      committed: boolean | null;
      notRestored: string[];
      refDeleted: boolean;
      originId: string;
      originMode: string;
    }
  | WorkspaceRecoveryWriteFailure;

export interface DismissWorkspaceRecoveryParams {
  projectId: string;
  ref: string;
  rev: string;
  originId?: string | null;
  runtimeId?: string | null;
  accessToken?: string | null;
  leaseConflictRetryDelayMs?: number | null;
}

export type DismissWorkspaceRecoveryResult =
  | {
      ok: true;
      dismissed: boolean;
      /** The ref was already gone. */
      missing: boolean;
      originId: string;
      originMode: string;
    }
  | WorkspaceRecoveryWriteFailure;

async function postRecoveryWrite(
  params: {
    projectId: string;
    originId?: string | null;
    runtimeId?: string | null;
    accessToken?: string | null;
    leaseConflictRetryDelayMs?: number | null;
  },
  path: string,
  body: Record<string, unknown>,
): Promise<
  | { ok: true; payload: Record<string, unknown> | null; originId: string; originMode: string }
  | WorkspaceRecoveryWriteFailure
> {
  const outcome = await withWorkspaceWriteLease(
    {
      projectId: params.projectId.trim(),
      originId: params.originId ?? null,
      runtimeId: params.runtimeId ?? null,
      accessToken: params.accessToken ?? null,
      leaseConflictRetryDelayMs: params.leaseConflictRetryDelayMs ?? null,
    },
    async (context) =>
      captureOriginResponse(
        await context.fetch(path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(body),
        }),
      ),
  );
  if (!outcome.ok) {
    return {
      ok: false,
      stage: outcome.stage,
      error: outcome.error,
      originId: outcome.originId,
      originMode: outcome.originMode,
    };
  }
  const captured = outcome.value;
  if (!captured.ok) {
    return {
      ok: false,
      stage: "response",
      error: parseOriginErrorText(captured.status, captured.text, captured.headers),
      originId: outcome.originId,
      originMode: outcome.originMode,
    };
  }
  return {
    ok: true,
    payload: parseJsonRecord(captured.text),
    originId: outcome.originId,
    originMode: outcome.originMode,
  };
}

/** Restore unsaved work onto `main` as a new version. */
export async function restoreWorkspaceRecoveryFromController(
  params: RestoreWorkspaceRecoveryParams,
): Promise<RestoreWorkspaceRecoveryResult | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }
  const ref = params.ref.trim();
  if (!params.projectId.trim() || !ref) {
    return null;
  }
  const body: Record<string, unknown> = { ref };
  const rev = params.rev?.trim();
  if (rev) {
    body.rev = rev;
  }
  const baseRev = params.baseRev?.trim();
  if (baseRev) {
    body.baseRev = baseRev;
  }
  const keep = Array.from(
    new Set((params.keep ?? []).map((path) => String(path).trim()).filter((path) => path.length > 0)),
  );
  if (keep.length > 0) {
    body.keep = keep;
  }

  const result = await postRecoveryWrite(params, "git/recovery/restore", body);
  if (!result.ok) {
    return result;
  }
  const payload = result.payload;
  return {
    ok: true,
    rev: readPayloadString(payload, "rev"),
    baseRev: readPayloadString(payload, "baseRev", "base_rev"),
    committed: typeof payload?.committed === "boolean" ? payload.committed : null,
    notRestored: readOriginPathList(payload?.notRestored ?? payload?.not_restored),
    refDeleted: payload?.refDeleted === true || payload?.ref_deleted === true,
    originId: result.originId,
    originMode: result.originMode,
  };
}

/** Remove unsaved work for everyone in the space. Salvage refs refuse (409 `salvage_ref_kept`). */
export async function dismissWorkspaceRecoveryFromController(
  params: DismissWorkspaceRecoveryParams,
): Promise<DismissWorkspaceRecoveryResult | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }
  const ref = params.ref.trim();
  const rev = params.rev.trim();
  if (!params.projectId.trim() || !ref || !rev) {
    return null;
  }
  const result = await postRecoveryWrite(params, "git/recovery/dismiss", { ref, rev });
  if (!result.ok) {
    return result;
  }
  const payload = result.payload;
  const missing = payload?.missing === true;
  return {
    ok: true,
    dismissed: typeof payload?.dismissed === "boolean" ? payload.dismissed : !missing,
    missing,
    originId: result.originId,
    originMode: result.originMode,
  };
}
