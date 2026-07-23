import type { ReactNode } from "react";
import {
  ChatLines,
  Clock,
  Coins,
  Cpu,
  DotsGrid3x3,
  Folder,
  GitBranch,
  Globe,
  Lock,
  Page,
  Puzzle,
  Settings,
} from "iconoir-react";
import { HomeIcon } from "../components/AppIcons";
import type { CodeFile } from "../types";
import type { ChatMessageCommitRange, StudioPanel } from "../screens/studio/types";
import type { ConversationState } from "../conversations/ConversationsProvider";
import type { WorkspaceGitReviewSource } from "./gitReviewTypes";

export interface WorkspaceConversationTabState {
  kind: "conversation";
  id: string;
  conversationId: string;
  title: string;
  icon?: ReactNode;
  closable: boolean;
  dirty: boolean;
  badge: string | null;
  draggable: boolean;
}

export interface WorkspaceJobThreadTabState {
  kind: "jobThread";
  id: string;
  conversationId: string;
  jobId: string;
  title: string;
  icon?: ReactNode;
  closable: boolean;
  dirty: boolean;
  badge: string | null;
  draggable: boolean;
}

export interface WorkspaceExplorerTabState {
  kind: "explorer";
  id: string;
  rootPath: string;
  title: string;
  icon?: ReactNode;
  closable: boolean;
  dirty: boolean;
  badge: string | null;
  draggable: boolean;
}

export interface WorkspaceGitDiffTabState {
  kind: "gitDiff";
  id: string;
  path: string;
  // When set, the tab shows the pinned base..head diff of one run instead of
  // the current worktree/HEAD chain (matching the chat diff cards).
  commitRange: ChatMessageCommitRange | null;
  title: string;
  icon?: ReactNode;
  closable: boolean;
  dirty: boolean;
  badge: string | null;
  draggable: boolean;
}

export interface WorkspaceGitReviewTabState {
  kind: "gitReview";
  id: string;
  review: WorkspaceGitReviewSource;
  returnTabId: string | null;
  title: string;
  icon?: ReactNode;
  closable: boolean;
  dirty: boolean;
  badge: string | null;
  draggable: boolean;
}

export interface WorkspacePanelTabState {
  kind: "panel";
  id: string;
  panel: StudioPanel;
  title: string;
  icon?: ReactNode;
  closable: boolean;
  dirty: boolean;
  badge: string | null;
  draggable: boolean;
}

export interface WorkspaceFileTabState {
  kind: "file";
  id: string;
  panel: "code";
  title: string;
  icon?: ReactNode;
  closable: boolean;
  dirty: boolean;
  fileId: string;
  filePath: string;
  badge: string | null;
  draggable: boolean;
}

export type WorkspaceTabState =
  | WorkspacePanelTabState
  | WorkspaceFileTabState
  | WorkspaceConversationTabState
  | WorkspaceJobThreadTabState
  | WorkspaceExplorerTabState
  | WorkspaceGitDiffTabState
  | WorkspaceGitReviewTabState;

const TAB_ICON_CLASS = "h-5 w-5";
const HOME_TAB_ICON_CLASS = "h-[19px] w-[19px]";
const CONVERSATION_TAB_ICON = (
  <ChatLines className={TAB_ICON_CLASS} aria-hidden="true" />
);
const PRIVATE_CONVERSATION_TAB_ICON = (
  <span className="relative inline-flex items-center justify-center">
    <ChatLines className={TAB_ICON_CLASS} aria-hidden="true" />
    <Lock
      className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-white p-[1px] text-slate-500 shadow-sm dark:bg-slate-950 dark:text-slate-300"
      aria-hidden="true"
    />
  </span>
);

export const PANEL_META: Record<
  StudioPanel,
  { title: string; icon?: ReactNode; closable: boolean }
> = {
  home: {
    title: "Home",
    icon: <HomeIcon className={HOME_TAB_ICON_CLASS} />,
    closable: true,
  },
  chat: {
    title: "Assistant",
    icon: <ChatLines className={TAB_ICON_CLASS} aria-hidden="true" />,
    closable: true,
  },
  credits: {
    title: "Credits",
    icon: <Coins className={TAB_ICON_CLASS} aria-hidden="true" />,
    closable: true,
  },
  code: {
    title: "Files",
    icon: <Page className={TAB_ICON_CLASS} aria-hidden="true" />,
    closable: true,
  },
  extensions: {
    title: "Extensions",
    icon: <Globe className={TAB_ICON_CLASS} aria-hidden="true" />,
    closable: true,
  },
  skills: {
    title: "Skills",
    icon: <Puzzle className={TAB_ICON_CLASS} aria-hidden="true" />,
    closable: true,
  },
  secrets: {
    title: "Secrets",
    icon: <Lock className={TAB_ICON_CLASS} aria-hidden="true" />,
    closable: true,
  },
  ai: {
    title: "AI",
    icon: <Cpu className={TAB_ICON_CLASS} aria-hidden="true" />,
    closable: true,
  },
  automations: {
    title: "Automations",
    icon: <Clock className={TAB_ICON_CLASS} aria-hidden="true" />,
    closable: true,
  },
  sourceControl: {
    title: "Changes",
    icon: <GitBranch className={TAB_ICON_CLASS} aria-hidden="true" />,
    closable: true,
  },
  projects: {
    title: "Spaces",
    icon: <DotsGrid3x3 className={TAB_ICON_CLASS} aria-hidden="true" />,
    closable: true,
  },
  settings: {
    title: "Settings",
    icon: <Settings className={TAB_ICON_CLASS} aria-hidden="true" />,
    closable: true,
  },
};

export function getTabIdForPanel(panel: StudioPanel): string {
  return `workspace-tab-${panel}`;
}

export function getTabIdForFile(fileId: string): string {
  return `workspace-file-${fileId}`;
}

export function getTabIdForConversation(conversationId: string): string {
  return `workspace-conversation-${conversationId}`;
}

export function getTabIdForJobThread(jobId: string): string {
  return `workspace-job-thread-${jobId}`;
}

export function getTabIdForGitDiff(path: string): string {
  return `workspace-git-diff-${encodeURIComponent(path)}`;
}

export function createTabForPanel(panel: StudioPanel): WorkspacePanelTabState {
  const meta = PANEL_META[panel];
  return {
    kind: "panel",
    id: getTabIdForPanel(panel),
    panel,
    title: meta.title,
    icon: meta.icon,
    closable: meta.closable,
    dirty: false,
    badge: null,
    draggable: false,
  };
}

export function createTabForFile(
  file: Pick<CodeFile, "id" | "path" | "label">,
): WorkspaceFileTabState {
  return {
    kind: "file",
    id: getTabIdForFile(file.id),
    panel: "code",
    title: file.label ?? file.path,
    icon: <Page className={TAB_ICON_CLASS} aria-hidden="true" />,
    closable: true,
    dirty: false,
    fileId: file.id,
    filePath: file.path,
    badge: null,
    draggable: true,
  };
}

export function formatUnreadBadge(unreadCount: number): string | null {
  if (unreadCount <= 0) {
    return null;
  }
  if (unreadCount > 9) {
    return "9+";
  }
  return unreadCount.toString();
}

export function getConversationTabIcon(
  visibility: ConversationState["visibility"],
): ReactNode {
  return visibility === "private"
    ? PRIVATE_CONVERSATION_TAB_ICON
    : CONVERSATION_TAB_ICON;
}

export function createTabForConversation(
  conversation: ConversationState,
): WorkspaceConversationTabState {
  return {
    kind: "conversation",
    id: getTabIdForConversation(conversation.localId),
    conversationId: conversation.localId,
    title: conversation.title,
    icon: getConversationTabIcon(conversation.visibility),
    closable: true,
    dirty: false,
    badge: formatUnreadBadge(conversation.unreadCount),
    draggable: true,
  };
}

export function createTabForJobThread(params: {
  conversationId: string;
  jobId: string;
  title?: string;
}): WorkspaceJobThreadTabState {
  const title = params.title?.trim() ? params.title.trim() : "Run";
  return {
    kind: "jobThread",
    id: getTabIdForJobThread(params.jobId),
    conversationId: params.conversationId,
    jobId: params.jobId,
    title,
    icon: <ChatLines className={TAB_ICON_CLASS} aria-hidden="true" />,
    closable: true,
    dirty: false,
    badge: null,
    draggable: false,
  };
}

let explorerSequence = 0;

export function normalizeExplorerPath(path: string): string {
  if (!path) {
    return "";
  }
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

export function createExplorerTab(
  rootPath: string,
  title: string,
): WorkspaceExplorerTabState {
  explorerSequence += 1;
  return {
    kind: "explorer",
    id: `workspace-explorer-${explorerSequence}`,
    rootPath,
    title,
    icon: <Folder className={TAB_ICON_CLASS} aria-hidden="true" />,
    closable: true,
    dirty: false,
    badge: null,
    draggable: true,
  };
}

export function createGitDiffTab(
  path: string,
  title: string,
  commitRange: ChatMessageCommitRange | null = null,
): WorkspaceGitDiffTabState {
  return {
    kind: "gitDiff",
    id: getTabIdForGitDiff(path),
    path,
    commitRange,
    title,
    icon: <GitBranch className={TAB_ICON_CLASS} aria-hidden="true" />,
    closable: true,
    dirty: false,
    badge: null,
    draggable: true,
  };
}

let gitReviewSequence = 0;

export function createGitReviewTab(
  review: WorkspaceGitReviewSource,
  returnTabId: string | null,
  options?: { id?: string },
): WorkspaceGitReviewTabState {
  const providedId = options?.id?.trim() ?? "";
  if (!providedId) {
    gitReviewSequence += 1;
  } else {
    const match = /^workspace-git-review-(\d+)$/.exec(providedId);
    const parsed = match ? Number.parseInt(match[1] ?? "", 10) : Number.NaN;
    if (Number.isFinite(parsed)) {
      gitReviewSequence = Math.max(gitReviewSequence, parsed);
    }
  }
  const title =
    review.kind === "savedVersion"
      ? `Review ${review.shortCommit}`
      : review.title?.trim().length
        ? review.title.trim()
        : "Review changes";
  return {
    kind: "gitReview",
    id: providedId || `workspace-git-review-${gitReviewSequence}`,
    review,
    returnTabId,
    title,
    icon: <GitBranch className={TAB_ICON_CLASS} aria-hidden="true" />,
    closable: true,
    dirty: false,
    badge: null,
    draggable: true,
  };
}
