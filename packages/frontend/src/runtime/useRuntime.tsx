import { useRuntimeState } from "./RuntimeStateProvider";
import { useRuntimeOperations } from "./RuntimeOperationsProvider";

/**
 * Temporary runtime hook that exposes the runtime context.
 * Future iterations will restore controller orchestration on top of the provider.
 */
export function useRuntime() {
  const state = useRuntimeState();
  const operations = useRuntimeOperations();
  return {
    ...state,
    ...operations,
  };
}
