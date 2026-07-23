import type {
  ProviderDiscoveryEnvelope,
  ProviderResourceReadEnvelope,
  ProviderSummary,
  ProviderToolCallEnvelope,
} from "@instafy/provider-contract";

export type ProviderClientRequestInit = {
  method?: string;
  headers?: unknown;
  body?: unknown;
  signal?: unknown;
};

export type ProviderClientFetch = (
  input: string,
  init?: ProviderClientRequestInit,
) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

export type ProviderTransportProbeResponse<TValue = unknown> = TValue;

export type ProviderProjectCapability =
  | "project_content_read"
  | "project_content_write";

export type ProviderInitializationContext = {
  projectId?: string | null;
  rootUri?: string | null;
  grantedCapabilities?: ProviderProjectCapability[];
  grantedPrefix?: string | null;
};

export type ProviderOperationOptions = {
  initialization?: ProviderInitializationContext | null;
};

export type ProviderResourceReadOptions = ProviderOperationOptions;
export type ProviderToolCallOptions = ProviderOperationOptions;

export type ProviderHostClientOptions = {
  baseUrl?: string;
  fetch?: ProviderClientFetch;
};

export type ProviderHostJsonRequestOptions = {
  fetch?: ProviderClientFetch;
};

export type ProviderHealthSnapshot = {
  ok: boolean;
  source: "resource" | "transport_probe" | "availability" | "error";
  checkedAt: string | null;
  resourceUri?: string | null;
  value?: unknown;
  error?: string;
  discoveredProvider?: Record<string, unknown> | null;
};

export type ProviderHostClient = {
  baseUrl: string;
  fetch: ProviderClientFetch;
  jsonRequest<TResponse = unknown>(
    path: string,
    init?: ProviderClientRequestInit,
  ): Promise<TResponse>;
  listProviders(): Promise<{ ok: true; providers: ProviderSummary[] }>;
  discoverProvider(providerId: string): Promise<ProviderDiscoveryEnvelope>;
  readProviderResource<TValue = unknown>(
    providerId: string,
    uri: string,
    options?: ProviderResourceReadOptions,
  ): Promise<ProviderResourceReadEnvelope<TValue>>;
  callProviderTool<TValue = unknown>(
    providerId: string,
    name: string,
    argumentsValue?: Record<string, unknown>,
    options?: ProviderToolCallOptions,
  ): Promise<ProviderToolCallEnvelope<TValue>>;
  postProviderTransportProbe<TValue = unknown>(
    providerId: string,
    body?: Record<string, unknown>,
  ): Promise<ProviderTransportProbeResponse<TValue>>;
};

export const DEFAULT_PROVIDER_HOST_BASE_URL: string;

export function normalizeProviderHostBaseUrl(baseUrl?: string): string;
export function normalizeProviderInitializationContext(
  value?: ProviderInitializationContext | null,
): ProviderInitializationContext | undefined;
export function createProviderHostClient(options?: ProviderHostClientOptions): ProviderHostClient;
export function resolveProviderHealthSnapshot(
  client: ProviderHostClient,
  provider: ProviderSummary,
): Promise<ProviderHealthSnapshot>;
export function providerHostJsonRequest<TResponse = unknown>(
  baseUrl: string | undefined,
  path: string,
  init?: ProviderClientRequestInit,
  options?: ProviderHostJsonRequestOptions,
): Promise<TResponse>;
