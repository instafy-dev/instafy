import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  type ReactNode
} from "react";
import {
  clampSplitSizes,
  createInitialDockLayout,
  isStackNode,
  type DockLayoutState,
  type DockNode,
  type DockSplitNode,
  type DockStackNode,
  type DockTabDescriptor
} from "./dockingTypes";

type DockAction =
  | { type: "registerTab"; descriptor: DockTabDescriptor }
  | { type: "updateTab"; id: string; patch: Partial<DockTabDescriptor> }
  | { type: "unregisterTab"; id: string }
  | { type: "ensureStack"; stackId: string }
  | { type: "openTabInStack"; stackId: string; tabId: string; activate: boolean; index?: number }
  | { type: "moveTabInStack"; stackId: string; tabId: string; targetIndex: number }
  | { type: "closeTabInStack"; stackId: string; tabId: string }
  | { type: "setActiveTab"; stackId: string; tabId: string | null }
  | { type: "replaceNode"; node: DockNode };

function dockingReducer(state: DockLayoutState, action: DockAction): DockLayoutState {
  switch (action.type) {
    case "registerTab": {
      if (state.tabs[action.descriptor.id]) {
        return {
          ...state,
          tabs: {
            ...state.tabs,
            [action.descriptor.id]: action.descriptor
          }
        };
      }
      return {
        ...state,
        tabs: {
          ...state.tabs,
          [action.descriptor.id]: action.descriptor
        }
      };
    }
    case "updateTab": {
      const existing = state.tabs[action.id];
      if (!existing) {
        return state;
      }
      return {
        ...state,
        tabs: {
          ...state.tabs,
          [action.id]: {
            ...existing,
            ...action.patch
          }
        }
      };
    }
    case "unregisterTab": {
      if (!state.tabs[action.id]) {
        return state;
      }
      const nextTabs = { ...state.tabs };
      delete nextTabs[action.id];
      return {
        ...state,
        tabs: nextTabs
      };
    }
    case "ensureStack": {
      if (state.nodes[action.stackId]) {
        return state;
      }
      const stack: DockStackNode = {
        id: action.stackId,
        type: "stack",
        tabs: [],
        activeTabId: null
      };
      return {
        ...state,
        nodes: {
          ...state.nodes,
          [stack.id]: stack
        }
      };
    }
    case "openTabInStack": {
      const node = state.nodes[action.stackId];
      if (!node || !isStackNode(node)) {
        return state;
      }
      if (node.tabs.some((tab) => tab.id === action.tabId)) {
        const activeTabId = action.activate ? action.tabId : node.activeTabId;
        return {
          ...state,
          nodes: {
            ...state.nodes,
            [node.id]: {
              ...node,
              activeTabId
            }
          }
        };
      }
      const nextTabs = [...node.tabs];
      if (typeof action.index === "number" && action.index >= 0 && action.index <= nextTabs.length) {
        nextTabs.splice(action.index, 0, { id: action.tabId });
      } else {
        nextTabs.push({ id: action.tabId });
      }
      return {
        ...state,
        nodes: {
          ...state.nodes,
          [node.id]: {
            ...node,
            tabs: nextTabs,
            activeTabId: action.activate ? action.tabId : node.activeTabId ?? action.tabId
          }
        }
      };
    }
    case "closeTabInStack": {
      const node = state.nodes[action.stackId];
      if (!node || !isStackNode(node)) {
        return state;
      }
      if (!node.tabs.some((tab) => tab.id === action.tabId)) {
        return state;
      }
      const nextTabs = node.tabs.filter((tab) => tab.id !== action.tabId);
      const nextActive =
        node.activeTabId === action.tabId
          ? nextTabs[nextTabs.length - 1]?.id ?? null
          : node.activeTabId;
      return {
        ...state,
        nodes: {
          ...state.nodes,
          [node.id]: {
            ...node,
            tabs: nextTabs,
            activeTabId: nextActive
          }
        }
      };
    }
    case "moveTabInStack": {
      const node = state.nodes[action.stackId];
      if (!node || !isStackNode(node)) {
        return state;
      }
      const currentIndex = node.tabs.findIndex((tab) => tab.id === action.tabId);
      if (currentIndex === -1) {
        return state;
      }
      const targetIndex = Math.max(0, Math.min(action.targetIndex, node.tabs.length - 1));
      if (currentIndex === targetIndex) {
        return state;
      }
      const nextTabs = [...node.tabs];
      const [moved] = nextTabs.splice(currentIndex, 1);
      nextTabs.splice(targetIndex, 0, moved);
      return {
        ...state,
        nodes: {
          ...state.nodes,
          [node.id]: {
            ...node,
            tabs: nextTabs
          }
        }
      };
    }
    case "setActiveTab": {
      const node = state.nodes[action.stackId];
      if (!node || !isStackNode(node)) {
        return state;
      }
      if (node.activeTabId === action.tabId) {
        return state;
      }
      return {
        ...state,
        nodes: {
          ...state.nodes,
          [node.id]: {
            ...node,
            activeTabId: action.tabId
          }
        }
      };
    }
    case "replaceNode": {
      const prev = state.nodes[action.node.id];
      const nextNode =
        action.node.type === "split"
          ? {
              ...action.node,
              children: clampSplitSizes(action.node.children)
            }
          : action.node;
      if (prev && JSON.stringify(prev) === JSON.stringify(nextNode)) {
        return state;
      }
      return {
        ...state,
        nodes: {
          ...state.nodes,
          [nextNode.id]: nextNode
        }
      };
    }
    default:
      return state;
  }
}

interface DockingContextValue {
  layout: DockLayoutState;
  rootStackId: string;
  getNode: (nodeId: string) => DockNode | null;
  getStackTabs: (stackId: string) => DockTabDescriptor[];
  openTab: (descriptor: DockTabDescriptor, options?: { stackId?: string; activate?: boolean; index?: number }) => void;
  updateTab: (id: string, patch: Partial<DockTabDescriptor>) => void;
  closeTab: (id: string) => void;
  focusTab: (id: string) => void;
  moveTab: (stackId: string, tabId: string, targetIndex: number) => void;
  ensureSplitNode: (node: DockSplitNode) => void;
}

const DockingContext = createContext<DockingContextValue | null>(null);

function findTabStack(state: DockLayoutState, tabId: string): DockStackNode | null {
  const nodes = Object.values(state.nodes);
  for (const node of nodes) {
    if (isStackNode(node) && node.tabs.some((tab) => tab.id === tabId)) {
      return node;
    }
  }
  return null;
}

export function DockingProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(dockingReducer, undefined, () => createInitialDockLayout());

  const ensureStack = useCallback(
    (stackId: string) => {
      dispatch({ type: "ensureStack", stackId });
    },
    [dispatch]
  );

  const getNode = useCallback(
    (nodeId: string) => {
      const node = state.nodes[nodeId];
      return node ?? null;
    },
    [state.nodes]
  );

  const getStackTabs = useCallback(
    (stackId: string) => {
      const node = state.nodes[stackId];
      if (!node || !isStackNode(node)) {
        return [];
      }
      return node.tabs
        .map((tab) => state.tabs[tab.id])
        .filter(Boolean) as DockTabDescriptor[];
    },
    [state.nodes, state.tabs]
  );

  const openTab = useCallback(
    (descriptor: DockTabDescriptor, options?: { stackId?: string; activate?: boolean; index?: number }) => {
      const targetStackId = options?.stackId ?? state.rootId;
      ensureStack(targetStackId);
      dispatch({ type: "registerTab", descriptor });
      dispatch({
        type: "openTabInStack",
        stackId: targetStackId,
        tabId: descriptor.id,
        activate: options?.activate ?? true,
        index: options?.index
      });
    },
    [ensureStack, state.rootId]
  );

  const updateTab = useCallback(
    (id: string, patch: Partial<DockTabDescriptor>) => {
      dispatch({ type: "updateTab", id, patch });
    },
    []
  );

  const closeTab = useCallback(
    (id: string) => {
      const stack = findTabStack(state, id);
      const tab = state.tabs[id];
      if (!stack || !tab) {
        return;
      }
      tab.onClose?.();
      dispatch({ type: "closeTabInStack", stackId: stack.id, tabId: id });
      dispatch({ type: "unregisterTab", id });
    },
    [state]
  );

  const focusTab = useCallback(
    (id: string) => {
      const stack = findTabStack(state, id);
      if (!stack) {
        return;
      }
      dispatch({ type: "setActiveTab", stackId: stack.id, tabId: id });
    },
    [state]
  );

  const moveTab = useCallback(
    (stackId: string, tabId: string, targetIndex: number) => {
      dispatch({ type: "moveTabInStack", stackId, tabId, targetIndex });
    },
    []
  );

  const ensureSplitNode = useCallback(
    (node: DockSplitNode) => {
      dispatch({ type: "replaceNode", node });
    },
    []
  );

  const value = useMemo<DockingContextValue>(
    () => ({
      layout: state,
      rootStackId: state.rootId,
      getNode,
      getStackTabs,
      openTab,
      updateTab,
      closeTab,
      focusTab,
      moveTab,
      ensureSplitNode
    }),
    [closeTab, ensureSplitNode, focusTab, getNode, getStackTabs, moveTab, openTab, state, updateTab]
  );

  return <DockingContext.Provider value={value}>{children}</DockingContext.Provider>;
}

export function useDocking(): DockingContextValue {
  const context = useContext(DockingContext);
  if (!context) {
    throw new Error("useDocking must be used within a DockingProvider");
  }
  return context;
}
