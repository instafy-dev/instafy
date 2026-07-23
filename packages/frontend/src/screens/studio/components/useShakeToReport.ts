import { Capacitor } from "@capacitor/core";
import { useEffect, useRef } from "react";

export interface ShakeDetectorState {
  lastMagnitude: number | null;
  firstPeakAt: number | null;
  peakCount: number;
  lastTriggeredAt: number;
}

export interface ShakeSample {
  magnitude: number;
  timestamp: number;
}

export interface ShakeDetectorSnapshot extends ShakeDetectorState {
  lastSampleAt: number | null;
  lastSource: string | null;
}

export const NATIVE_SHAKE_REPORT_EVENT = "instafy:native-shake";

const SHAKE_DELTA_THRESHOLD = 14;
const SHAKE_WINDOW_MS = 600;
const SHAKE_REQUIRED_PEAKS = 2;
const SHAKE_COOLDOWN_MS = 8_000;

export const INITIAL_SHAKE_DETECTOR_STATE: ShakeDetectorState = {
  lastMagnitude: null,
  firstPeakAt: null,
  peakCount: 0,
  lastTriggeredAt: Number.NEGATIVE_INFINITY,
};

export function advanceShakeDetector(
  state: ShakeDetectorState,
  sample: ShakeSample,
): { nextState: ShakeDetectorState; triggered: boolean } {
  const nextBase: ShakeDetectorState = {
    ...state,
    lastMagnitude: sample.magnitude,
  };

  if (state.lastMagnitude == null) {
    return {
      nextState: nextBase,
      triggered: false,
    };
  }

  if (sample.timestamp - state.lastTriggeredAt < SHAKE_COOLDOWN_MS) {
    return {
      nextState: nextBase,
      triggered: false,
    };
  }

  const delta = Math.abs(sample.magnitude - state.lastMagnitude);
  if (delta < SHAKE_DELTA_THRESHOLD) {
    if (
      state.firstPeakAt != null &&
      sample.timestamp - state.firstPeakAt > SHAKE_WINDOW_MS
    ) {
      return {
        nextState: {
          ...nextBase,
          firstPeakAt: null,
          peakCount: 0,
        },
        triggered: false,
      };
    }
    return {
      nextState: nextBase,
      triggered: false,
    };
  }

  const windowExpired =
    state.firstPeakAt == null || sample.timestamp - state.firstPeakAt > SHAKE_WINDOW_MS;
  const peakCount = windowExpired ? 1 : state.peakCount + 1;
  const firstPeakAt = windowExpired ? sample.timestamp : state.firstPeakAt;

  if (peakCount >= SHAKE_REQUIRED_PEAKS) {
    return {
      nextState: {
        lastMagnitude: sample.magnitude,
        firstPeakAt: null,
        peakCount: 0,
        lastTriggeredAt: sample.timestamp,
      },
      triggered: true,
    };
  }

  return {
    nextState: {
      ...nextBase,
      firstPeakAt,
      peakCount,
    },
    triggered: false,
  };
}

export function useShakeToReport({
  enabled,
  onShake,
  onShakeDetected,
  onDetectorStateChange,
}: {
  enabled: boolean;
  onShake: () => Promise<void> | void;
  onShakeDetected?: (source: string | null) => void;
  onDetectorStateChange?: (snapshot: ShakeDetectorSnapshot) => void;
}) {
  const onShakeRef = useRef(onShake);
  const onShakeDetectedRef = useRef(onShakeDetected);
  const onDetectorStateChangeRef = useRef(onDetectorStateChange);
  const runningRef = useRef(false);
  const detectorRef = useRef<ShakeDetectorState>(INITIAL_SHAKE_DETECTOR_STATE);

  useEffect(() => {
    onShakeRef.current = onShake;
  }, [onShake]);

  useEffect(() => {
    onShakeDetectedRef.current = onShakeDetected;
  }, [onShakeDetected]);

  useEffect(() => {
    onDetectorStateChangeRef.current = onDetectorStateChange;
  }, [onDetectorStateChange]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof window.addEventListener !== "function") {
      detectorRef.current = INITIAL_SHAKE_DETECTOR_STATE;
      return;
    }

    const triggerShake = (source: string | null) => {
      if (runningRef.current) {
        return;
      }
      onShakeDetectedRef.current?.(source);
      runningRef.current = true;
      void Promise.resolve(onShakeRef.current()).finally(() => {
        runningRef.current = false;
      });
    };

    const cleanupCallbacks: Array<() => void> = [];

    if (Capacitor.isNativePlatform()) {
      const handleNativeShake = (event: Event) => {
        const detail =
          event instanceof CustomEvent && typeof event.detail === "object" && event.detail
            ? (event.detail as { source?: unknown })
            : null;
        const source = typeof detail?.source === "string" ? detail.source : "native";
        onDetectorStateChangeRef.current?.({
          ...detectorRef.current,
          lastSampleAt: Date.now(),
          lastSource: source,
        });
        triggerShake(source);
      };

      window.addEventListener(NATIVE_SHAKE_REPORT_EVENT, handleNativeShake);
      cleanupCallbacks.push(() => {
        window.removeEventListener(NATIVE_SHAKE_REPORT_EVENT, handleNativeShake);
      });
    }

    const handleMotion = (event: DeviceMotionEvent) => {
      const source = event.accelerationIncludingGravity ?? event.acceleration;
      if (!source) {
        return;
      }
      const x = typeof source.x === "number" ? source.x : 0;
      const y = typeof source.y === "number" ? source.y : 0;
      const z = typeof source.z === "number" ? source.z : 0;
      const magnitude = Math.sqrt(x * x + y * y + z * z);
      const { nextState, triggered } = advanceShakeDetector(detectorRef.current, {
        magnitude,
        timestamp: Date.now(),
      });
      detectorRef.current = nextState;
      onDetectorStateChangeRef.current?.({
        ...nextState,
        lastSampleAt: Date.now(),
        lastSource: "motion",
      });
      if (!triggered) {
        return;
      }
      triggerShake("motion");
    };

    window.addEventListener("devicemotion", handleMotion);
    cleanupCallbacks.push(() => {
      window.removeEventListener("devicemotion", handleMotion);
    });

    return () => {
      cleanupCallbacks.forEach((cleanup) => cleanup());
    };
  }, [enabled]);
}
