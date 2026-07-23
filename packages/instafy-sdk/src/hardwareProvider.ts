export const LOCAL_HARDWARE_PROVIDER_FAMILY_ID = "local.hardware";
export const SERIAL_HARDWARE_PROVIDER_ID = "hardware.serial";

export type LocalHardwareCapability =
  | "hardware_serial_list"
  | "hardware_serial_probe";

export type LocalHardwareAccessStatus =
  | "available"
  | "permission_required"
  | "not_available"
  | "unsupported";

export type SerialPortKind =
  | "usb_serial"
  | "bluetooth_serial"
  | "serial"
  | "unknown";

export type LocalHardwareIoOpportunityKind = string;

export type LocalHardwareIoActionId = string;

export type LocalHardwareIoActionStatus = "available" | "planned";
export type LocalHardwareIoActionSource = "runtime";

export interface LocalHardwareProviderDescriptor {
  providerId: string;
  familyId: typeof LOCAL_HARDWARE_PROVIDER_FAMILY_ID;
  displayName: string;
  purpose: string;
  requestedCapabilities: LocalHardwareCapability[];
}

export type LocalHardwareBindingStatus = "bound";

export type LocalHardwareResourceGrant = {
  kind: "serial_device";
  id: string;
  path: string;
  displayName?: string | null;
};

export interface LocalHardwareBinding {
  bindingId?: string | null;
  providerId: string;
  projectId: string;
  runtimeHostId?: string | null;
  runtimeHostLabel?: string | null;
  grantedCapabilities: LocalHardwareCapability[];
  grantedResources: LocalHardwareResourceGrant[];
  purpose?: string | null;
  status: LocalHardwareBindingStatus;
  createdAt: string;
  updatedAt: string;
}

export interface LocalHardwareBindingStore {
  version: 1;
  bindings: Record<string, LocalHardwareBinding>;
}

export interface SerialPortDescriptor {
  path: string;
  displayName: string;
  kind: SerialPortKind;
  source: "host";
  available: boolean;
  isCharacterDevice?: boolean;
  stableId?: string | null;
  detail?: string | null;
}

export interface SerialPortListResult {
  providerId: typeof SERIAL_HARDWARE_PROVIDER_ID;
  platform: NodeJS.Platform | string;
  ports: SerialPortDescriptor[];
}

export interface SerialPortProbeResult {
  providerId: typeof SERIAL_HARDWARE_PROVIDER_ID;
  path: string;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  isCharacterDevice: boolean;
  available: boolean;
  error?: string | null;
}

export interface LocalHardwareIoAction {
  id: LocalHardwareIoActionId;
  label: string;
  status: LocalHardwareIoActionStatus;
  source?: LocalHardwareIoActionSource;
  description?: string | null;
}

export interface LocalHardwareIoOpportunity {
  id: string;
  providerId: typeof SERIAL_HARDWARE_PROVIDER_ID;
  kind: LocalHardwareIoOpportunityKind;
  title: string;
  detail?: string | null;
  resource: LocalHardwareResourceGrant;
  available: boolean;
  actions: LocalHardwareIoAction[];
}

export interface LocalHardwareIoOpportunityListResult {
  providerId: typeof SERIAL_HARDWARE_PROVIDER_ID;
  platform: NodeJS.Platform | string;
  opportunities: LocalHardwareIoOpportunity[];
}

export interface LocalHardwareIoActionRunRequest {
  actionId: LocalHardwareIoActionId;
  resource: LocalHardwareResourceGrant;
}

export interface LocalHardwareHostProcessResult {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

export interface LocalHardwareIoActionRunResult {
  providerId: typeof SERIAL_HARDWARE_PROVIDER_ID;
  actionId: LocalHardwareIoActionId;
  ok: boolean;
  message: string;
  startedAt: string;
  finishedAt: string;
  serialProbe?: SerialPortProbeResult | null;
  process?: LocalHardwareHostProcessResult | null;
  error?: string | null;
}

export const SERIAL_HARDWARE_PROVIDER_DESCRIPTOR: LocalHardwareProviderDescriptor = {
  providerId: SERIAL_HARDWARE_PROVIDER_ID,
  familyId: LOCAL_HARDWARE_PROVIDER_FAMILY_ID,
  displayName: "Local serial hardware",
  purpose:
    "Allow a local Instafy runtime to discover and probe host USB serial devices.",
  requestedCapabilities: ["hardware_serial_list", "hardware_serial_probe"],
};
