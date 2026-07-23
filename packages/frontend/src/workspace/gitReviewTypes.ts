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
    };
