import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useRef,
  type Dispatch,
  type ReactNode,
} from "react";
import type { RunRecord, RuntimeState } from "../types";
import {
  createInitialRuntimeStoreState,
  runtimeReducer,
  type RuntimeAction,
  type RuntimeStoreState,
} from "./runtimeStore";

interface RuntimeStateActions {
  setRuntime: (runtime: RuntimeState) => void;
  updateRuntime: (updater: (current: RuntimeState) => RuntimeState) => void;
  upsertRun: (run: RunRecord) => void;
  removeRun: (runId: string) => void;
  markRunLeased: (runId: string) => void;
  clearRunLease: (runId: string) => void;
  ackConversationMessages: (messageIds: string[] | undefined) => void;
  ackConversationCreations: (conversationIds: string[] | undefined) => void;
  ackConversationUpdates: (conversationIds: string[] | undefined) => void;
}

export type RuntimeStatePublicValue = RuntimeStoreState & RuntimeStateActions;

interface RuntimeStateContextValue {
  state: RuntimeStoreState;
  dispatch: Dispatch<RuntimeAction>;
  publicValue: RuntimeStatePublicValue;
  actions: RuntimeStateActions;
}

const RuntimeStateContext = createContext<RuntimeStateContextValue | null>(null);

export function RuntimeStateProvider({
  children,
}: {
  children: ReactNode;
}) {
  const initialStateRef = useRef<RuntimeStoreState | null>(null);
  if (!initialStateRef.current) {
    initialStateRef.current = createInitialRuntimeStoreState();
  }

  const [state, dispatch] = useReducer(
    runtimeReducer,
    initialStateRef.current as RuntimeStoreState,
  );

  const setRuntime = useCallback((runtime: RuntimeState) => {
    dispatch({ type: "setRuntime", runtime });
  }, []);

  const updateRuntime = useCallback(
    (updater: (current: RuntimeState) => RuntimeState) => {
      dispatch({ type: "updateRuntime", updater });
    },
    [],
  );

  const upsertRun = useCallback((run: RunRecord) => {
    dispatch({ type: "upsertRun", run });
  }, []);

  const removeRun = useCallback((runId: string) => {
    dispatch({ type: "removeRun", runId });
  }, []);

  const markRunLeased = useCallback((runId: string) => {
    dispatch({ type: "markRunLeased", runId });
  }, []);

  const clearRunLease = useCallback((runId: string) => {
    dispatch({ type: "clearRunLease", runId });
  }, []);

  const ackConversationMessages = useCallback(
    (messageIds: string[] | undefined) => {
      dispatch({
        type: "clearConversationMessages",
        messageIds: messageIds ?? [],
      });
    },
    [],
  );

  const ackConversationCreations = useCallback(
    (conversationIds: string[] | undefined) => {
      dispatch({
        type: "clearConversationCreations",
        conversationIds: conversationIds ?? [],
      });
    },
    [],
  );

  const ackConversationUpdates = useCallback(
    (conversationIds: string[] | undefined) => {
      dispatch({
        type: "clearConversationUpdates",
        conversationIds: conversationIds ?? [],
      });
    },
    [],
  );

  const actions = useMemo<RuntimeStateActions>(
    () => ({
      setRuntime,
      updateRuntime,
      upsertRun,
      removeRun,
      markRunLeased,
      clearRunLease,
      ackConversationMessages,
      ackConversationCreations,
      ackConversationUpdates,
    }),
    [
      ackConversationCreations,
      ackConversationMessages,
      ackConversationUpdates,
      clearRunLease,
      markRunLeased,
      removeRun,
      setRuntime,
      updateRuntime,
      upsertRun,
    ],
  );

  const publicValue = useMemo<RuntimeStatePublicValue>(
    () => ({
      ...state,
      ...actions,
    }),
    [actions, state],
  );

  const contextValue = useMemo(
    () => ({
      state,
      dispatch,
      publicValue,
      actions,
    }),
    [actions, dispatch, publicValue, state],
  );

  return (
    <RuntimeStateContext.Provider value={contextValue}>
      {children}
    </RuntimeStateContext.Provider>
  );
}

export function useRuntimeState(): RuntimeStatePublicValue {
  const context = useContext(RuntimeStateContext);
  if (!context) {
    throw new Error("useRuntimeState must be used within a RuntimeStateProvider");
  }
  return context.publicValue;
}

export function useRuntimeStateInternal(): RuntimeStateContextValue {
  const context = useContext(RuntimeStateContext);
  if (!context) {
    throw new Error(
      "useRuntimeStateInternal must be used within a RuntimeStateProvider",
    );
  }
  return context;
}
