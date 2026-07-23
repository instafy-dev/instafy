import { controllerJsonRequest } from "./client";

export type ControllerProviderDevicePresenceStatus = "online" | "offline";

export interface ControllerProviderDeviceRecord {
  projectId: string;
  providerId: string;
  providerFamilyId: string;
  deviceId: string;
  deviceLabel: string | null;
  platform: "android" | "ios" | null;
  status: string;
  connectionType: string;
  metadata: Record<string, unknown>;
  presenceStatus: ControllerProviderDevicePresenceStatus;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

interface ListProviderDevicesParams {
  projectId: string;
  providerId?: string | null;
  providerFamilyId?: string | null;
  limit?: number;
}

interface HeartbeatProviderDeviceParams {
  projectId: string;
  providerId: string;
  providerFamilyId?: string | null;
  deviceId: string;
  deviceLabel?: string | null;
  platform?: "android" | "ios" | null;
  status?: string | null;
  connectionType?: string | null;
  metadata?: Record<string, unknown> | null;
}

function normalizeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeProviderDeviceRecord(value: unknown): ControllerProviderDeviceRecord | null {
  const record = normalizeRecord(value);
  if (!record) {
    return null;
  }

  const projectId = typeof record.projectId === "string" ? record.projectId.trim() : "";
  const providerId = typeof record.providerId === "string" ? record.providerId.trim() : "";
  const providerFamilyId =
    typeof record.providerFamilyId === "string" ? record.providerFamilyId.trim() : "";
  const deviceId = typeof record.deviceId === "string" ? record.deviceId.trim() : "";
  const status = typeof record.status === "string" ? record.status.trim() : "";
  const connectionType =
    typeof record.connectionType === "string" ? record.connectionType.trim() : "";
  const createdAt = typeof record.createdAt === "string" ? record.createdAt.trim() : "";
  const updatedAt = typeof record.updatedAt === "string" ? record.updatedAt.trim() : "";
  const lastSeenAt = typeof record.lastSeenAt === "string" ? record.lastSeenAt.trim() : "";
  const presenceStatus =
    record.presenceStatus === "online" || record.presenceStatus === "offline"
      ? record.presenceStatus
      : null;

  if (
    !projectId ||
    !providerId ||
    !providerFamilyId ||
    !deviceId ||
    !status ||
    !connectionType ||
    !createdAt ||
    !updatedAt ||
    !lastSeenAt ||
    !presenceStatus
  ) {
    return null;
  }

  return {
    projectId,
    providerId,
    providerFamilyId,
    deviceId,
    deviceLabel: typeof record.deviceLabel === "string" ? record.deviceLabel : null,
    platform: record.platform === "android" || record.platform === "ios" ? record.platform : null,
    status,
    connectionType,
    metadata: normalizeRecord(record.metadata) ?? {},
    presenceStatus,
    createdAt,
    updatedAt,
    lastSeenAt,
  };
}

export async function listControllerProviderDevices(
  params: ListProviderDevicesParams,
): Promise<ControllerProviderDeviceRecord[]> {
  const response = await controllerJsonRequest<unknown>({
    path: `/projects/${encodeURIComponent(params.projectId)}/provider-devices`,
    searchParams: {
      providerId: params.providerId ?? undefined,
      providerFamilyId: params.providerFamilyId ?? undefined,
      limit: params.limit ?? undefined,
    },
    fallbackError: "Unable to list provider devices",
  });

  if (!response.success || !Array.isArray(response.value)) {
    return [];
  }

  return response.value
    .map((entry) => normalizeProviderDeviceRecord(entry))
    .filter((entry): entry is ControllerProviderDeviceRecord => Boolean(entry));
}

export async function heartbeatControllerProviderDevice(
  params: HeartbeatProviderDeviceParams,
): Promise<ControllerProviderDeviceRecord | null> {
  const response = await controllerJsonRequest<unknown>({
    path: `/projects/${encodeURIComponent(params.projectId)}/provider-devices/heartbeat`,
    method: "POST",
    body: {
      providerId: params.providerId,
      providerFamilyId: params.providerFamilyId ?? undefined,
      deviceId: params.deviceId,
      deviceLabel: params.deviceLabel ?? undefined,
      platform: params.platform ?? undefined,
      status: params.status ?? undefined,
      connectionType: params.connectionType ?? undefined,
      metadata: params.metadata ?? {},
    },
    fallbackError: "Unable to heartbeat provider device",
  });

  return response.success ? normalizeProviderDeviceRecord(response.value) : null;
}
