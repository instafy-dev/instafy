import { describe, expect, it } from "vitest";

import {
  advanceShakeDetector,
  INITIAL_SHAKE_DETECTOR_STATE,
  type ShakeDetectorState,
} from "../useShakeToReport";

describe("advanceShakeDetector", () => {
  it("triggers only after two strong peaks within the shake window", () => {
    let state = INITIAL_SHAKE_DETECTOR_STATE;

    let result = advanceShakeDetector(state, { magnitude: 9.8, timestamp: 1_000 });
    state = result.nextState;
    expect(result.triggered).toBe(false);

    result = advanceShakeDetector(state, { magnitude: 28, timestamp: 1_100 });
    state = result.nextState;
    expect(result.triggered).toBe(false);

    result = advanceShakeDetector(state, { magnitude: 8, timestamp: 1_260 });
    expect(result.triggered).toBe(true);
  });

  it("does not retrigger during the cooldown window", () => {
    let state: ShakeDetectorState = {
      ...INITIAL_SHAKE_DETECTOR_STATE,
      lastMagnitude: 8,
      lastTriggeredAt: 1_000,
    };

    let result = advanceShakeDetector(state, { magnitude: 28, timestamp: 1_100 });
    state = result.nextState;
    expect(result.triggered).toBe(false);

    result = advanceShakeDetector(state, { magnitude: 8, timestamp: 1_260 });
    expect(result.triggered).toBe(false);
  });
});
