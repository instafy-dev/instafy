export type LocalWorkspaceStatus = "online" | "offline" | "expired";

export type ControllerOriginPresenceStatus = "online" | "offline" | "degraded";

export interface ControllerOriginPresence {
  status: ControllerOriginPresenceStatus;
  lastHeartbeat?: string | null;
  latencyMs?: number | null;
  region?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ControllerOriginSummary {
  originId: string;
  runtimeId?: string | null;
  endpoint: string;
  mode: string;
  protocols?: string[];
  region?: string | null;
  deviceId?: string | null;
  metadata?: Record<string, unknown> | null;
  presence?: ControllerOriginPresence | null;
}

export interface ControllerLocalWorkspace {
  deviceId: string;
  path?: string | null;
  hostname?: string | null;
  platform?: string | null;
  release?: string | null;
  arch?: string | null;
  lastHeartbeat?: string;
  expiresAt?: string | null;
  runtimeId?: string | null;
  region?: string | null;
  latencyMs?: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface LocalWorkspacePresence extends ControllerLocalWorkspace {
  status: LocalWorkspaceStatus;
  presenceStatus?: ControllerOriginPresenceStatus | null;
}

export interface LocalWorkspaceEventData extends Partial<ControllerLocalWorkspace> {
  status?: LocalWorkspaceStatus;
}
