import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export type NativeLanDiscoveryService = {
  serviceName: string;
  serviceType: string;
  host: string | null;
  port: number | null;
  baseUrl: string | null;
  tokenHint: string | null;
  hostMode: string | null;
  authRequired: boolean;
  updatedAt: string | null;
};

export type NativeLanDiscoverySnapshot = {
  state: "idle" | "scanning" | "error" | "unsupported";
  services: NativeLanDiscoveryService[];
  lastError: string | null;
  updatedAt: string | null;
  clientReachability: "lan" | "loopback" | null;
};

type NativeLanDiscoveryEvent = {
  snapshot?: NativeLanDiscoverySnapshot | null;
};

type NativeLanDiscoveryPlugin = {
  addListener(
    eventName: "lanDiscovery",
    listenerFunc: (event: NativeLanDiscoveryEvent) => void,
  ): Promise<PluginListenerHandle>;
  getStatus(): Promise<NativeLanDiscoveryEvent>;
  startDiscovery(): Promise<NativeLanDiscoveryEvent>;
  stopDiscovery(): Promise<NativeLanDiscoveryEvent>;
};

let nativeLanDiscoveryPlugin: NativeLanDiscoveryPlugin | null = null;
let nativeLanDiscoveryPluginInitialized = false;
let nativeLanDiscoveryStartPromise: Promise<NativeLanDiscoverySnapshot | null> | null = null;
let nativeLanDiscoveryStarted = false;

function getNativeLanDiscoveryPlugin(): NativeLanDiscoveryPlugin | null {
  if (!Capacitor.isNativePlatform()) {
    return null;
  }
  const platform = Capacitor.getPlatform();
  if (platform !== "ios" && platform !== "android") {
    return null;
  }
  if (!nativeLanDiscoveryPluginInitialized) {
    nativeLanDiscoveryPlugin = registerPlugin<NativeLanDiscoveryPlugin>("InstafyLanDiscoveryBridge");
    nativeLanDiscoveryPluginInitialized = true;
  }
  return nativeLanDiscoveryPlugin;
}

function normalizeString(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeHost(value: string | null | undefined) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }
  return normalized.replace(/\.$/, "");
}

function normalizeBaseUrl(value: string | null | undefined) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }
  return normalized.replace(/\/+$/, "");
}

function normalizeService(value: NativeLanDiscoveryService | null | undefined): NativeLanDiscoveryService | null {
  if (!value) {
    return null;
  }
  const serviceName = normalizeString(value.serviceName);
  const serviceType = normalizeString(value.serviceType);
  if (!serviceName || !serviceType) {
    return null;
  }
  return {
    serviceName,
    serviceType,
    host: normalizeHost(value.host),
    port: typeof value.port === "number" && Number.isFinite(value.port) && value.port > 0 ? value.port : null,
    baseUrl: normalizeBaseUrl(value.baseUrl),
    tokenHint: normalizeString(value.tokenHint),
    hostMode: normalizeString(value.hostMode),
    authRequired: value.authRequired === true,
    updatedAt: normalizeString(value.updatedAt),
  };
}

function normalizeSnapshot(value: NativeLanDiscoverySnapshot | null | undefined): NativeLanDiscoverySnapshot | null {
  if (!value) {
    return null;
  }
  const state =
    value.state === "idle" || value.state === "scanning" || value.state === "error" || value.state === "unsupported"
      ? value.state
      : "unsupported";
  return {
    state,
    services: Array.isArray(value.services)
      ? value.services
          .map((service) => normalizeService(service))
          .filter((service): service is NativeLanDiscoveryService => Boolean(service))
      : [],
    lastError: normalizeString(value.lastError),
    updatedAt: normalizeString(value.updatedAt),
    clientReachability:
      value.clientReachability === "lan" || value.clientReachability === "loopback"
        ? value.clientReachability
        : null,
  };
}

export async function readNativeLanDiscoveryStatus(): Promise<NativeLanDiscoverySnapshot | null> {
  const plugin = getNativeLanDiscoveryPlugin();
  if (!plugin) {
    return null;
  }
  try {
    const result = await plugin.getStatus();
    return normalizeSnapshot(result?.snapshot);
  } catch {
    return null;
  }
}

export async function ensureNativeLanDiscoveryStarted(): Promise<NativeLanDiscoverySnapshot | null> {
  const plugin = getNativeLanDiscoveryPlugin();
  if (!plugin) {
    return null;
  }
  if (nativeLanDiscoveryStarted) {
    return await readNativeLanDiscoveryStatus();
  }
  if (!nativeLanDiscoveryStartPromise) {
    nativeLanDiscoveryStartPromise = plugin
      .startDiscovery()
      .then((result) => {
        nativeLanDiscoveryStarted = true;
        return normalizeSnapshot(result?.snapshot);
      })
      .catch(() => null)
      .finally(() => {
        nativeLanDiscoveryStartPromise = null;
      });
  }
  return await nativeLanDiscoveryStartPromise;
}

export async function stopNativeLanDiscovery(): Promise<NativeLanDiscoverySnapshot | null> {
  const plugin = getNativeLanDiscoveryPlugin();
  if (!plugin) {
    return null;
  }
  try {
    const result = await plugin.stopDiscovery();
    nativeLanDiscoveryStarted = false;
    return normalizeSnapshot(result?.snapshot);
  } catch {
    return null;
  }
}

export async function listenForNativeLanDiscovery(
  listener: (snapshot: NativeLanDiscoverySnapshot) => void,
): Promise<PluginListenerHandle | null> {
  const plugin = getNativeLanDiscoveryPlugin();
  if (!plugin) {
    return null;
  }
  try {
    return await plugin.addListener("lanDiscovery", (event) => {
      const snapshot = normalizeSnapshot(event?.snapshot);
      if (snapshot) {
        listener(snapshot);
      }
    });
  } catch {
    return null;
  }
}
