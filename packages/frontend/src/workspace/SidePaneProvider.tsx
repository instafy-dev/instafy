import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { DockingProvider, useDocking } from "./DockingProvider";
import { isStackNode, type DockTabDescriptor } from "./dockingTypes";

interface SidePaneTabConfig {
  id: string;
  title: string;
  icon?: ReactNode;
  content: ReactNode;
  closable?: boolean;
  dirty?: boolean;
  minRatio?: number;
  maxRatio?: number;
  onClose?: () => void;
}

interface SidePaneTabState extends SidePaneTabConfig {
  minRatio: number;
  maxRatio: number;
  closable: boolean;
}

interface SidePaneContextValue {
  tabs: SidePaneTabState[];
  activeTab: SidePaneTabState | null;
  activeTabId: string | null;
  sideVisible: boolean;
  ratio: number;
  setRatio: (ratio: number) => void;
  openTab: (tab: SidePaneTabConfig, options?: { activate?: boolean }) => void;
  closeTab: (id: string) => void;
  focusTab: (id: string) => void;
  moveTab: (id: string, targetIndex: number) => void;
  updateTab: (id: string, patch: Partial<SidePaneTabConfig>) => void;
  clearTabs: () => void;
}

const DEFAULT_RATIO = 0.38;
const MIN_RATIO = 0.2;
const MAX_RATIO = 0.75;
const STORAGE_KEY = "instafy.sidePaneLayout";

const SidePaneContext = createContext<SidePaneContextValue | null>(null);

function clampRatio(value: number, min: number = MIN_RATIO, max: number = MAX_RATIO): number {
  if (!Number.isFinite(value)) {
    return clampRatio(DEFAULT_RATIO, min, max);
  }
  return Math.max(min, Math.min(max, value));
}

function loadPersistedState(): { ratio: number; savedRatios: Record<string, number> } {
  if (typeof window === "undefined") {
    return { ratio: DEFAULT_RATIO, savedRatios: {} };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { ratio: DEFAULT_RATIO, savedRatios: {} };
    }
    const parsed = JSON.parse(raw) as {
      ratio?: unknown;
      savedRatios?: unknown;
    };
    const ratio =
      typeof parsed.ratio === "number" && Number.isFinite(parsed.ratio)
        ? clampRatio(parsed.ratio)
        : DEFAULT_RATIO;
    const savedRatios: Record<string, number> = {};
    if (parsed.savedRatios && typeof parsed.savedRatios === "object") {
      for (const [key, value] of Object.entries(parsed.savedRatios as Record<string, unknown>)) {
        if (typeof value === "number" && Number.isFinite(value)) {
          savedRatios[key] = clampRatio(value);
        }
      }
    }
    return { ratio, savedRatios };
  } catch (error) {
    console.warn("[side-pane] failed to load persisted layout:", error);
    return { ratio: DEFAULT_RATIO, savedRatios: {} };
  }
}

function persistState(state: { ratio: number; savedRatios: Record<string, number> }) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ratio: clampRatio(state.ratio),
        savedRatios: Object.fromEntries(
          Object.entries(state.savedRatios).map(([key, value]) => [key, clampRatio(value)])
        )
      })
    );
  } catch (error) {
    console.warn("[side-pane] failed to persist layout:", error);
  }
}

function mapDescriptorToTab(descriptor: DockTabDescriptor): SidePaneTabState {
  return {
    id: descriptor.id,
    title: descriptor.title,
    icon: descriptor.icon,
    content: descriptor.content,
    closable: descriptor.closable ?? true,
    dirty: descriptor.dirty ?? false,
    minRatio: descriptor.minRatio ?? MIN_RATIO,
    maxRatio: descriptor.maxRatio ?? MAX_RATIO,
    onClose: descriptor.onClose
  };
}

function SidePaneInnerProvider({ children }: { children: ReactNode }) {
  const docking = useDocking();
  const persisted = useMemo(() => loadPersistedState(), []);
  const [ratio, setRatioState] = useState<number>(persisted.ratio);
  const savedRatiosRef = useRef<Record<string, number>>({ ...persisted.savedRatios });
  const [savedVersion, setSavedVersion] = useState(0);

  const { stack, descriptors } = useMemo(() => {
    const rootNode = docking.getNode(docking.rootStackId);
    const resolvedStack = rootNode && isStackNode(rootNode) ? rootNode : null;
    const resolvedDescriptors = resolvedStack ? docking.getStackTabs(resolvedStack.id) : [];

    return {
      stack: resolvedStack,
      descriptors: resolvedDescriptors
    };
  }, [docking]);
  const tabs = useMemo(() => descriptors.map(mapDescriptorToTab), [descriptors]);
  const tabsRef = useRef<SidePaneTabState[]>(tabs);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const activeTabId = stack?.activeTabId ?? null;
  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeTabId) ?? null, [tabs, activeTabId]);
  const sideVisible = tabs.length > 0;

  useEffect(() => {
    persistState({ ratio, savedRatios: savedRatiosRef.current });
  }, [ratio, savedVersion]);

  useEffect(() => {
    if (!activeTab) {
      setRatioState(DEFAULT_RATIO);
      return;
    }
    const saved = savedRatiosRef.current[activeTab.id];
    const nextRatio = clampRatio(saved ?? ratio, activeTab.minRatio, activeTab.maxRatio);
    setRatioState(nextRatio);
  }, [activeTab, ratio]);

  const rememberRatioForTab = useCallback((tabId: string, value: number) => {
    savedRatiosRef.current[tabId] = value;
    setSavedVersion((version) => version + 1);
  }, []);

  const openTab = useCallback(
    (tab: SidePaneTabConfig, options?: { activate?: boolean }) => {
      const descriptor: DockTabDescriptor = {
        id: tab.id,
        title: tab.title,
        icon: tab.icon,
        content: tab.content,
        closable: tab.closable,
        dirty: tab.dirty,
        minRatio: tab.minRatio,
        maxRatio: tab.maxRatio,
        onClose: tab.onClose
      };
      docking.openTab(descriptor, {
        stackId: docking.rootStackId,
        activate: options?.activate ?? true
      });
      if (!(tab.id in savedRatiosRef.current)) {
        const clamped = clampRatio(ratio, tab.minRatio ?? MIN_RATIO, tab.maxRatio ?? MAX_RATIO);
        rememberRatioForTab(tab.id, clamped);
      }
    },
    [docking, ratio, rememberRatioForTab]
  );

  const updateTab = useCallback(
    (id: string, patch: Partial<SidePaneTabConfig>) => {
      const descriptorPatch: Partial<DockTabDescriptor> = {
        title: patch.title,
        icon: patch.icon,
        content: patch.content,
        closable: patch.closable,
        dirty: patch.dirty,
        minRatio: patch.minRatio,
        maxRatio: patch.maxRatio,
        onClose: patch.onClose
      };
      docking.updateTab(id, descriptorPatch);
      if (patch.minRatio !== undefined || patch.maxRatio !== undefined) {
        const saved = savedRatiosRef.current[id];
        if (saved !== undefined) {
          const tabState = tabs.find((tab) => tab.id === id);
          if (tabState) {
            rememberRatioForTab(id, clampRatio(saved, tabState.minRatio, tabState.maxRatio));
          }
        }
      }
    },
    [docking, rememberRatioForTab, tabs]
  );

  const closeTab = useCallback(
    (id: string) => {
      const tabState = tabs.find((tab) => tab.id === id);
      if (tabState?.closable === false) {
        return;
      }
      docking.closeTab(id);
      if (id in savedRatiosRef.current) {
        delete savedRatiosRef.current[id];
        setSavedVersion((version) => version + 1);
      }
    },
    [docking, tabs]
  );

  const focusTab = useCallback(
    (id: string) => {
      docking.focusTab(id);
    },
    [docking]
  );

  const moveTab = useCallback(
    (id: string, targetIndex: number) => {
      docking.moveTab(docking.rootStackId, id, targetIndex);
    },
    [docking]
  );

  const clearTabs = useCallback(() => {
    const currentTabs = tabsRef.current;
    let removedAnyTabs = false;

    currentTabs.forEach((tab) => {
      if (tab.closable !== false) {
        docking.closeTab(tab.id);
        removedAnyTabs = true;
      }
    });

    const hadSavedRatios = Object.keys(savedRatiosRef.current).length > 0;
    if (!removedAnyTabs && !hadSavedRatios) {
      return;
    }

    savedRatiosRef.current = {};
    setSavedVersion((version) => version + 1);
  }, [docking]);

  const setRatio = useCallback(
    (value: number) => {
      const target = activeTab ?? null;
      const clamped = clampRatio(value, target?.minRatio ?? MIN_RATIO, target?.maxRatio ?? MAX_RATIO);
      if (target) {
        rememberRatioForTab(target.id, clamped);
      }
      setRatioState(clamped);
    },
    [activeTab, rememberRatioForTab]
  );

  const value = useMemo<SidePaneContextValue>(
    () => ({
      tabs,
      activeTab,
      activeTabId,
      sideVisible,
      ratio,
      setRatio,
      openTab,
      closeTab,
      focusTab,
      moveTab,
      updateTab,
      clearTabs
    }),
    [activeTab, activeTabId, closeTab, focusTab, moveTab, openTab, ratio, setRatio, sideVisible, tabs, updateTab, clearTabs]
  );

  return <SidePaneContext.Provider value={value}>{children}</SidePaneContext.Provider>;
}

export function SidePaneProvider({ children }: { children: ReactNode }) {
  return (
    <DockingProvider>
      <SidePaneInnerProvider>{children}</SidePaneInnerProvider>
    </DockingProvider>
  );
}

export function useSidePane(): SidePaneContextValue {
  const context = useContext(SidePaneContext);
  if (!context) {
    throw new Error("useSidePane must be used within a SidePaneProvider");
  }
  return context;
}

export type { SidePaneTabState as SidePaneTab };
