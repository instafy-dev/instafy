import { queueGithubImportFollowup } from "../../../conversations/githubImportFollowup";
import { controllerClient } from "../../../sdk/instafy";
import {
  deriveGithubImportTargetPath,
} from "../../../services/runtimeController/githubImportPath";

const {
  importGithub: importGithubProject,
} = controllerClient.projects;

export interface GithubImportResumeAction {
  kind: "github_import";
  repo: string;
  ref: string | null;
  targetPath: string | null;
  promptMessage: string | null;
  idempotencyKey: string | null;
}

export interface ExecuteGithubProjectImportParams {
  projectId: string;
  repo: string;
  ref?: string | null;
  targetPath?: string | null;
  githubDeviceAuthSessionId?: string | null;
  idempotencyKey?: string | null;
  queueFollowup?: boolean;
}

export interface ExecuteGithubProjectImportResult {
  success: boolean;
  error?: string | null;
  rev?: string | null;
  fileCount?: number | null;
  bytesWritten?: number | null;
  targetPath?: string | null;
  /** Non-blocking heads-up about workload fit (large repo, heavy toolchain). */
  notice?: string | null;
  errorCode?: string | null;
  status?: number | null;
}

// The hosted machine is web-focused (Node, Python, browsers) with 2 CPU/4 GB;
// these ecosystems usually want a bigger box and their toolchains aren't
// preinstalled. The import still proceeds — this only sets expectations.
const HEAVY_TOOLCHAIN_LANGUAGES = new Set(["rust", "go", "java", "c++", "c", "kotlin", "swift", "c#"]);
const IMPORT_BLOCK_SIZE_KB = 1_000_000; // ~1 GiB, mirrors the backend archive cap
const IMPORT_WARN_SIZE_KB = 500_000;

interface GithubRepoFit {
  notice: string | null;
}

function parseGithubOwnerRepo(repo: string): string | null {
  const trimmed = repo.trim().replace(/\.git$/, "");
  const urlMatch = trimmed.match(/github\.com[/:]([^/]+)\/([^/#?]+)/i);
  if (urlMatch) {
    return `${urlMatch[1]}/${urlMatch[2]}`;
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

/**
 * Pre-flight fit check before the import starts: one public GitHub API call
 * for size + primary language. Catches "too large" before the user waits out
 * a doomed upload, and sets expectations for heavy toolchains. Fails open on
 * any API error (private repos, rate limits, network).
 */
async function checkGithubRepoFit(repo: string): Promise<GithubRepoFit> {
  const ownerRepo = parseGithubOwnerRepo(repo);
  if (!ownerRepo) {
    return { notice: null };
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const response = await fetch(`https://api.github.com/repos/${ownerRepo}`, {
      signal: controller.signal,
      headers: { accept: "application/vnd.github+json" },
    });
    clearTimeout(timeout);
    if (!response.ok) {
      return { notice: null };
    }
    const payload = (await response.json()) as { size?: number; language?: string | null };
    const sizeKb = typeof payload.size === "number" ? payload.size : 0;
    const language = typeof payload.language === "string" ? payload.language.trim() : "";

    const notices: string[] = [];
    // GitHub's `size` counts full git history while the import cap applies to
    // a single-ref archive, so a large `size` is a warning sign, not proof —
    // never hard-block on it. If the archive really is over the cap, the
    // import fails with the friendly rewrite below.
    if (sizeKb > IMPORT_BLOCK_SIZE_KB) {
      notices.push(
        `Heads up: ${ownerRepo} is very large (~${(sizeKb / 1_000_000).toFixed(1)} GB of git data). ` +
          "If the import exceeds the hosted machine's limit, connect it from your own machine instead (no size limit).",
      );
    } else if (sizeKb > IMPORT_WARN_SIZE_KB) {
      notices.push(
        `Heads up: ${ownerRepo} is large (~${Math.round(sizeKb / 1000)} MB) — the import may take a while.`,
      );
    }
    if (language && HEAVY_TOOLCHAIN_LANGUAGES.has(language.toLowerCase())) {
      notices.push(
        `Heads up: the hosted machine is web-focused (Node, Python, browsers). For ${language} projects, your own machine usually works better.`,
      );
    }
    return { notice: notices.length > 0 ? notices.join(" ") : null };
  } catch {
    return { notice: null };
  }
}

/** Backend archive-cap errors are ops jargon; translate for humans. */
function friendlyImportError(error: string): string {
  if (/archive.*too large|too large.*archive|MAX_ARCHIVE_BYTES/i.test(error)) {
    return (
      "This repository is too large for a hosted machine. " +
      "Connect it from your own machine instead — no size limit."
    );
  }
  return error;
}

function dispatchWorkspaceCommit(projectId: string) {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent("instafy:workspace-commit", { detail: { projectId } }),
  );
}

export function parseGithubImportResumeAction(
  details: Record<string, unknown> | null | undefined,
): GithubImportResumeAction | null {
  const record = details ?? {};
  const rawResumeAction =
    (record["resumeAction"] && typeof record["resumeAction"] === "object"
      ? (record["resumeAction"] as Record<string, unknown>)
      : null) ??
    (record["resume_action"] && typeof record["resume_action"] === "object"
      ? (record["resume_action"] as Record<string, unknown>)
      : null);
  if (!rawResumeAction) {
    return null;
  }
  const kind =
    typeof rawResumeAction.kind === "string" ? rawResumeAction.kind.trim().toLowerCase() : "";
  if (kind !== "github_import") {
    return null;
  }
  const repo =
    typeof rawResumeAction.repo === "string" ? rawResumeAction.repo.trim() : "";
  if (!repo) {
    return null;
  }
  return {
    kind: "github_import",
    repo,
    ref:
      typeof rawResumeAction.ref === "string" && rawResumeAction.ref.trim().length > 0
        ? rawResumeAction.ref.trim()
        : null,
    targetPath:
      typeof rawResumeAction.targetPath === "string" && rawResumeAction.targetPath.trim().length > 0
        ? rawResumeAction.targetPath.trim()
        : null,
    promptMessage:
      typeof rawResumeAction.promptMessage === "string" && rawResumeAction.promptMessage.trim().length > 0
        ? rawResumeAction.promptMessage.trim()
        : null,
    idempotencyKey:
      typeof rawResumeAction.idempotencyKey === "string" &&
      rawResumeAction.idempotencyKey.trim().length > 0
        ? rawResumeAction.idempotencyKey.trim()
        : typeof rawResumeAction.idempotency_key === "string" &&
            rawResumeAction.idempotency_key.trim().length > 0
          ? rawResumeAction.idempotency_key.trim()
          : null,
  };
}

export function formatGithubImportSuccessMessage(params: {
  repo: string;
  fileCount?: number | null;
  targetPath?: string | null;
}) {
  const count =
    typeof params.fileCount === "number"
      ? `${params.fileCount} ${params.fileCount === 1 ? "file" : "files"}`
      : "your files";
  const targetSuffix =
    typeof params.targetPath === "string" && params.targetPath.trim().length > 0
      ? ` into \`${params.targetPath.trim()}\``
      : "";
  return `Imported ${count} from ${params.repo}${targetSuffix}.`;
}

export async function executeGithubProjectImport(
  params: ExecuteGithubProjectImportParams,
): Promise<ExecuteGithubProjectImportResult> {
  const projectId = params.projectId.trim();
  const repo = params.repo.trim();
  if (!projectId) {
    return { success: false, error: "projectId is required." };
  }
  if (!repo) {
    return { success: false, error: "repo is required." };
  }

  const fallbackTargetPath =
    typeof params.targetPath === "string" && params.targetPath.trim().length > 0
      ? params.targetPath.trim()
      : deriveGithubImportTargetPath(repo);

  const fit = await checkGithubRepoFit(repo);

  const importResult = await importGithubProject({
    projectId,
    repo,
    ref: params.ref ?? null,
    targetPath: fallbackTargetPath,
    githubDeviceAuthSessionId: params.githubDeviceAuthSessionId ?? null,
    idempotencyKey: params.idempotencyKey ?? null,
  });
  if (!importResult.success) {
    return {
      success: false,
      error: friendlyImportError(importResult.error ?? "GitHub import failed."),
      errorCode: importResult.errorCode ?? null,
      status: importResult.status ?? null,
    };
  }

  dispatchWorkspaceCommit(projectId);

  const resolvedTargetPath =
    typeof importResult.targetPath === "string" && importResult.targetPath.trim().length > 0
      ? importResult.targetPath.trim()
      : fallbackTargetPath;

  if (params.queueFollowup ?? true) {
    queueGithubImportFollowup({
      projectId,
      repo,
      ref: params.ref ?? null,
      targetPath: resolvedTargetPath,
      fileCount: importResult.fileCount ?? null,
    });
  }

  return {
    success: true,
    rev: importResult.rev ?? null,
    fileCount: importResult.fileCount ?? null,
    bytesWritten: importResult.bytesWritten ?? null,
    targetPath: resolvedTargetPath,
    notice: fit.notice,
  };
}
