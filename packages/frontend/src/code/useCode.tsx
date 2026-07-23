import {
  createContext,
  useContext,
  useMemo,
  useReducer,
  useCallback,
  useRef,
  useEffect,
  type ReactNode
} from "react";
import type { CodeWorkspace } from "../types";
import { createDefaultCodeWorkspace, cloneCodeWorkspace } from "./defaults";
import { useWorkspaceStore } from "../store";

type UpdateWorkspaceFn = (current: CodeWorkspace) => CodeWorkspace;

interface CodeContextValue {
  workspace: CodeWorkspace;
  updateWorkspace: (updater: UpdateWorkspaceFn, options?: { recordHistory?: boolean }) => void;
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
        present: previous,
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
        present: next,
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

  useEffect(() => {
    const unsubscribe = useWorkspaceStore.subscribe(
      (store) => store.state.code,
      (nextCode) => {
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
      }
    );
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (syncingFromStoreRef.current) {
      syncingFromStoreRef.current = false;
      return;
    }
    ignoreStoreBroadcastRef.current = true;
    storeUpdateCode(() => cloneCodeWorkspace(state.present));
  }, [state.present, storeUpdateCode]);

  const updateWorkspace = useCallback(
    (updater: UpdateWorkspaceFn, options?: { recordHistory?: boolean }) => {
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

  return <CodeContext.Provider value={value}>{children}</CodeContext.Provider>;
}

export function useCode(): CodeContextValue {
  const context = useContext(CodeContext);
  if (!context) {
    throw new Error("useCode must be used within a CodeProvider");
  }
  return context;
}
