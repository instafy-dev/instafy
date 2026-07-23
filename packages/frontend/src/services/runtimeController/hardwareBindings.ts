import type {
  LocalHardwareBinding,
  LocalHardwareBindingStore,
  LocalHardwareCapability,
  LocalHardwareResourceGrant,
} from "@instafy/sdk/hardware-provider";
import { SERIAL_HARDWARE_PROVIDER_ID } from "@instafy/sdk/hardware-provider";
import { controllerClient } from "../../sdk/instafy";

export const HARDWARE_BINDINGS_PATH = ".instafy/hardware-bindings.json";

type WorkspaceAccessParams = {
  projectId: string;
  accessToken?: string | null;
  runtimeId?: string | null;
};

export type UpsertProjectHardwareBindingParams = WorkspaceAccessParams & {
  providerId: string;
  runtimeHostId?: string | null;
  runtimeHostLabel?: string | null;
  purpose?: string | null;
  grantedCapabilities: LocalHardwareCapability[];
  grantedResources?: LocalHardwareResourceGrant[];
};

export type RevokeProjectHardwareBindingParams = WorkspaceAccessParams & {
  providerId: string;
  bindingId?: string | null;
  runtimeHostId?: string | null;
};

function createEmptyStore(): LocalHardwareBindingStore {
  return {
    version: 1,
    bindings: {},
  };
}

async function readProjectHardwareBindingStoreOrEmpty(
  params: WorkspaceAccessParams,
): Promise<LocalHardwareBindingStore> {
  try {
    return await readProjectHardwareBindingStore(params);
  } catch {
    return createEmptyStore();
  }
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeCapability(value: unknown): LocalHardwareCapability | null {
  return value === "hardware_serial_list" || value === "hardware_serial_probe" ? value : null;
}

function normalizeCapabilities(values: unknown): LocalHardwareCapability[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const allowed = new Set<LocalHardwareCapability>();
  for (const value of values) {
    const normalized = normalizeCapability(value);
    if (normalized) {
      allowed.add(normalized);
    }
  }
  const result: LocalHardwareCapability[] = [];
  if (allowed.has("hardware_serial_list")) {
    result.push("hardware_serial_list");
  }
  if (allowed.has("hardware_serial_probe")) {
    result.push("hardware_serial_probe");
  }
  return result;
}

function normalizeSerialResource(value: unknown): LocalHardwareResourceGrant | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "serial_device") {
    return null;
  }
  const path = normalizeString(record.path);
  if (!path) {
    return null;
  }
  return {
    kind: "serial_device",
    id: normalizeString(record.id) ?? path,
    path,
    displayName: normalizeString(record.displayName),
  };
}

function normalizeResources(values: unknown): LocalHardwareResourceGrant[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const resources = new Map<string, LocalHardwareResourceGrant>();
  for (const value of values) {
    const normalized = normalizeSerialResource(value);
    if (normalized) {
      resources.set(normalized.id, normalized);
    }
  }
  return [...resources.values()];
}

function createHardwareBindingKey(providerId: string, runtimeHostId?: string | null): string {
  const normalizedProviderId = providerId.trim();
  const normalizedRuntimeHostId = normalizeString(runtimeHostId);
  return normalizedRuntimeHostId ? `${normalizedProviderId}@${normalizedRuntimeHostId}` : normalizedProviderId;
}

function normalizeBinding(bindingKey: string, value: unknown): LocalHardwareBinding | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const normalizedProviderId = normalizeString(record.providerId) ?? bindingKey.split("@")[0]?.trim();
  const projectId = normalizeString(record.projectId);
  if (!normalizedProviderId || !projectId) {
    return null;
  }
  const runtimeHostId = normalizeString(record.runtimeHostId);
  const grantedCapabilities = normalizeCapabilities(record.grantedCapabilities);
  const createdAt = normalizeString(record.createdAt) ?? new Date(0).toISOString();
  const updatedAt = normalizeString(record.updatedAt) ?? createdAt;

  return {
    bindingId: normalizeString(record.bindingId) ?? bindingKey.trim(),
    providerId: normalizedProviderId,
    projectId,
    runtimeHostId,
    runtimeHostLabel: normalizeString(record.runtimeHostLabel),
    grantedCapabilities,
    grantedResources: normalizeResources(record.grantedResources),
    purpose: normalizeString(record.purpose),
    status: "bound",
    createdAt,
    updatedAt,
  };
}

function normalizeBindingStore(value: unknown): LocalHardwareBindingStore {
  if (!value || typeof value !== "object") {
    throw new Error("Hardware bindings file must contain a JSON object.");
  }
  const record = value as Record<string, unknown>;
  const bindingsRecord =
    record.bindings && typeof record.bindings === "object" ? (record.bindings as Record<string, unknown>) : {};
  const bindings: Record<string, LocalHardwareBinding> = {};

  for (const [bindingKey, bindingValue] of Object.entries(bindingsRecord)) {
    const normalized = normalizeBinding(bindingKey, bindingValue);
    if (normalized) {
      bindings[normalized.bindingId ?? bindingKey] = normalized;
    }
  }

  return {
    version: 1,
    bindings,
  };
}

function sortBindings(bindings: Record<string, LocalHardwareBinding>): Record<string, LocalHardwareBinding> {
  return Object.fromEntries(
    Object.entries(bindings).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function buildStoreText(store: LocalHardwareBindingStore): string {
  return `${JSON.stringify(
    {
      version: 1,
      bindings: sortBindings(store.bindings),
    },
    null,
    2,
  )}\n`;
}

async function writeBindingStore(
  params: WorkspaceAccessParams,
  store: LocalHardwareBindingStore,
): Promise<LocalHardwareBindingStore | null> {
  const result = await controllerClient.workspace.files.write({
    projectId: params.projectId,
    path: HARDWARE_BINDINGS_PATH,
    content: buildStoreText(store),
    accessToken: params.accessToken ?? null,
    runtimeId: params.runtimeId ?? null,
  });
  return result?.ok ? store : null;
}

export function createSerialHardwareResourceGrant(path: string): LocalHardwareResourceGrant | null {
  const trimmed = path.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return {
    kind: "serial_device",
    id: normalized,
    path: normalized,
    displayName: parts.at(-1) ?? normalized,
  };
}

export async function readProjectHardwareBindingStore(
  params: WorkspaceAccessParams,
): Promise<LocalHardwareBindingStore> {
  const response = await controllerClient.workspace.files.read({
    projectId: params.projectId,
    path: HARDWARE_BINDINGS_PATH,
    accessToken: params.accessToken ?? null,
    runtimeId: params.runtimeId ?? null,
  });

  if (!response) {
    return createEmptyStore();
  }
  if (!response.isText || typeof response.contentText !== "string") {
    throw new Error("Hardware bindings file must be UTF-8 text.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.contentText);
  } catch (error) {
    throw new Error(
      `Hardware bindings file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return normalizeBindingStore(parsed);
}

export async function upsertProjectHardwareBinding(
  params: UpsertProjectHardwareBindingParams,
): Promise<LocalHardwareBinding | null> {
  const providerId = params.providerId.trim();
  if (!providerId) {
    throw new Error("Hardware provider id is required.");
  }
  if (providerId !== SERIAL_HARDWARE_PROVIDER_ID) {
    throw new Error(`Unsupported hardware provider: ${providerId}.`);
  }

  const grantedCapabilities = normalizeCapabilities(params.grantedCapabilities);
  if (grantedCapabilities.length === 0) {
    throw new Error("At least one local hardware capability is required.");
  }

  const store = await readProjectHardwareBindingStoreOrEmpty(params);
  const runtimeHostId = normalizeString(params.runtimeHostId);
  const bindingId = createHardwareBindingKey(providerId, runtimeHostId);
  const existing = store.bindings[bindingId] ?? (!runtimeHostId ? store.bindings[providerId] : null) ?? null;
  const timestamp = new Date().toISOString();
  const binding: LocalHardwareBinding = {
    bindingId,
    providerId,
    projectId: params.projectId.trim(),
    runtimeHostId,
    runtimeHostLabel: normalizeString(params.runtimeHostLabel) ?? existing?.runtimeHostLabel ?? null,
    grantedCapabilities,
    grantedResources: normalizeResources(params.grantedResources ?? existing?.grantedResources ?? []),
    purpose: normalizeString(params.purpose) ?? existing?.purpose ?? null,
    status: "bound",
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };

  store.bindings[bindingId] = binding;
  const saved = await writeBindingStore(params, store);
  return saved ? binding : null;
}

export async function revokeProjectHardwareBinding(
  params: RevokeProjectHardwareBindingParams,
): Promise<boolean> {
  const providerId = params.providerId.trim();
  if (!providerId) {
    throw new Error("Hardware provider id is required.");
  }

  const bindingId = normalizeString(params.bindingId) ?? createHardwareBindingKey(providerId, params.runtimeHostId);
  const store = await readProjectHardwareBindingStoreOrEmpty(params);
  if (!store.bindings[bindingId]) {
    return true;
  }

  delete store.bindings[bindingId];
  const saved = await writeBindingStore(params, store);
  return Boolean(saved);
}
