import type {
  ControllerProjectIntegration,
  ControllerProviderRequestRecord,
} from "../services/runtimeController";
import { isRecord } from "../utils/isRecord";

const ATTACHED_PROJECT_INTEGRATION_STATUSES = new Set([
  "attached",
  "available",
  "connected",
  "enabled",
]);

export function integrationIsAttached(
  integration: ControllerProjectIntegration | null | undefined,
) {
  if (!integration) {
    return false;
  }
  const status = integration.status.trim().toLowerCase();
  const metadata = isRecord(integration.metadata) ? integration.metadata : {};
  return (
    ATTACHED_PROJECT_INTEGRATION_STATUSES.has(status) &&
    metadata.attached !== false &&
    metadata.enabled !== false
  );
}

export function providerRequestTargetsCurrentDevice(
  request: ControllerProviderRequestRecord,
  providerId: string,
  deviceId: string,
) {
  if (request.providerId.trim().toLowerCase() !== providerId.trim().toLowerCase()) {
    return false;
  }
  if (request.status === "claimed") {
    return request.claimedByDeviceId?.trim().toLowerCase() === deviceId.trim().toLowerCase();
  }
  return request.status === "pending";
}
