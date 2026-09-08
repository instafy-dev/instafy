import { createContext, useContext, type ReactNode } from "react";
import type { BuildLogEntry } from "../../types";

export type PrivateChatTarget = {
  userId: string;
  displayName: string;
};

export interface WorkspaceControlsContextValue {
  userEmail: string | null;
  homeAttentionCount?: number;
  /** Unread inbox items per project id (cross-org), for switcher badges. */
  homeAttentionByProject?: Record<string, number>;
  /** Unread inbox items per org key (orgId or "personal"), for the team menu. */
  homeAttentionByOrg?: Record<string, number>;
  onSignOut?: () => void;
  activeProjectName: string | null;
  onShowLogs?: () => void;
  hasLogs: boolean;
  buildLogs?: BuildLogEntry[];
  sidebarCollapsed?: boolean;
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  onOpenChatNavigation?: () => void;
  onStartNewProject?: (preferredOrgId?: string | null) => void;
  onStartNewConversation?: () => void;
  onStartPrivateConversation?: (target: PrivateChatTarget) => void;
  showChatActions?: boolean;
  onOpenProjectPicker?: () => void;
  onOpenOrgSettings?: () => void;
  onOpenProjectSettings?: () => void;
  onOpenProfileSettings?: () => void;
  onOpenBugReport?: () => void;
  onOpenBugReportInbox?: () => void;
  supportUnreadCount?: number;
  topbarLocationOverride?: {
    title: string;
    icon?: ReactNode;
  } | null;
  shakeToReportEnabled?: boolean;
  onToggleShakeToReport?: (enabled: boolean) => void | Promise<void>;
  onSimulateShakeToReport?: () => void;
  onTestShakeToReport?: () => void;
  shakeToReportStatus?: string;
  shakeToReportDetail?: string | null;
}

interface WorkspaceControlsProviderProps {
  value: WorkspaceControlsContextValue;
  children: ReactNode;
}

const defaultWorkspaceControls: WorkspaceControlsContextValue = {
  userEmail: null,
  homeAttentionCount: 0,
  homeAttentionByProject: {},
  homeAttentionByOrg: {},
  onSignOut: undefined,
  activeProjectName: null,
  onShowLogs: undefined,
  hasLogs: false,
  buildLogs: [],
  sidebarCollapsed: undefined,
  sidebarOpen: undefined,
  onToggleSidebar: undefined,
  onOpenChatNavigation: undefined,
  onStartNewProject: undefined,
  onStartNewConversation: undefined,
  onStartPrivateConversation: undefined,
  showChatActions: undefined,
  onOpenProjectPicker: undefined,
  onOpenOrgSettings: undefined,
  onOpenProjectSettings: undefined,
  onOpenProfileSettings: undefined,
  onOpenBugReport: undefined,
  onOpenBugReportInbox: undefined,
  supportUnreadCount: 0,
  topbarLocationOverride: null,
  shakeToReportEnabled: false,
  onToggleShakeToReport: undefined,
  onSimulateShakeToReport: undefined,
  onTestShakeToReport: undefined,
  shakeToReportStatus: undefined,
  shakeToReportDetail: null,
};

const WorkspaceControlsContext = createContext<WorkspaceControlsContextValue>(
  defaultWorkspaceControls,
);

export function WorkspaceControlsProvider({
  value,
  children,
}: WorkspaceControlsProviderProps) {
  return (
    <WorkspaceControlsContext.Provider value={value}>
      {children}
    </WorkspaceControlsContext.Provider>
  );
}

export function useWorkspaceControls(): WorkspaceControlsContextValue {
  return useContext(WorkspaceControlsContext);
}
