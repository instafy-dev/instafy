import type { WorkspaceGitDirtyPath } from "../sdk/instafy";

export type GitReviewMode = "focused" | "all";

export type WorkspaceGitReviewEntry = Pick<
  WorkspaceGitDirtyPath,
  "path" | "code" | "embeddedRepoRoot"
> & {
  diffPreview?: string | null;
  previewMode?: "diff" | "content";
  synthetic?: boolean;
  truncated?: boolean;
};

export type WorkspaceGitReviewSource =
  | {
      kind: "workingTree";
      title?: string;
      entries: WorkspaceGitReviewEntry[];
      initialPath?: string | null;
      initialMode?: GitReviewMode;
    }
  | {
      kind: "savedVersion";
      commit: string;
      shortCommit: string;
      title: string;
      committedAt: string;
      entries?: WorkspaceGitReviewEntry[];
      initialPath?: string | null;
      initialMode?: GitReviewMode;
      /**
       * Set by History (stateless and desktop modes): read the version from
       * the default origin, pinned. Absent for the legacy Changes drawer,
       * whose reviews keep today's routing.
       */
      routing?: "default";
      originId?: string | null;
    }
  | {
      /** Work kept on a recovery ref, reviewed read-only. */
      kind: "unsavedWork";
      ref: string;
      rev: string;
      /** Merge base with `main`; diffs run base..rev. */
      base: string | null;
      title: string;
      date: string | null;
      entries: WorkspaceGitReviewEntry[];
      originId: string | null;
      initialPath?: string | null;
      initialMode?: GitReviewMode;
    };
