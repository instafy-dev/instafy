import {
  createContext,
  useContext,
  useMemo,
  useReducer,
  useCallback,
  useRef,
  useEffect,
  useLayoutEffect,
  type ReactNode
} from "react";
import type { CodeWorkspace } from "../types";
import { createDefaultCodeWorkspace, cloneCodeWorkspace } from "./defaults";
import { keepSavedVersionIds } from "./savedVersionIds";
import { useWorkspaceStore } from "../store";

type UpdateWorkspaceFn = (current: CodeWorkspace) => CodeWorkspace;

export interface UpdateWorkspaceOptions {
  recordHistory?: boolean;
  /**
   * When the provider has unmounted (Studio closed while a save ran), apply
   * the update to the persisted store instead, so the buffers keep it.
   */
  keepAfterUnmount?: boolean;
}

interface CodeContextValue {
  workspace: CodeWorkspace;
  updateWorkspace: (updater: UpdateWorkspaceFn, options?: UpdateWorkspaceOptions) => void;
  replaceWorkspace: (snapshot: CodeWorkspace, options?: { resetHistory?: boolean; setInitial?: boolean }) => void;
  setActiveFile: (fileId: string | null) => void;
  updateFileContent: (fileId: string, value: string) => void;
  resetFile: (fileId: string) => void;
  undo: () => void;
  redo: () => void;
  reset: () => void;
  historyLength: number;
  futureLength: number;
}

interface CodeProviderProps {
  children: ReactNode;
  initialWorkspace?: CodeWorkspace;
}

interface CodeHistoryState {
  present: CodeWorkspace;
  past: CodeWorkspace[];
  future: CodeWorkspace[];
  initial: CodeWorkspace;
}

type CodeAction =
  | { type: "APPLY"; updater: UpdateWorkspaceFn; recordHistory: boolean }
  | { type: "SET"; next: CodeWorkspace; resetHistory: boolean; setInitial: boolean }
  | { type: "SET_ACTIVE_FILE"; fileId: string | null }
  | { type: "UNDO" }
  | { type: "REDO" }
  | { type: "RESET" };

function areWorkspacesEqual(a: CodeWorkspace, b: CodeWorkspace): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function reducer(state: CodeHistoryState, action: CodeAction): CodeHistoryState {
  switch (action.type) {
    case "APPLY": {
      const current = cloneCodeWorkspace(state.present);
      const updated = action.updater(current);
      const next = cloneCodeWorkspace(updated);
      if (areWorkspacesEqual(next, state.present)) {
        return state;
      }
      if (!action.recordHistory) {
        return { ...state, present: next };
      }
      return {
        ...state,
        past: [...state.past, cloneCodeWorkspace(state.present)],
        present: next,
        future: []
      };
    }
    case "SET": {
      const next = cloneCodeWorkspace(action.next);
      return {
        present: next,
        past: action.resetHistory ? [] : state.past,
        future: action.resetHistory ? [] : state.future,
        initial: action.setInitial ? cloneCodeWorkspace(next) : state.initial
      };
    }
    case "UNDO": {
      if (state.past.length === 0) {
        return state;
      }
      const previous = state.past[state.past.length - 1];
      return {
        ...state,
        past: state.past.slice(0, state.past.length - 1),
        present: keepSavedVersionIds(previous, state.present),
        future: [cloneCodeWorkspace(state.present), ...state.future]
      };
    }
    case "REDO": {
      if (state.future.length === 0) {
        return state;
      }
      const [next, ...rest] = state.future;
      return {
        ...state,
        past: [...state.past, cloneCodeWorkspace(state.present)],
        present: keepSavedVersionIds(next, state.present),
        future: rest
      };
    }
    case "RESET":
      return {
        ...state,
        past: [],
        future: [],
        present: cloneCodeWorkspace(state.initial)
      };
    case "SET_ACTIVE_FILE": {
      if (state.present.activeFileId === action.fileId) {
        return state;
      }
      const next = cloneCodeWorkspace(state.present);
      next.activeFileId = action.fileId;
      return {
        ...state,
        present: next
      };
    }
    default:
      return state;
  }
}

const CodeContext = createContext<CodeContextValue | null>(null);
// `updateWorkspace` never changes, so a reader of this context alone does not
// render again on every edit.
const CodeUpdaterContext = createContext<CodeContextValue["updateWorkspace"] | null>(null);

export function CodeProvider({ children, initialWorkspace }: CodeProviderProps) {
  const storeCode = useWorkspaceStore((store) => store.state.code);
  const storeUpdateCode = useWorkspaceStore((store) => store.updateCode);

  const resolvedInitial = initialWorkspace ?? storeCode ?? createDefaultCodeWorkspace();
  const initial = useMemo(() => cloneCodeWorkspace(resolvedInitial), [resolvedInitial]);

  const [state, dispatch] = useReducer(reducer, {
    present: initial,
    past: [],
    future: [],
    initial
  });

  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const syncingFromStoreRef = useRef(false);
  const ignoreStoreBroadcastRef = useRef(false);
  /** The store's code this provider was first rendered from, if it was. */
  const renderedFromStoreRef = useRef(initialWorkspace ? null : storeCode ?? null);

  useEffect(() => {
    const takeStoreCode = (nextCode: CodeWorkspace | null | undefined) => {
      if (!nextCode) {
        return;
      }
      if (ignoreStoreBroadcastRef.current) {
        ignoreStoreBroadcastRef.current = false;
        return;
      }
      const current = stateRef.current.present;
      if (areWorkspacesEqual(nextCode, current)) {
        return;
      }
      syncingFromStoreRef.current = true;
      dispatch({
        type: "SET",
        next: nextCode,
        resetHistory: false,
        setInitial: false
      });
    };
    const unsubscribe = useWorkspaceStore.subscribe((store) => store.state.code, takeStoreCode);
    // A change the store took after this provider's first render and before
    // this subscription (a save that finished while Studio opened) was sent
    // to nobody. Take it now, so the first write below does not undo it.
    const storeCodeNow = useWorkspaceStore.getState().state.code;
    if (renderedFromStoreRef.current && storeCodeNow !== renderedFromStoreRef.current) {
      takeStoreCode(storeCodeNow);
    }
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (syncingFromStoreRef.current) {
      syncingFromStoreRef.current = false;
      return;
    }
    // Skip only the store's echo of this push, which it sends while
    // `updateCode` runs. A push that changes nothing there (the first one
    // after mount repeats what the store holds) sends no echo, and the next
    // change made elsewhere (a space switch, a save that finished while
    // Studio was closed) must still reach this provider.
    ignoreStoreBroadcastRef.current = true;
    try {
      storeUpdateCode(() => cloneCodeWorkspace(state.present));
    } finally {
      ignoreStoreBroadcastRef.current = false;
    }
  }, [state.present, storeUpdateCode]);

  // Cleared in the commit that removes the provider (leaving Studio), not
  // after it: an update arriving between the two would otherwise be
  // dispatched to a reducer that is already gone.
  const mountedRef = useRef(true);
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const updateWorkspace = useCallback(
    (updater: UpdateWorkspaceFn, options?: UpdateWorkspaceOptions) => {
      if (!mountedRef.current && options?.keepAfterUnmount) {
        // No reducer to apply it to, and the next provider starts from the
        // store: the update goes there.
        useWorkspaceStore.getState().updateCode((code) => (code ? updater(cloneCodeWorkspace(code)) : code));
        return;
      }
      dispatch({
        type: "APPLY",
        updater,
        recordHistory: options?.recordHistory ?? true
      });
    },
    []
  );

  const replaceWorkspace = useCallback(
    (snapshot: CodeWorkspace, options?: { resetHistory?: boolean; setInitial?: boolean }) => {
      dispatch({
        type: "SET",
        next: snapshot,
        resetHistory: options?.resetHistory ?? true,
        setInitial: options?.setInitial ?? false
      });
    },
    []
  );

  const undo = useCallback(() => {
    dispatch({ type: "UNDO" });
  }, []);

  const setActiveFile = useCallback((fileId: string | null) => {
    dispatch({ type: "SET_ACTIVE_FILE", fileId });
  }, []);

  const updateFileContent = useCallback(
    (fileId: string, value: string) => {
      updateWorkspace((current) => {
        const files = current.files.map((file) =>
          file.id === fileId
            ? {
                ...file,
                modified: value
              }
            : file
        );
        return { ...current, files };
      });
    },
    [updateWorkspace]
  );

  const resetFile = useCallback(
    (fileId: string) => {
      updateWorkspace((current) => {
        const files = current.files.map((file) =>
          file.id === fileId
            ? {
                ...file,
                modified: file.generated
              }
            : file
        );
        return { ...current, files, error: null };
      });
    },
    [updateWorkspace]
  );

  const redo = useCallback(() => {
    dispatch({ type: "REDO" });
  }, []);

  const reset = useCallback(() => {
    dispatch({ type: "RESET" });
  }, []);

  const value = useMemo<CodeContextValue>(
    () => ({
      workspace: state.present,
      updateWorkspace,
      replaceWorkspace,
      setActiveFile,
      updateFileContent,
      resetFile,
      undo,
      redo,
      reset,
      historyLength: state.past.length,
      futureLength: state.future.length
    }),
    [
      state.present,
      state.past.length,
      state.future.length,
      updateWorkspace,
      replaceWorkspace,
      setActiveFile,
      updateFileContent,
      resetFile,
      undo,
      redo,
      reset
    ]
  );

  return (
    <CodeContext.Provider value={value}>
      <CodeUpdaterContext.Provider value={updateWorkspace}>{children}</CodeUpdaterContext.Provider>
    </CodeContext.Provider>
  );
}

export function useCode(): CodeContextValue {
  const context = useContext(CodeContext);
  if (!context) {
    throw new Error("useCode must be used within a CodeProvider");
  }
  return context;
}

/**
 * Only `updateWorkspace`, for a component that writes buffers without showing
 * them (the chat's Reload latest): it does not render again on every edit.
 */
export function useCodeUpdater(): CodeContextValue["updateWorkspace"] {
  const updateWorkspace = useContext(CodeUpdaterContext);
  if (!updateWorkspace) {
    throw new Error("useCodeUpdater must be used within a CodeProvider");
  }
  return updateWorkspace;
}
