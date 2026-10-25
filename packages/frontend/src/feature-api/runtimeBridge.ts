// Narrow hook surface for trusted background bridges. Keep this entrypoint
// independent from the broad Studio UI facade so feature-module evaluation
// does not eagerly initialize the complete provider graph.
import { useProjectState } from "../projects/ProjectStateProvider";

export function useActiveProjectId() {
  return useProjectState().activeProjectId;
}

export {
  integrationIsAttached,
  providerRequestTargetsCurrentDevice,
} from "../extensions/providerRequestClaimSupport";

// A bridge with nothing to claim waits on the shared polling gate: slow while
// the user is idle and paused while the tab is hidden.
export { startGatedInterval } from "../runtime/pollingGate";
