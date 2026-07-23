import type { RuntimeState } from "../types";

export const DEFAULT_RUNTIME_STATE: RuntimeState = {
  buildLogs: [],
  activeConversationId: null,
  controllerReady: false,
  controllerProjectMissing: false,
  controllerUnavailable: false,
  controllerStreamDisconnected: false,
  controllerStreamDisconnectMessage: null,
};

export function createDefaultRuntimeState(): RuntimeState {
  return cloneRuntimeState(DEFAULT_RUNTIME_STATE);
}

export function cloneRuntimeState(state: RuntimeState): RuntimeState {
  return JSON.parse(JSON.stringify(state)) as RuntimeState;
}
