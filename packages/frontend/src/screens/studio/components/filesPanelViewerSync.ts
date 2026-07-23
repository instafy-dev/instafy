import type { ViewerState } from "./useFilesPanelViewerState";

const IDLE_VIEWER_STATE: ViewerState = {
  mode: "idle",
  entry: null,
  error: null,
};

export function resolveViewerStateWithoutActiveFile(current: ViewerState): ViewerState {
  if (current.mode !== "text") {
    return current;
  }
  return IDLE_VIEWER_STATE;
}
