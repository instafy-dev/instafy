export type OtaPlatform = "ios" | "android";

export type OtaReleaseStatus =
  | "draft"
  | "live"
  | "paused"
  | "rolled_back"
  | "archived";

export type OtaEventType =
  | "update_check_requested"
  | "update_available"
  | "update_not_available"
  | "download_started"
  | "download_completed"
  | "download_failed"
  | "install_started"
  | "install_completed"
  | "install_failed"
  | "app_reloaded"
  | "rollback_triggered"
  | "session_started"
  | "session_ended"
  | "usage_heartbeat";

export interface OtaReleaseRecord {
  release_id: string;
  platform: OtaPlatform;
  channel: string;
  bundle_version: string;
  git_sha: string;
  native_version: string;
  min_supported_native_version: string;
  artifact_url: string;
  artifact_sha256: string;
  artifact_size_bytes: number;
  artifact_type: "zip";
  signature?: string | null;
  rollout_percentage: number;
  status: OtaReleaseStatus;
  published_at: string;
  published_by: string;
  notes?: string | null;
}

export interface OtaChannelAssignment {
  platform: OtaPlatform;
  channel: string;
  active_release_id: string;
  previous_release_id?: string | null;
  rollout_percentage: number;
  activated_at: string;
  activated_by: string;
}

export type OtaChannelHistoryAction = "activate" | "rollback";

export interface OtaChannelHistoryEntry {
  history_id: string;
  platform: OtaPlatform;
  channel: string;
  action: OtaChannelHistoryAction;
  previous_release_id?: string | null;
  next_release_id: string;
  rollout_percentage: number;
  activated_at: string;
  activated_by: string;
}

export interface OtaDeviceState {
  device_id: string;
  platform: OtaPlatform;
  channel: string;
  native_version: string;
  current_bundle_version?: string | null;
  current_git_sha?: string | null;
  last_seen_at: string;
  last_check_at?: string | null;
  last_event_type?: OtaEventType | null;
  last_event_at?: string | null;
  last_release_id?: string | null;
  last_session_id?: string | null;
  last_user_id?: string | null;
  last_space_id?: string | null;
}

export interface OtaUpdateEvent {
  event_id: string;
  event_type: OtaEventType;
  occurred_at: string;
  device_id: string;
  platform: OtaPlatform;
  channel: string;
  native_version: string;
  bundle_version?: string | null;
  git_sha?: string | null;
  space_id?: string | null;
  user_id?: string | null;
  session_id?: string | null;
  country_code?: string | null;
  properties?: Record<string, unknown>;
}

export interface OtaCheckRequest {
  device_id: string;
  platform: OtaPlatform;
  channel: string;
  native_version: string;
  current_bundle_version?: string | null;
  current_git_sha?: string | null;
}

export interface OtaCheckResponse {
  update_available: boolean;
  reason: string;
  release_id?: string | null;
  bundle_version?: string | null;
  git_sha?: string | null;
  artifact_url?: string | null;
  artifact_sha256?: string | null;
  artifact_size_bytes?: number | null;
  artifact_type?: string | null;
  signature?: string | null;
  rollout_percentage?: number | null;
}

export interface ActivateOtaChannelRequest {
  release_id: string;
  rollout_percentage?: number | null;
  activated_by: string;
}

export interface RollbackOtaChannelRequest {
  release_id?: string | null;
  activated_by: string;
}

export interface OtaReleaseRegistrationInput extends Omit<OtaReleaseRecord, "published_at"> {
  published_at?: string;
}

export function isOtaPlatform(value: unknown): value is OtaPlatform {
  return value === "ios" || value === "android";
}

export type DesktopReleaseChannel = "internal" | "stable";

export type DesktopUpdatePhase =
  | "idle"
  | "checking"
  | "update_available"
  | "downloading"
  | "downloaded"
  | "up_to_date"
  | "error";

export type DesktopUpdateEventType =
  | "update_available"
  | "update_not_available"
  | "download_started"
  | "download_completed"
  | "update_ready"
  | "install_applied"
  | "update_error";

export interface DesktopUpdateDeviceState {
  device_id: string;
  channel: DesktopReleaseChannel;
  current_version: string;
  phase: DesktopUpdatePhase;
  feed_url: string;
  platform?: string | null;
  arch?: string | null;
  available_version?: string | null;
  last_seen_at: string;
  last_event_type?: DesktopUpdateEventType | null;
  last_event_at?: string | null;
  last_checked_at?: string | null;
  last_downloaded_at?: string | null;
  last_error?: string | null;
}

export interface DesktopUpdateEvent {
  event_id: string;
  event_type: DesktopUpdateEventType;
  occurred_at: string;
  device_id: string;
  channel: DesktopReleaseChannel;
  current_version: string;
  phase: DesktopUpdatePhase;
  feed_url: string;
  platform?: string | null;
  arch?: string | null;
  available_version?: string | null;
  country_code?: string | null;
  properties?: Record<string, unknown>;
}

export interface DesktopPromotionRecord {
  request_id: string;
  source_channel: DesktopReleaseChannel;
  target_channel: DesktopReleaseChannel;
  workflow_ref: string;
  requested_at: string;
  requested_by: string;
  status: "dispatched";
  notes?: string | null;
}

export interface DesktopPromotionRequest {
  source_channel: DesktopReleaseChannel;
  target_channel: DesktopReleaseChannel;
  requested_by: string;
  notes?: string | null;
}

export function isDesktopReleaseChannel(value: unknown): value is DesktopReleaseChannel {
  return value === "internal" || value === "stable";
}
