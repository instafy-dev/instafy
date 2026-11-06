import type { ComponentProps } from "react";
import { LIST_ROW_FOCUS_RING, LIST_ROW_SURFACE_BASE, listRowSurfaceToneClassName } from "../../../components/listRowStyles";
import { Badge } from "../../../components/Badge";
import type { WorkspaceGitReviewEntry } from "../../../workspace/gitReviewTypes";

export function getStatusBadge(
  rawCode: string,
): { label: string; title: string; className: string; tone: ComponentProps<typeof Badge>["tone"] } | null {
  const code = rawCode.trim() || rawCode;
  if (!code) {
    return null;
  }

  if (code !== "??" && code.includes("U")) {
    return {
      label: "!",
      title: "Merge conflict",
      className: "text-rose-600 dark:text-rose-300",
      tone: "danger",
    };
  }

  if (code === "??") {
    return {
      label: "U",
      title: "Untracked",
      className: "text-emerald-600 dark:text-emerald-300",
      tone: "success",
    };
  }

  if (code.includes("A")) {
    return {
      label: "A",
      title: "Added",
      className: "text-emerald-600 dark:text-emerald-300",
      tone: "success",
    };
  }

  if (code.includes("D")) {
    return {
      label: "D",
      title: "Deleted",
      className: "text-rose-600 dark:text-rose-300",
      tone: "danger",
    };
  }

  if (code.includes("R")) {
    return {
      label: "R",
      title: "Renamed",
      className: "text-indigo-600 dark:text-indigo-300",
      tone: "info",
    };
  }

  if (code.includes("M")) {
    return {
      label: "M",
      title: "Modified",
      className: "text-sky-600 dark:text-sky-300",
      tone: "neutral",
    };
  }

  return {
    label: code,
    title: "Change",
    className: "text-slate-500 dark:text-slate-300",
    tone: "neutral",
  };
}

export function formatEmbeddedRepoLabel(root: string): string {
  const normalized = root.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return normalized || "Embedded repo";
}

export function formatEmbeddedRepoTitle(root: string): string {
  return `Embedded repo: ${formatEmbeddedRepoLabel(root)}. Saving versions applies to the outer space history; inner branches and PRs stay separate.`;
}

export function formatRelativeCommitTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }

  const diffMs = timestamp - Date.now();
  const diffMinutes = Math.round(diffMs / 60_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(diffMinutes) < 60) {
    return formatter.format(diffMinutes, "minute");
  }
  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) {
    return formatter.format(diffHours, "hour");
  }
  return formatter.format(Math.round(diffHours / 24), "day");
}

export function parseSavedVersionSubject(subject: string): {
  summary: string;
  fullSubject: string;
  systemLabel: string | null;
} {
  const fullSubject = subject.trim() || "Untitled version";
  const systemMatch = /^instafy:\s*(.+)$/i.exec(fullSubject);
  if (systemMatch) {
    const summary = systemMatch[1]?.trim() || "Instafy update";
    return {
      summary,
      fullSubject,
      systemLabel: "Instafy",
    };
  }
  return {
    summary: fullSubject,
    fullSubject,
    systemLabel: null,
  };
}

/**
 * The title of a new space's first versions: git-service's seed, the
 * controller's first write of the space's default files and the machine's own
 * setup commit (git-service `INIT_COMMIT_MESSAGE`, `SPACE_CREATED_TITLE` in
 * runtime-controller and runtime-agent).
 */
export const SPACE_CREATED_TITLE = "Space created";

function isSpaceCreated(entry: { subject: string }): boolean {
  return entry.subject.trim() === SPACE_CREATED_TITLE;
}

/**
 * Saved versions as History lists them, newest first. A new space is made in
 * more than one version, one after another and each "Space created" (a local
 * test, Nov 5, listed two): for the person that is one version, the newest of
 * them, which holds the space as its setup left it.
 */
export function withOneSpaceCreated<T extends { subject: string }>(entries: readonly T[]): T[] {
  return entries.filter((entry, index) => !(index > 0 && isSpaceCreated(entry) && isSpaceCreated(entries[index - 1])));
}

export function sanitizeReviewPathTestId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

export function WorkspaceGitReviewPathList({
  entries,
  previewPath,
  onSelectPath,
  dataTestId = "git-review-files",
  testIdPrefix = "git-review-path",
}: {
  entries: WorkspaceGitReviewEntry[];
  previewPath: string | null;
  onSelectPath: (path: string) => void;
  dataTestId?: string;
  testIdPrefix?: string;
}) {
  return (
    <div className="flex flex-col gap-1 px-1" data-testid={dataTestId}>
      {entries.map((entry) => {
        const badge = getStatusBadge(entry.code);
        const previewSelected = previewPath === entry.path;
        const embeddedRepoRoot =
          typeof entry.embeddedRepoRoot === "string" && entry.embeddedRepoRoot.trim().length > 0
            ? formatEmbeddedRepoLabel(entry.embeddedRepoRoot)
            : null;
        const embeddedRepoTitle = embeddedRepoRoot ? formatEmbeddedRepoTitle(embeddedRepoRoot) : null;

        return (
          <button
            key={entry.path}
            type="button"
            className={[
              LIST_ROW_SURFACE_BASE,
              "w-full px-2 py-2 text-left",
              listRowSurfaceToneClassName(previewSelected),
              LIST_ROW_FOCUS_RING,
            ].join(" ")}
            onClick={() => onSelectPath(entry.path)}
            data-testid={`${testIdPrefix}-${sanitizeReviewPathTestId(entry.path)}`}
          >
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">{entry.path}</div>
                {embeddedRepoRoot ? (
                  <div
                    className="truncate text-xxs text-sky-700/90 dark:text-sky-300/90"
                    title={embeddedRepoTitle ?? undefined}
                  >
                    Embedded repo
                  </div>
                ) : null}
              </div>
              {badge ? (
                <span
                  className={["select-none font-mono text-xs font-semibold", badge.className].join(" ")}
                  title={badge.title}
                  aria-label={badge.title}
                >
                  {badge.label}
                </span>
              ) : null}
            </div>
          </button>
        );
      })}
    </div>
  );
}
