import type {
  OtaCheckRequest,
  OtaCheckResponse,
  OtaEventType,
  OtaPlatform,
  OtaUpdateEvent,
} from "@instafy/ota-contracts";
import { isOtaNativeBuild } from "@instafy/ota-contracts";
import { instafyBuildInfo } from "../../config/buildInfo";
import { controllerBaseUrl, readControllerError } from "../../sdk/instafy";
import { getNativeLiveUpdateDeviceId } from "./liveUpdate";
import {
  getOrCreateFallbackNativeOtaDeviceId,
  storeLastNativeOtaCheckSnapshot,
  readStoredNativeOtaState,
  storeLastNativeOtaResult,
} from "./state";
import {
  otaIsSupportedOnThisClient,
  resolveNativeOtaChannel,
  resolveNativeOtaPlatform,
} from "./shared";

export interface NativeOtaIdentity {
  device_id: string;
  platform: OtaPlatform;
  channel: string;
  native_version: string;
  native_build?: string | null;
  current_bundle_version: string | null;
  current_git_sha: string | null;
}

export interface NativeOtaIdentityOverrides {
  device_id?: string | null;
  channel?: string | null;
  current_bundle_version?: string | null;
  current_git_sha?: string | null;
}

async function postJson<TResponse>(path: string, body: unknown): Promise<TResponse> {
  const response = await fetch(`${controllerBaseUrl}${path}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await readControllerError(response, `OTA request failed for ${path}`));
  }
  return (await response.json()) as TResponse;
}

async function resolveNativeOtaDeviceId(): Promise<string | null> {
  const pluginDeviceId = await getNativeLiveUpdateDeviceId().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[ota] unable to resolve plugin device id:", message);
    return null;
  });
  return pluginDeviceId ?? getOrCreateFallbackNativeOtaDeviceId();
}

export async function buildNativeOtaIdentity(
  overrides: NativeOtaIdentityOverrides = {},
): Promise<NativeOtaIdentity | null> {
  if (!otaIsSupportedOnThisClient()) {
    return null;
  }
  const platform = resolveNativeOtaPlatform();
  const device_id = overrides.device_id ?? (await resolveNativeOtaDeviceId());
  if (!platform || !device_id) {
    return null;
  }
  try {
    const { App } = await import("@capacitor/app");
    const info = await App.getInfo();
    const currentState = readStoredNativeOtaState().current;
    return {
      device_id,
      platform,
      channel: overrides.channel ?? resolveNativeOtaChannel(),
      native_version: info.version?.trim() || "0.0.0",
      native_build: isOtaNativeBuild(info.build) ? info.build : null,
      current_bundle_version:
        overrides.current_bundle_version !== undefined
          ? overrides.current_bundle_version
          : currentState.bundle_version,
      current_git_sha:
        overrides.current_git_sha !== undefined
          ? overrides.current_git_sha
          : currentState.git_sha,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[ota] unable to build native OTA identity:", message);
    return null;
  }
}

export async function checkForNativeOtaUpdate(
  identity: NativeOtaIdentity,
): Promise<OtaCheckResponse> {
  const payload: OtaCheckRequest = {
    device_id: identity.device_id,
    platform: identity.platform,
    channel: identity.channel,
    native_version: identity.native_version,
    native_build: isOtaNativeBuild(identity.native_build) ? identity.native_build : null,
    current_bundle_version: identity.current_bundle_version,
    current_git_sha: identity.current_git_sha,
  };
  const response = await postJson<OtaCheckResponse>("/ota/check", payload);
  // Defense in depth: a guarded offer must never reach download/staging on the wrong shell,
  // even if a stale or misconfigured controller returns update_available.
  const result: OtaCheckResponse =
    response.update_available && response.required_native_build != null &&
    (!isOtaNativeBuild(response.required_native_build) ||
      response.required_native_build !== payload.native_build)
      ? { update_available: false, reason: "native_build_incompatible" }
      : response;
  storeLastNativeOtaResult(result.reason);
  storeLastNativeOtaCheckSnapshot({
    checked_at: new Date().toISOString(),
    update_available: result.update_available,
    reason: result.reason ?? null,
    release_id: result.release_id ?? null,
    bundle_version: result.bundle_version ?? null,
    git_sha: result.git_sha ?? null,
  });
  return result;
}

export async function postNativeOtaEvent(input: {
  event_type: OtaEventType;
  identity: NativeOtaIdentity;
  session_id?: string | null;
  properties?: Record<string, unknown>;
  bundle_version?: string | null;
  git_sha?: string | null;
}): Promise<void> {
  const event: OtaUpdateEvent = {
    event_id:
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `evt-${Date.now()}`,
    event_type: input.event_type,
    occurred_at: new Date().toISOString(),
    device_id: input.identity.device_id,
    platform: input.identity.platform,
    channel: input.identity.channel,
    native_version: input.identity.native_version,
    native_build: isOtaNativeBuild(input.identity.native_build) ? input.identity.native_build : null,
    bundle_version: input.bundle_version ?? input.identity.current_bundle_version,
    git_sha: input.git_sha ?? input.identity.current_git_sha,
    session_id: input.session_id ?? null,
    properties: {
      build_release_id: instafyBuildInfo.releaseId,
      build_git_sha: instafyBuildInfo.gitCommit,
      build_git_short: instafyBuildInfo.gitCommitShort,
      ...(input.properties ?? {}),
    },
  };
  const response = await fetch(`${controllerBaseUrl}/ota/events`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(event),
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[ota] unable to post OTA event:", message);
    return null;
  });
  if (response && !response.ok) {
    const message = await readControllerError(response, "OTA event ingestion failed");
    console.warn("[ota] controller rejected OTA event:", message);
  }
}
