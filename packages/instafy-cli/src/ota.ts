import fs from "node:fs";
import { requestControllerApiJson } from "./api.js";

type OtaPlatform = "ios" | "android";
type OtaReleaseStatus = "draft" | "live" | "paused" | "rolled_back" | "archived";
type DesktopReleaseChannel = "internal" | "stable";

type OtaReleaseRecord = {
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
};

type OtaReleaseRegistrationInput = Omit<OtaReleaseRecord, "published_at"> & {
  published_at?: string;
};

type OtaChannelAssignment = {
  platform: OtaPlatform;
  channel: string;
  active_release_id: string;
  previous_release_id?: string | null;
  rollout_percentage: number;
  activated_at: string;
  activated_by: string;
};

type ActivateOtaChannelRequest = {
  release_id: string;
  rollout_percentage?: number | null;
  activated_by: string;
};

type RollbackOtaChannelRequest = {
  release_id?: string | null;
  activated_by: string;
};

type DesktopPromotionRecord = {
  request_id: string;
  source_channel: DesktopReleaseChannel;
  target_channel: DesktopReleaseChannel;
  workflow_ref: string;
  requested_at: string;
  requested_by: string;
  status: "dispatched";
  notes?: string | null;
};

type DesktopPromotionRequest = {
  source_channel: DesktopReleaseChannel;
  target_channel: DesktopReleaseChannel;
  requested_by: string;
  notes?: string | null;
};

function isOtaPlatform(value: unknown): value is OtaPlatform {
  return value === "ios" || value === "android";
}

function isDesktopReleaseChannel(value: unknown): value is DesktopReleaseChannel {
  return value === "internal" || value === "stable";
}

function cleanText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function required(value: string | null, flag: string): string {
  if (!value) {
    throw new Error(`Missing required ${flag}`);
  }
  return value;
}

function parseNumber(value: string | number | null | undefined, flag: string): number {
  const raw = typeof value === "number" ? String(value) : cleanText(value ?? null);
  if (!raw) {
    throw new Error(`Missing required ${flag}`);
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${flag}: ${value}`);
  }
  return parsed;
}

function parseOptionalNumber(value: string | number | null | undefined): number | null {
  const raw = typeof value === "number" ? String(value) : cleanText(value ?? null);
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value: ${value}`);
  }
  return parsed;
}

function parsePlatform(value: unknown): OtaPlatform {
  const platform = cleanText(typeof value === "string" ? value : null);
  if (!platform || !isOtaPlatform(platform)) {
    throw new Error(`Invalid --platform value: ${String(value ?? "")}`);
  }
  return platform;
}

function parseDesktopChannel(value: unknown, flag: string) {
  const channel = cleanText(typeof value === "string" ? value : null);
  if (!channel || !isDesktopReleaseChannel(channel)) {
    throw new Error(`Invalid ${flag}: ${String(value ?? "")}`);
  }
  return channel;
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

function printLines(lines: string[]) {
  for (const line of lines) {
    console.log(line);
  }
}

function formatReleaseLine(release: OtaReleaseRecord): string {
  return [
    release.release_id,
    `${release.platform}/${release.channel}`,
    `bundle=${release.bundle_version}`,
    `status=${release.status}`,
    `rollout=${release.rollout_percentage}%`,
  ].join("  ");
}

function formatChannelLine(channel: OtaChannelAssignment): string {
  return [
    `${channel.platform}/${channel.channel}`,
    `active=${channel.active_release_id}`,
    `previous=${channel.previous_release_id ?? "-"}`,
    `rollout=${channel.rollout_percentage}%`,
  ].join("  ");
}

function formatDesktopPromotionLine(record: DesktopPromotionRecord): string {
  return [
    record.request_id,
    `${record.source_channel} -> ${record.target_channel}`,
    `status=${record.status}`,
    `requested_by=${record.requested_by}`,
    `workflow=${record.workflow_ref}`,
  ].join("  ");
}

export async function listOtaReleases(options: {
  controllerUrl?: string;
  accessToken?: string;
  serviceToken?: string;
  platform?: string;
  channel?: string;
  status?: string;
  json?: boolean;
}) {
  const releases = await requestControllerApiJson<OtaReleaseRecord[]>({
    method: "GET",
    path: "/ota/releases",
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
  });

  const filtered = releases.filter((release) => {
    if (cleanText(options.platform) && release.platform !== options.platform) {
      return false;
    }
    if (cleanText(options.channel) && release.channel !== options.channel) {
      return false;
    }
    if (cleanText(options.status) && release.status !== options.status) {
      return false;
    }
    return true;
  });

  if (options.json) {
    printJson(filtered);
    return;
  }
  printLines(filtered.length ? filtered.map(formatReleaseLine) : ["No releases."]);
}

export async function registerOtaRelease(options: {
  controllerUrl?: string;
  accessToken?: string;
  serviceToken?: string;
  file?: string;
  releaseId?: string;
  platform?: string;
  channel?: string;
  bundleVersion?: string;
  gitSha?: string;
  nativeVersion?: string;
  minSupportedNativeVersion?: string;
  artifactUrl?: string;
  artifactSha256?: string;
  artifactSizeBytes?: string | number;
  artifactType?: string;
  signature?: string;
  rolloutPercentage?: string | number;
  status?: string;
  publishedAt?: string;
  publishedBy?: string;
  notes?: string;
  json?: boolean;
}) {
  const payload = options.file
    ? readJsonFile<OtaReleaseRegistrationInput>(options.file)
    : {
        release_id: required(cleanText(options.releaseId), "--release-id"),
        platform: parsePlatform(options.platform),
        channel: required(cleanText(options.channel), "--channel"),
        bundle_version: required(cleanText(options.bundleVersion), "--bundle-version"),
        git_sha: required(cleanText(options.gitSha), "--git-sha"),
        native_version: required(cleanText(options.nativeVersion), "--native-version"),
        min_supported_native_version: required(
          cleanText(options.minSupportedNativeVersion ?? options.nativeVersion),
          "--min-supported-native-version",
        ),
        artifact_url: required(cleanText(options.artifactUrl), "--artifact-url"),
        artifact_sha256: required(cleanText(options.artifactSha256), "--artifact-sha256"),
        artifact_size_bytes: parseNumber(options.artifactSizeBytes, "--artifact-size-bytes"),
        artifact_type: (cleanText(options.artifactType) ?? "zip") as "zip",
        signature: cleanText(options.signature),
        rollout_percentage: parseOptionalNumber(options.rolloutPercentage) ?? 100,
        status: (cleanText(options.status) ?? "draft") as OtaReleaseStatus,
        published_at: cleanText(options.publishedAt) ?? new Date().toISOString(),
        published_by: cleanText(options.publishedBy) ?? "instafy-cli",
        notes: cleanText(options.notes),
      } satisfies OtaReleaseRegistrationInput;

  const created = await requestControllerApiJson<OtaReleaseRecord>({
    method: "POST",
    path: "/ota/releases",
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
    jsonBody: payload,
  });

  if (options.json) {
    printJson(created);
    return;
  }
  printLines([`Registered ${created.release_id}`, formatReleaseLine(created)]);
}

export async function listOtaChannels(options: {
  controllerUrl?: string;
  accessToken?: string;
  serviceToken?: string;
  platform?: string;
  channel?: string;
  json?: boolean;
}) {
  const channels = await requestControllerApiJson<OtaChannelAssignment[]>({
    method: "GET",
    path: "/ota/channels",
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
  });

  const filtered = channels.filter((entry) => {
    if (cleanText(options.platform) && entry.platform !== options.platform) {
      return false;
    }
    if (cleanText(options.channel) && entry.channel !== options.channel) {
      return false;
    }
    return true;
  });

  if (options.json) {
    printJson(filtered);
    return;
  }
  printLines(filtered.length ? filtered.map(formatChannelLine) : ["No channels."]);
}

export async function activateOtaChannelCli(options: {
  controllerUrl?: string;
  accessToken?: string;
  serviceToken?: string;
  platform?: string;
  channel?: string;
  releaseId?: string;
  rolloutPercentage?: string | number;
  activatedBy?: string;
  json?: boolean;
}) {
  const payload: ActivateOtaChannelRequest = {
    release_id: required(cleanText(options.releaseId), "--release-id"),
    rollout_percentage: parseOptionalNumber(options.rolloutPercentage),
    activated_by: required(cleanText(options.activatedBy), "--activated-by"),
  };
  const updated = await requestControllerApiJson<OtaChannelAssignment>({
    method: "POST",
    path: `/ota/channels/${encodeURIComponent(parsePlatform(options.platform))}/${encodeURIComponent(required(cleanText(options.channel), "--channel"))}/activate`,
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
    jsonBody: payload,
  });

  if (options.json) {
    printJson(updated);
    return;
  }
  printLines([`Activated ${updated.active_release_id}`, formatChannelLine(updated)]);
}

export async function rollbackOtaChannelCli(options: {
  controllerUrl?: string;
  accessToken?: string;
  serviceToken?: string;
  platform?: string;
  channel?: string;
  releaseId?: string;
  activatedBy?: string;
  json?: boolean;
}) {
  const payload: RollbackOtaChannelRequest = {
    release_id: cleanText(options.releaseId),
    activated_by: required(cleanText(options.activatedBy), "--activated-by"),
  };
  const updated = await requestControllerApiJson<OtaChannelAssignment>({
    method: "POST",
    path: `/ota/channels/${encodeURIComponent(parsePlatform(options.platform))}/${encodeURIComponent(required(cleanText(options.channel), "--channel"))}/rollback`,
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
    jsonBody: payload,
  });

  if (options.json) {
    printJson(updated);
    return;
  }
  printLines([`Rolled back ${updated.platform}/${updated.channel}`, formatChannelLine(updated)]);
}

export async function listDesktopPromotions(options: {
  controllerUrl?: string;
  accessToken?: string;
  serviceToken?: string;
  targetChannel?: string;
  limit?: string | number;
  json?: boolean;
}) {
  const query: string[] = [];
  const targetChannel = cleanText(options.targetChannel);
  if (targetChannel) {
    query.push(`target_channel=${parseDesktopChannel(targetChannel, "--target-channel")}`);
  }
  const limit = parseOptionalNumber(options.limit);
  if (limit !== null) {
    query.push(`limit=${limit}`);
  }
  const promotions = await requestControllerApiJson<DesktopPromotionRecord[]>({
    method: "GET",
    path: "/desktop-updates/promotions",
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
    query,
  });

  if (options.json) {
    printJson(promotions);
    return;
  }
  printLines(promotions.length ? promotions.map(formatDesktopPromotionLine) : ["No desktop promotions."]);
}

export async function requestDesktopPromotionCli(options: {
  controllerUrl?: string;
  accessToken?: string;
  serviceToken?: string;
  sourceChannel?: string;
  targetChannel?: string;
  requestedBy?: string;
  notes?: string;
  json?: boolean;
}) {
  const payload: DesktopPromotionRequest = {
    source_channel: parseDesktopChannel(options.sourceChannel, "--source-channel"),
    target_channel: parseDesktopChannel(options.targetChannel, "--target-channel"),
    requested_by: required(cleanText(options.requestedBy), "--requested-by"),
    notes: cleanText(options.notes),
  };
  const created = await requestControllerApiJson<DesktopPromotionRecord>({
    method: "POST",
    path: "/desktop-updates/promotions",
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
    jsonBody: payload,
  });

  if (options.json) {
    printJson(created);
    return;
  }
  printLines([`Promotion requested ${created.request_id}`, formatDesktopPromotionLine(created)]);
}
