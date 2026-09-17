import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchRobotPowerStatus,
  fetchRobotRuntimeStatus,
  type RobotPowerStatusValue,
  type RobotRuntimeStatusValue,
} from "../../robot";
import type {
  KnoshRuntimeAdapter,
  KnoshRuntimeStatus,
} from "../../robot";
import { summarizeKnoshRuntimeHardware } from "../knoshRuntimeState";

export type KnoshRuntimeHardwareState = {
  deviceStatus: KnoshRuntimeStatus | null;
  providerRuntimeStatus: RobotRuntimeStatusValue | null;
  powerStatus: RobotPowerStatusValue | null;
  runtimeError: string | null;
  connected: boolean;
  hardwareSummary: string[];
  refreshHardware: () => Promise<void>;
};

export function useKnoshRuntimeHardwareState(
  runtimeAdapter: KnoshRuntimeAdapter | null,
): KnoshRuntimeHardwareState {
  const [deviceStatus, setDeviceStatus] = useState<KnoshRuntimeStatus | null>(null);
  const [providerRuntimeStatus, setProviderRuntimeStatus] =
    useState<RobotRuntimeStatusValue | null>(null);
  const [powerStatus, setPowerStatus] = useState<RobotPowerStatusValue | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

  const refreshHardware = useCallback(async () => {
    const [deviceResult, runtimeResult, powerResult] = await Promise.allSettled([
      runtimeAdapter?.getStatus?.() ?? Promise.resolve(null),
      fetchRobotRuntimeStatus().catch((error: unknown) => {
        throw error instanceof Error ? error : new Error(String(error));
      }),
      fetchRobotPowerStatus().catch((error: unknown) => {
        throw error instanceof Error ? error : new Error(String(error));
      }),
    ]);

    if (deviceResult.status === "fulfilled") {
      setDeviceStatus(deviceResult.value);
    }

    if (runtimeResult.status === "fulfilled") {
      setProviderRuntimeStatus(runtimeResult.value.value ?? null);
    }

    if (powerResult.status === "fulfilled") {
      setPowerStatus(powerResult.value.value ?? null);
    }

    const nextError =
      deviceResult.status === "rejected"
        ? deviceResult.reason instanceof Error
          ? deviceResult.reason.message
          : String(deviceResult.reason)
        : runtimeResult.status === "rejected"
          ? runtimeResult.reason instanceof Error
            ? runtimeResult.reason.message
            : String(runtimeResult.reason)
          : powerResult.status === "rejected"
            ? powerResult.reason instanceof Error
              ? powerResult.reason.message
              : String(powerResult.reason)
            : null;

    setRuntimeError(nextError);
  }, [runtimeAdapter]);

  useEffect(() => {
    void refreshHardware();
    const interval = globalThis.setInterval(() => {
      void refreshHardware();
    }, 8000);
    return () => {
      globalThis.clearInterval(interval);
    };
  }, [refreshHardware]);

  const connected =
    deviceStatus?.connection.ready === true || deviceStatus?.connection.connected === true;
  const hardwareSummary = useMemo(
    () =>
      summarizeKnoshRuntimeHardware({
        deviceStatus,
        providerRuntimeStatus,
        powerStatus,
      }),
    [deviceStatus, powerStatus, providerRuntimeStatus],
  );

  return {
    deviceStatus,
    providerRuntimeStatus,
    powerStatus,
    runtimeError,
    connected,
    hardwareSummary,
    refreshHardware,
  };
}
