import {
  LiveUpdate,
  type DownloadBundleOptions,
  type ReadyResult,
} from "@capawesome/capacitor-live-update";
import { otaIsSupportedOnThisClient } from "./shared";

export interface NativeLiveUpdateDownload {
  bundle_id: string;
  url: string;
  artifact_type?: "manifest" | "zip";
  checksum?: string | null;
  signature?: string | null;
  cache_bust?: string | null;
}

export function buildNativeLiveUpdateDownloadUrl(input: NativeLiveUpdateDownload): string {
  const cacheBust = input.cache_bust?.trim();
  if (!cacheBust) {
    return input.url;
  }
  try {
    const url = new URL(input.url);
    url.searchParams.set("download", cacheBust);
    return url.toString();
  } catch {
    const separator = input.url.includes("?") ? "&" : "?";
    return `${input.url}${separator}download=${encodeURIComponent(cacheBust)}`;
  }
}

export async function setNativeLiveUpdateChannel(channel: string): Promise<void> {
  if (!otaIsSupportedOnThisClient()) {
    return;
  }
  await LiveUpdate.setChannel({ channel });
}

export async function getNativeLiveUpdateDeviceId(): Promise<string | null> {
  if (!otaIsSupportedOnThisClient()) {
    return null;
  }
  const result = await LiveUpdate.getDeviceId();
  return result.deviceId?.trim() || null;
}

export async function getNativeLiveUpdateCurrentBundleId(): Promise<string | null> {
  if (!otaIsSupportedOnThisClient()) {
    return null;
  }
  const result = await LiveUpdate.getCurrentBundle();
  return result.bundleId?.trim() || null;
}

export async function getNativeLiveUpdateDownloadedBundleIds(): Promise<string[]> {
  if (!otaIsSupportedOnThisClient()) {
    return [];
  }
  const result = await LiveUpdate.getDownloadedBundles();
  if (!Array.isArray(result.bundleIds)) {
    return [];
  }
  return result.bundleIds
    .map((bundleId: string) => bundleId.trim())
    .filter((bundleId: string) => bundleId.length > 0);
}

export async function markNativeLiveUpdateReady(): Promise<ReadyResult | null> {
  if (!otaIsSupportedOnThisClient()) {
    return null;
  }
  return await LiveUpdate.ready();
}

export async function downloadNativeLiveUpdateBundle(
  input: NativeLiveUpdateDownload,
): Promise<void> {
  if (!otaIsSupportedOnThisClient()) {
    return;
  }
  const options: DownloadBundleOptions = {
    bundleId: input.bundle_id,
    url: buildNativeLiveUpdateDownloadUrl(input),
    artifactType: input.artifact_type ?? "zip",
  };
  if (options.artifactType === "zip") {
    options.checksum = input.checksum ?? undefined;
    options.signature = input.signature ?? undefined;
  }
  await LiveUpdate.downloadBundle(options);
}

export async function setNativeLiveUpdateNextBundle(
  bundleId: string | null,
): Promise<void> {
  if (!otaIsSupportedOnThisClient()) {
    return;
  }
  await LiveUpdate.setNextBundle({ bundleId });
}

export async function reloadIntoNativeLiveUpdateBundle(): Promise<void> {
  if (!otaIsSupportedOnThisClient()) {
    return;
  }
  await LiveUpdate.reload();
}
