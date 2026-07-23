import type { ReactNode } from "react";

export type DockDirection = "horizontal" | "vertical";

export interface DockTabDescriptor {
  id: string;
  title: string;
  icon?: ReactNode;
  dirty?: boolean;
  closable?: boolean;
  minRatio?: number;
  maxRatio?: number;
  content: ReactNode;
  onClose?: () => void;
}

export interface DockTabRef {
  id: string;
}

export interface DockStackNode {
  id: string;
  type: "stack";
  tabs: DockTabRef[];
  activeTabId: string | null;
  minRatio?: number;
  maxRatio?: number;
}

export interface DockSplitChild {
  nodeId: string;
  size: number;
  minRatio?: number;
  maxRatio?: number;
}

export interface DockSplitNode {
  id: string;
  type: "split";
  direction: DockDirection;
  children: DockSplitChild[];
}

export type DockNode = DockStackNode | DockSplitNode;

export interface DockLayoutState {
  rootId: string;
  nodes: Record<string, DockNode>;
  tabs: Record<string, DockTabDescriptor>;
}

export function createInitialDockLayout(): DockLayoutState {
  const stack: DockStackNode = {
    id: "dock-root",
    type: "stack",
    tabs: [],
    activeTabId: null
  };

  return {
    rootId: stack.id,
    nodes: {
      [stack.id]: stack
    },
    tabs: {}
  };
}

export function isStackNode(node: DockNode): node is DockStackNode {
  return node.type === "stack";
}

export function isSplitNode(node: DockNode): node is DockSplitNode {
  return node.type === "split";
}

export function clampSplitSizes(children: DockSplitChild[]): DockSplitChild[] {
  if (children.length === 0) {
    return children;
  }
  const total = children.reduce((sum, child) => sum + child.size, 0);
  if (total === 0) {
    const evenSize = 100 / children.length;
    return children.map((child) => ({ ...child, size: evenSize }));
  }
  return children.map((child) => ({ ...child, size: (child.size / total) * 100 }));
}
