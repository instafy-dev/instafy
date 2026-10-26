import {
  createProviderExecutionContext,
} from "@instafy/provider-contract";
import { KNOSH_PROVIDER_ID } from "../../provider/family.mjs";
import type { ProjectProviderSelectedDevice } from "@instafy/frontend/feature-api";
import {
  matchesExtensionProviderFamily,
} from "@instafy/frontend/feature-api";
import type {
  NativeCapabilityRuntimeEvent,
  NativeCapabilityRuntimeRegistration,
} from "@instafy/frontend/feature-api";
import {
  getKnoshRuntimeAdapter,
  resolveKnoshRuntimeExecutionSurface,
  type KnoshRuntimeAdapter,
  type KnoshRuntimeStatus,
} from "./knoshRuntimeAdapter";

function normalizeString(value: string | null | undefined) {
  return typeof value === "string" ? value.trim() : "";
}

function statusSupportsNativeKnoshRuntime(status: {
  supported?: boolean;
  platform?: string | null;
  bleSupported?: boolean;
}) {
  return (
    status.supported === true &&
    (status.platform === "android" || status.platform === "ios") &&
    status.bleSupported === true
  );
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function inferRobotCommandAction(commandJson: unknown) {
  if (commandJson && typeof commandJson === "object" && !Array.isArray(commandJson)) {
    const name = (commandJson as Record<string, unknown>).name;
    return typeof name === "string" && name.trim().length > 0 ? name.trim() : "command";
  }
  const parsed = parseJsonRecord(commandJson);
  const name = parsed?.name;
  return typeof name === "string" && name.trim().length > 0 ? name.trim() : "command";
}

async function ensureNativeKnoshReady(address: string, runtime: KnoshRuntimeAdapter) {
  const normalizedAddress = address.trim();
  if (!normalizedAddress) {
    throw new Error("Missing saved Knosh device address.");
  }

  const status = await runtime.getStatus();
  if (!statusSupportsNativeKnoshRuntime(status)) {
    throw new Error("Knosh native BLE runtime is not available on this device.");
  }

  const currentAddress = status.connection.deviceAddress?.trim().toLowerCase() ?? "";
  if (status.connection.ready && currentAddress === normalizedAddress.toLowerCase()) {
    return status;
  }

  const connectedStatus = await runtime.connectDevice(normalizedAddress);
  if (!connectedStatus.connection.ready) {
    throw new Error(
      connectedStatus.error?.trim().length
        ? connectedStatus.error
        : `Unable to connect to saved Knosh device ${normalizedAddress}.`,
    );
  }

  return connectedStatus;
}

function buildNativeKnoshExecutionContext(
  providerId: string,
  transportTarget: string,
  runtime: Pick<KnoshRuntimeAdapter, "backendId" | "transportKind">,
  connectionStatus: Pick<KnoshRuntimeStatus, "platform" | "connection">,
) {
  const executionSurface = resolveKnoshRuntimeExecutionSurface(connectionStatus.platform);
  const currentTarget =
    normalizeString(connectionStatus.connection.deviceAddress) || transportTarget;

  return createProviderExecutionContext({
    providerId,
    providerType: KNOSH_PROVIDER_ID,
    runtime: {
      backendId: runtime.backendId,
      transportKind: runtime.transportKind,
      transportTarget: currentTarget,
      executionSurface,
    },
  });
}

export const KNOSH_NATIVE_CAPABILITY_RUNTIME: NativeCapabilityRuntimeRegistration = {
  familyId: KNOSH_PROVIDER_ID,
  matchesProvider({ providerId, provider }) {
    return (
      matchesExtensionProviderFamily(providerId ?? provider?.id, KNOSH_PROVIDER_ID) ||
      normalizeString(provider?.providerType).toLowerCase() === KNOSH_PROVIDER_ID
    );
  },
  async resolveSelection({ selectedDevice }) {
    const runtime = getKnoshRuntimeAdapter();
    if (!runtime) {
      return null;
    }

    const nativeStatus = await runtime.getStatus().catch(() => null);
    if (!nativeStatus || !statusSupportsNativeKnoshRuntime(nativeStatus)) {
      return null;
    }

    const savedTarget =
      normalizeString(selectedDevice?.address) || normalizeString(selectedDevice?.identifier);
    if (savedTarget) {
      return {
        transportTarget: savedTarget,
        selectedDevice,
      };
    }

    const activeTarget = normalizeString(nativeStatus.connection.deviceAddress);
    if (nativeStatus.connection.ready && activeTarget) {
      return {
        transportTarget: activeTarget,
        selectedDevice:
          selectedDevice ??
          ({
            transport: "ble",
            identifier: activeTarget,
            address: activeTarget,
            name: null,
            nativePlatform:
              nativeStatus.platform === "android" || nativeStatus.platform === "ios"
                ? nativeStatus.platform
                : null,
          } satisfies ProjectProviderSelectedDevice),
      };
    }

    return null;
  },
  async postProbe(body, selection) {
    const runtime = getKnoshRuntimeAdapter();
    if (!runtime) {
      throw new Error("Knosh native BLE runtime is not available on this device.");
    }

    const connectionStatus = await ensureNativeKnoshReady(selection.transportTarget, runtime);
    const events: NativeCapabilityRuntimeEvent[] = [];
    const executionContext = buildNativeKnoshExecutionContext(
      selection.providerId,
      selection.transportTarget,
      runtime,
      connectionStatus,
    );

    if (body.readStatus === true) {
      const statusResult = await runtime.readStatus();
      if (statusResult.error && !statusResult.valueText) {
        throw new Error(statusResult.error);
      }
      const parsedStatus = parseJsonRecord(statusResult.valueText);
      if (parsedStatus) {
        events.push({
          event: "status",
          value: parsedStatus,
          executionContext,
        });
      }
    }

    if (body.skipCommand !== true && body.commandJson) {
      const commandResult = await runtime.sendCommand(
        body.commandJson as Record<string, unknown> | string,
        {
          action: inferRobotCommandAction(body.commandJson),
          sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
          source: typeof body.source === "string" ? body.source : "instafy_mobile_provider",
        },
      );
      if (!commandResult.writeCompleted) {
        throw new Error(
          commandResult.error?.trim().length
            ? commandResult.error
            : "Native Knosh BLE command write did not complete.",
        );
      }
      const parsedTelemetry = parseJsonRecord(commandResult.telemetryText);
      if (parsedTelemetry) {
        events.push({
          ...parsedTelemetry,
          executionContext,
        });
      }
    }

    return {
      connected: connectionStatus.connection.ready,
      events,
      executionContext,
    };
  },
};
