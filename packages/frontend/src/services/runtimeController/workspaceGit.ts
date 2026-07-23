import { normalizeOriginEndpointForClient, runtimeControllerEnabled } from "./core";
import { logControllerRequestError } from "./logging";
import {
  requestOriginAccessToken,
  type OriginAccessTokenResponse,
  type RequestOriginAccessTokenParams,
} from "./origins";
import { acquireWorkspaceLease, releaseWorkspaceLease, type WorkspaceLease } from "./workspaceLeases";

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
}

export interface WorkspaceGitHistory {
  supported: boolean;
  entries: WorkspaceGitHistoryEntry[];
  branch?: string | null;
  headRef?: string | null;
  busy?: boolean;
  error?: string | null;
}

type OriginGitFetchResult = {
  endpoint: string;
  originToken: OriginAccessTokenResponse;
  response: Response;
};

async function fetchWorkspaceOriginGitResponse(
  tokenParams: RequestOriginAccessTokenParams,
  execute: (
    originToken: OriginAccessTokenResponse,
    endpoint: string,
  ) => Promise<Response>,
): Promise<OriginGitFetchResult | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const originToken = await requestOriginAccessToken({
      ...tokenParams,
      forceRefresh: attempt > 0,
    });

    if (!originToken) {
      return null;
    }

    const endpoint = normalizeOriginEndpointForClient(originToken.endpoint);
    const response = await execute(originToken, endpoint);
    if (response.status === 401 && attempt === 0) {
      continue;
    }

    return { endpoint, originToken, response };
  }

  return null;
}

export interface WorkspaceGitHistoryReview {
  supported: boolean;
  commit: string | null;
  entries: WorkspaceGitDirtyPath[];
  busy?: boolean;
  error?: string | null;
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
        preferHosted: true,
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
          headers: {
            authorization: `Bearer ${originToken.token}`,
            accept: "application/json",
          },
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
    const { response } = request;

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

    return {
      supported,
      dirtyCount: dirtyCount > 0 ? dirtyCount : dirtyPaths.length,
      dirtyPaths,
      pathGroups,
      scopePrefix,
      pageOffset,
      pageLimit,
      hasMoreFiles,
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

export async function fetchWorkspaceGitHistoryFromController(params: {
  projectId: string;
  accessToken?: string | null;
  runtimeId?: string | null;
  originId?: string | null;
  limit?: number;
}): Promise<WorkspaceGitHistory | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const projectId = params.projectId.trim();
  if (!projectId) {
    return null;
  }

  try {
    const request = await fetchWorkspaceOriginGitResponse(
      {
        projectId,
        protocol: "http",
        scopes: ["fs.read"],
        preferHosted: true,
        originId: params.originId ?? null,
        accessToken: params.accessToken ?? null,
      },
      async (originToken, endpoint) => {
        const url = new URL(`${endpoint}/git/history`);
        if (
          typeof params.limit === "number" &&
          Number.isFinite(params.limit) &&
          params.limit > 0
        ) {
          url.searchParams.set(
            "limit",
            String(Math.max(1, Math.min(12, Math.floor(params.limit)))),
          );
        }

        return await fetch(url.toString(), {
          headers: {
            authorization: `Bearer ${originToken.token}`,
            accept: "application/json",
          },
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
      acc.push({ commit, shortCommit, committedAt, authorName, authorEmail, subject, resolvedBy });
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

    return { supported, entries, branch, headRef, busy, error };
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
  accessToken?: string | null;
  runtimeId?: string | null;
  originId?: string | null;
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
        preferHosted: true,
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

        return await fetch(url.toString(), {
          headers: {
            authorization: `Bearer ${originToken.token}`,
            accept: "application/json",
          },
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
  accessToken?: string | null;
  runtimeId?: string | null;
  originId?: string | null;
}): Promise<WorkspaceGitHistoryReview | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const projectId = params.projectId.trim();
  const commit = params.commit.trim();
  if (!projectId || !commit) {
    return null;
  }

  try {
    const originToken = await requestOriginAccessToken({
      projectId,
      protocol: "http",
      scopes: ["fs.read"],
      preferHosted: true,
      originId: params.originId ?? null,
      accessToken: params.accessToken ?? null,
    });

    if (!originToken) {
      return null;
    }

    const endpoint = normalizeOriginEndpointForClient(originToken.endpoint);
    const url = new URL(`${endpoint}/git/history/review`);
    url.searchParams.set("commit", commit);

    const response = await fetch(url.toString(), {
      headers: {
        authorization: `Bearer ${originToken.token}`,
        accept: "application/json",
      },
      cache: "no-store",
    });

    if (response.status === 404) {
      return { supported: false, commit, entries: [], error: "git history review unavailable" };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
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
      };
    }
    return {
      supported: true,
      commit,
      entries: [],
      busy: false,
      error: "Unable to load saved version changes right now. Try Refresh.",
    };
  }
}

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
}

export interface SyncWorkspaceGitResult {
  ok: boolean;
  rev?: string | null;
  conflict?: boolean;
  error?: string;
  leaseId?: string | null;
  originMode?: string | null;
  originEndpoint?: string | null;
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

    const message =
      typeof params.message === "string" && params.message.trim().length > 0
        ? params.message.trim()
        : "instafy: sync";
    const paths =
      Array.isArray(params.paths) && params.paths.length > 0
        ? params.paths.map((path) => String(path)).filter((path) => path.trim().length > 0)
        : undefined;
    const body: Record<string, unknown> = { message };
    if (paths && paths.length > 0) {
      body.paths = paths;
    }

    const request = await fetchWorkspaceOriginGitResponse(
      {
        projectId,
        protocol: "http",
        scopes: ["fs.write"],
        preferHosted: true,
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
          headers: {
            authorization: `Bearer ${originToken.token}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(body),
        });
      },
    );

    if (!request) {
      throw new Error("failed to obtain origin token");
    }

    const { endpoint, originToken, response } = request;

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const message = `origin git sync failed (${response.status}): ${text}`;
      return {
        ok: false,
        conflict: response.status === 409,
        leaseId: leaseId ?? null,
        originMode: originToken.mode ?? null,
        originEndpoint: endpoint,
        error: message,
      };
    }

    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const rev = typeof payload?.rev === "string" ? payload.rev : null;
    return {
      ok: true,
      rev,
      conflict: false,
      leaseId: leaseId ?? null,
      originMode: originToken.mode ?? null,
      originEndpoint: endpoint,
    };
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
  leaseId?: string | null;
  originMode?: string | null;
  originEndpoint?: string | null;
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
}): Promise<RevertWorkspaceGitResult | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const projectId = params.projectId.trim();
  if (!projectId) {
    return null;
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

    const paths = Array.isArray(params.paths)
      ? params.paths.map((path) => String(path)).filter((path) => path.trim().length > 0)
      : [];
    const body = { paths };

    const request = await fetchWorkspaceOriginGitResponse(
      {
        projectId,
        protocol: "http",
        scopes: ["fs.write"],
        preferHosted: true,
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
          headers: {
            authorization: `Bearer ${originToken.token}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(body),
        });
      },
    );

    if (!request) {
      throw new Error("failed to obtain origin token");
    }

    const { endpoint, originToken, response } = request;

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const message = `origin git revert failed (${response.status}): ${text}`;
      return {
        ok: false,
        conflict: response.status === 409,
        leaseId: leaseId ?? null,
        originMode: originToken.mode ?? null,
        originEndpoint: endpoint,
        error: message,
      };
    }

    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const reverted = Array.isArray(payload?.reverted) ? (payload?.reverted as string[]) : null;
    const removed = Array.isArray(payload?.removed) ? (payload?.removed as string[]) : null;
    return {
      ok: true,
      reverted,
      removed,
      conflict: false,
      leaseId: leaseId ?? null,
      originMode: originToken.mode ?? null,
      originEndpoint: endpoint,
    };
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
  conflict?: boolean;
  error?: string;
  originMode?: string | null;
  originEndpoint?: string | null;
}

/**
 * Forward-revert a commit that already landed on canonical main. History is
 * never rewritten; the origin creates and pushes a new revert commit.
 */
export async function revertWorkspaceGitCommitFromController(params: {
  projectId: string;
  commit: string;
  accessToken?: string | null;
  originId?: string | null;
}): Promise<RevertWorkspaceGitCommitResult | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const projectId = params.projectId.trim();
  const commit = params.commit.trim();
  if (!projectId || !commit) {
    return null;
  }

  try {
    const request = await fetchWorkspaceOriginGitResponse(
      {
        projectId,
        protocol: "http",
        scopes: ["fs.write"],
        preferHosted: true,
        originId: params.originId ?? null,
        leaseId: null,
        accessToken: params.accessToken ?? null,
      },
      async (originToken, endpoint) => {
        return await fetch(`${endpoint}/git/revert-commit`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${originToken.token}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ commit }),
        });
      },
    );

    if (!request) {
      throw new Error("failed to obtain origin token");
    }

    const { endpoint, originToken, response } = request;

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const message = `origin git revert-commit failed (${response.status}): ${text}`;
      return {
        ok: false,
        conflict: response.status === 409,
        originMode: originToken.mode ?? null,
        originEndpoint: endpoint,
        error: message,
      };
    }

    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const rev = typeof payload?.rev === "string" ? payload.rev : null;
    return {
      ok: true,
      rev,
      conflict: false,
      originMode: originToken.mode ?? null,
      originEndpoint: endpoint,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] revertWorkspaceGitCommit error:", message);
    return { ok: false, conflict: false, error: message };
  }
}
