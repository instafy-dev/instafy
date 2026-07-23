import kleur from "kleur";
import {
  createProviderHostClient,
  DEFAULT_PROVIDER_HOST_BASE_URL,
  normalizeProviderHostBaseUrl,
} from "@instafy/provider-client";

type ProviderSummary = {
  id: string;
  title: string;
  description?: string;
  kind?: string;
  providerType?: string;
  discoverable?: boolean;
  capabilityIds?: string[];
  toolIds?: string[];
  resourceUris?: string[];
  error?: string;
};

type ProviderHostOptions = {
  providerHostUrl?: string;
  json?: boolean;
};

type ProviderProbeOptions = ProviderHostOptions & {
  providerId: string;
  backend?: string;
  tcpTarget?: string;
  sessionId?: string;
  source?: string;
  timeoutMs?: number;
  readStatus?: boolean;
  drainPending?: boolean;
  skipCommand?: boolean;
  commandJson?: string;
};

function pickTrimmedString(...values: Array<string | undefined | null>) {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function resolveProviderHostUrl(explicitUrl?: string) {
  return normalizeProviderHostBaseUrl(
    pickTrimmedString(
      explicitUrl,
      process.env["INSTAFY_PROVIDER_HOST_URL"],
      process.env["LOCAL_PROVIDER_HOST_URL"],
    ) ?? DEFAULT_PROVIDER_HOST_BASE_URL,
  );
}

function createCliProviderClient(explicitUrl?: string) {
  const providerHostUrl = resolveProviderHostUrl(explicitUrl);
  return {
    providerHostUrl,
    client: createProviderHostClient({
      baseUrl: providerHostUrl,
      fetch: fetch,
    }),
  };
}

function printJson(payload: unknown) {
  console.log(JSON.stringify(payload, null, 2));
}

function formatProviderLabel(provider: ProviderSummary) {
  return provider.title?.trim().length ? provider.title.trim() : provider.id;
}

function printProviderSummary(provider: ProviderSummary) {
  console.log(kleur.green(formatProviderLabel(provider)));
  console.log(`  id: ${provider.id}`);
  if (provider.description) {
    console.log(`  description: ${provider.description}`);
  }
  if (provider.kind) {
    console.log(`  kind: ${provider.kind}`);
  }
  if (provider.providerType) {
    console.log(`  type: ${provider.providerType}`);
  }
  console.log(
    `  discoverable: ${provider.discoverable !== false ? kleur.green("yes") : kleur.yellow("no")}`,
  );
  if (provider.capabilityIds?.length) {
    console.log(`  capabilities: ${provider.capabilityIds.join(", ")}`);
  }
  if (provider.toolIds?.length) {
    console.log(`  tools: ${provider.toolIds.join(", ")}`);
  }
  if (provider.resourceUris?.length) {
    console.log(`  resources: ${provider.resourceUris.join(", ")}`);
  }
  if (provider.error) {
    console.log(`  error: ${kleur.yellow(provider.error)}`);
  }
}

function parseCommandJson(commandJson: string | undefined) {
  const trimmed = pickTrimmedString(commandJson);
  if (!trimmed) {
    return undefined;
  }
  return JSON.parse(trimmed);
}

export async function providersList(options: ProviderHostOptions = {}) {
  const { providerHostUrl, client } = createCliProviderClient(options.providerHostUrl);
  const result = await client.listProviders();

  if (options.json) {
    printJson({
      providerHostUrl,
      providers: result.providers,
    });
    return;
  }

  console.log(kleur.green("Local providers"));
  console.log(`Host: ${providerHostUrl}`);
  if (!result.providers.length) {
    console.log(kleur.yellow("No providers discovered."));
    return;
  }
  for (const provider of result.providers) {
    printProviderSummary(provider);
  }
}

export async function providersDiscover(params: { providerId: string } & ProviderHostOptions) {
  const { providerHostUrl, client } = createCliProviderClient(params.providerHostUrl);
  const result = await client.discoverProvider(params.providerId);

  if (params.json) {
    printJson({
      providerHostUrl,
      ...result,
    });
    return;
  }

  console.log(kleur.green(`Provider discovery: ${params.providerId}`));
  console.log(`Host: ${providerHostUrl}`);
  console.log(JSON.stringify(result.provider ?? result, null, 2));
}

export async function providersRead(params: {
  providerId: string;
  uri: string;
} & ProviderHostOptions) {
  const { providerHostUrl, client } = createCliProviderClient(params.providerHostUrl);
  const result = await client.readProviderResource(params.providerId, params.uri);

  if (params.json) {
    printJson({
      providerHostUrl,
      ...result,
    });
    return;
  }

  console.log(kleur.green(`Provider resource: ${params.uri}`));
  console.log(`Host: ${providerHostUrl}`);
  if (result.exists === false) {
    console.log(kleur.yellow("Resource does not exist."));
    return;
  }
  console.log(JSON.stringify(result.value ?? result, null, 2));
}

export async function providersProbe(params: ProviderProbeOptions) {
  const { providerHostUrl, client } = createCliProviderClient(params.providerHostUrl);
  const result = await client.postProviderTransportProbe(params.providerId, {
    backend: pickTrimmedString(params.backend),
    tcpTarget: pickTrimmedString(params.tcpTarget),
    sessionId: pickTrimmedString(params.sessionId),
    source: pickTrimmedString(params.source),
    timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
    readStatus: params.readStatus,
    drainPending: params.drainPending,
    skipCommand: params.skipCommand,
    commandJson: parseCommandJson(params.commandJson),
  });

  if (params.json) {
    printJson({
      providerHostUrl,
      providerId: params.providerId,
      value: result,
    });
    return;
  }

  console.log(kleur.green(`Provider transport probe: ${params.providerId}`));
  console.log(`Host: ${providerHostUrl}`);
  console.log(JSON.stringify(result, null, 2));
}
