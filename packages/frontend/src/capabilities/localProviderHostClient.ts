import { Capacitor } from "@capacitor/core";
import type { CapabilityId } from "@instafy/sdk/capabilities";
import {
  createProviderHostClient,
  DEFAULT_PROVIDER_HOST_BASE_URL,
  resolveProviderHealthSnapshot,
  type ProviderHealthSnapshot,
  type ProviderResourceReadOptions,
  type ProviderToolCallOptions,
} from "@instafy/provider-client";
import {
  findProviderForCapability,
  type ProviderExecutionContext,
  providerSupportsCapability,
  type ProviderResourceAliases,
  type ProviderSummary,
  type ProviderToolAliases,
} from "@instafy/provider-contract";
import { isDesktopShell } from "../lib/desktopShell";

export type LocalProviderToolAliases = ProviderToolAliases;
export type LocalProviderResourceAliases = ProviderResourceAliases;
export type LocalProviderSummary = ProviderSummary;
export type LocalProviderHealthSnapshot = ProviderHealthSnapshot;
export { providerSupportsCapability };

const CONFIGURED_LOCAL_PROVIDER_HOST_BASE_URL =
  (import.meta.env.VITE_LOCAL_PROVIDER_HOST_URL as string | undefined)?.replace(/\/$/, "") ||
  (import.meta.env.VITE_ROBOT_BRIDGE_URL as string | undefined)?.replace(/\/$/, "") ||
  null;

export const LOCAL_PROVIDER_HOST_BASE_URL =
  CONFIGURED_LOCAL_PROVIDER_HOST_BASE_URL || DEFAULT_PROVIDER_HOST_BASE_URL;

const LOCAL_PROVIDER_HOST_UNAVAILABLE_ON_THIS_CLIENT_MESSAGE =
  "Local extension discovery from the desktop provider host is unavailable on this phone.";
const LOCAL_PROVIDER_HOST_UNAVAILABLE_IN_THIS_BROWSER_MESSAGE =
  "Extensions on this computer are available in Instafy Desktop.";

const localProviderHostClient = createProviderHostClient({
  baseUrl: LOCAL_PROVIDER_HOST_BASE_URL,
});

function isLoopbackHostname(hostname: string) {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "[::1]" ||
    normalized.endsWith(".localhost")
  );
}

function localProviderHostIsLoopbackHttp() {
  try {
    const url = new URL(LOCAL_PROVIDER_HOST_BASE_URL);
    return url.protocol === "http:" && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

function localProviderHostRequiresDesktopTransport() {
  const platform = Capacitor.getPlatform();
  if (platform !== "android" && platform !== "ios") {
    return false;
  }
  return localProviderHostIsLoopbackHttp();
}

/**
 * A hosted Studio tab (an https page that is not on this computer) cannot use
 * the default provider host on 127.0.0.1. That host answers only Instafy
 * Desktop and local development pages (its allowed origins), and browsers
 * gate a public page's requests to this computer, so asking from a browser
 * tab always ended in "Failed to fetch", whether or not anything was running.
 * A provider host URL set at build time is still asked.
 */
function localProviderHostUnreachableFromHostedPage() {
  if (CONFIGURED_LOCAL_PROVIDER_HOST_BASE_URL || Capacitor.getPlatform() !== "web") {
    return false;
  }
  if (typeof window === "undefined" || isDesktopShell()) {
    return false;
  }
  const { protocol, hostname } = window.location;
  return protocol === "https:" && !isLoopbackHostname(hostname) && localProviderHostIsLoopbackHttp();
}

function assertLocalProviderHostAvailable() {
  if (localProviderHostRequiresDesktopTransport()) {
    throw new Error(LOCAL_PROVIDER_HOST_UNAVAILABLE_ON_THIS_CLIENT_MESSAGE);
  }
  if (localProviderHostUnreachableFromHostedPage()) {
    throw new Error(LOCAL_PROVIDER_HOST_UNAVAILABLE_IN_THIS_BROWSER_MESSAGE);
  }
}

export function isLocalProviderHostUnavailableOnThisClient() {
  return localProviderHostRequiresDesktopTransport() || localProviderHostUnreachableFromHostedPage();
}

export async function localProviderHostJsonRequest<TResponse>(
  path: string,
  init?: RequestInit,
): Promise<TResponse> {
  assertLocalProviderHostAvailable();
  return localProviderHostClient.jsonRequest<TResponse>(path, init);
}

export async function listLocalProviders() {
  assertLocalProviderHostAvailable();
  return localProviderHostClient.listProviders() as Promise<{
    ok: true;
    providers: LocalProviderSummary[];
  }>;
}

export function findLocalProviderForCapability(
  providers: LocalProviderSummary[],
  capabilityId: CapabilityId | string,
): LocalProviderSummary | null {
  return findProviderForCapability(providers, capabilityId) as LocalProviderSummary | null;
}

export async function getLocalProviderSummary(providerId: string): Promise<LocalProviderSummary | null> {
  const result = await listLocalProviders();
  return result.providers.find((provider) => provider.id === providerId) ?? null;
}

export async function getLocalProviderForCapability(
  capabilityId: CapabilityId | string,
): Promise<LocalProviderSummary | null> {
  const result = await listLocalProviders();
  return findLocalProviderForCapability(result.providers, capabilityId);
}

export async function discoverLocalProvider(providerId: string) {
  assertLocalProviderHostAvailable();
  return localProviderHostClient.discoverProvider(providerId) as Promise<{
    ok: true;
    providerId: string;
    provider: Record<string, unknown>;
  }>;
}

export async function readLocalProviderResource<TValue>(
  providerId: string,
  uri: string,
  options?: ProviderResourceReadOptions,
) {
  assertLocalProviderHostAvailable();
  return localProviderHostClient.readProviderResource<TValue>(
    providerId,
    uri,
    options,
  ) as Promise<{
    ok: true;
    providerId?: string;
    id?: string;
    uri: string;
    sourcePath?: string;
    exists?: boolean;
    value?: TValue | null;
  }>;
}

export async function callLocalProviderTool<TValue>(
  providerId: string,
  name: string,
  argumentsValue?: Record<string, unknown>,
  options?: ProviderToolCallOptions,
) {
  assertLocalProviderHostAvailable();
  return localProviderHostClient.callProviderTool<TValue>(
    providerId,
    name,
    argumentsValue,
    options,
  ) as Promise<{
    ok: true;
    providerId?: string;
    name: string;
    value?: TValue;
    executionContext?: ProviderExecutionContext;
  }>;
}

export async function postLocalProviderTransportProbe<TValue>(
  providerId: string,
  body: Record<string, unknown>,
) {
  assertLocalProviderHostAvailable();
  return localProviderHostClient.postProviderTransportProbe<TValue>(providerId, body) as Promise<{
    ok: boolean;
    providerId?: string;
    statusCode?: number;
    value?: TValue;
    executionContext?: ProviderExecutionContext;
    error?: string;
    stderr?: string;
  }>;
}

export async function getLocalProviderHealthSnapshot(
  provider: LocalProviderSummary,
): Promise<LocalProviderHealthSnapshot> {
  assertLocalProviderHostAvailable();
  return resolveProviderHealthSnapshot(localProviderHostClient, provider);
}
