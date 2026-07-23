// hook where we use useProjects and useProject hook maybe? or a provider?
import { createContext, useContext, useMemo, useReducer } from "react";
import type { ReactNode } from "react";
import type { StudioPanel } from "../screens/studio/types";

interface WorkspaceUiState {
  activePanel: StudioPanel;
  isProjectLauncherOpen: boolean;
  pendingConversationInviteId: string | null;
}

type WorkspaceUiAction =
  | { type: "setActivePanel"; panel: StudioPanel }
  | { type: "setProjectLauncherOpen"; open: boolean }
  | { type: "setPendingConversationInviteId"; conversationId: string | null };

interface WorkspaceUiContextValue extends WorkspaceUiState {
  setActivePanel: (panel: StudioPanel) => void;
  setIsProjectLauncherOpen: (open: boolean) => void;
  requestConversationInvite: (conversationId: string) => void;
  clearConversationInvite: () => void;
}

const WorkspaceUiContext = createContext<WorkspaceUiContextValue | null>(null);

const initialState: WorkspaceUiState = {
  activePanel: "chat",
  isProjectLauncherOpen: false,
  pendingConversationInviteId: null,
};

function reducer(state: WorkspaceUiState, action: WorkspaceUiAction): WorkspaceUiState {
  switch (action.type) {
    case "setActivePanel":
      if (state.activePanel === action.panel) {
        return state;
      }
      return { ...state, activePanel: action.panel };
    case "setProjectLauncherOpen":
      if (state.isProjectLauncherOpen === action.open) {
        return state;
      }
      return { ...state, isProjectLauncherOpen: action.open };
    case "setPendingConversationInviteId":
      if (state.pendingConversationInviteId === action.conversationId) {
        return state;
      }
      return { ...state, pendingConversationInviteId: action.conversationId };
    default:
      return state;
  }
}

export function WorkspaceUiProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const value = useMemo<WorkspaceUiContextValue>(
    () => ({
      ...state,
      setActivePanel: (panel) => dispatch({ type: "setActivePanel", panel }),
      setIsProjectLauncherOpen: (open) => dispatch({ type: "setProjectLauncherOpen", open }),
      requestConversationInvite: (conversationId) =>
        dispatch({
          type: "setPendingConversationInviteId",
          conversationId: conversationId.trim() ? conversationId.trim() : null,
        }),
      clearConversationInvite: () =>
        dispatch({ type: "setPendingConversationInviteId", conversationId: null }),
    }),
    [state]
  );

  return <WorkspaceUiContext.Provider value={value}>{children}</WorkspaceUiContext.Provider>;
}

export function useWorkspaceUi(): WorkspaceUiContextValue {
  const context = useContext(WorkspaceUiContext);
  if (!context) {
    throw new Error("useWorkspaceUi must be used within a WorkspaceUiProvider");
  }
  return context;
}
