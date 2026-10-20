import { describe, expect, it } from "vitest";
import type { ControllerRuntimeStatusEntry } from "../../services/runtimeController";
import { createInitialRuntimeStoreState, runtimeReducer } from "../runtimeStore";

describe("runtime store browser-host policy", () => {
  const statuses = [{ runtimeId: "runtime-1", status: "running" } as ControllerRuntimeStatusEntry];

  it("keeps the policy of the last status answer, and forgets it when an answer has none", () => {
    expect(createInitialRuntimeStoreState().sharedBrowserHostPolicy).toBeNull();
    let state = runtimeReducer(createInitialRuntimeStoreState(), {
      type: "setRuntimeStatuses",
      statuses,
      preferredRuntimeId: null,
      sharedBrowserHostPolicy: "covered",
    });
    expect(state.sharedBrowserHostPolicy).toBe("covered");
    // An older controller, a failed refresh or a signed-out reset carries no policy.
    state = runtimeReducer(state, { type: "setRuntimeStatuses", statuses: [], preferredRuntimeId: null });
    expect(state.sharedBrowserHostPolicy).toBeNull();
  });
});
