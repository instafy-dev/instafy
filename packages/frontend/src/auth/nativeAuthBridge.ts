import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

interface NativeAuthBridgeUrlEvent {
  url?: string | null;
}

interface NativeAuthBridgePlugin {
  addListener(
    eventName: "urlOpen",
    listenerFunc: (event: NativeAuthBridgeUrlEvent) => void,
  ): Promise<PluginListenerHandle>;
  consumePendingUrl(): Promise<NativeAuthBridgeUrlEvent>;
}

let nativeAuthBridgePlugin: NativeAuthBridgePlugin | null = null;
let nativeAuthBridgePluginInitialized = false;

function getNativeAuthBridgePlugin(): NativeAuthBridgePlugin | null {
  if (Capacitor.getPlatform() !== "android") {
    return null;
  }
  if (!nativeAuthBridgePluginInitialized) {
    nativeAuthBridgePlugin = registerPlugin<NativeAuthBridgePlugin>("InstafyAuthBridge");
    nativeAuthBridgePluginInitialized = true;
  }
  return nativeAuthBridgePlugin;
}

function normalizeUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function consumePendingNativeAuthBridgeUrl(): Promise<string | null> {
  const nativeAuthBridgePlugin = getNativeAuthBridgePlugin();
  if (!nativeAuthBridgePlugin) {
    return null;
  }
  try {
    const result = await nativeAuthBridgePlugin.consumePendingUrl();
    return normalizeUrl(result?.url);
  } catch {
    return null;
  }
}

export async function listenForNativeAuthBridgeUrl(
  listener: (url: string) => void,
): Promise<PluginListenerHandle | null> {
  const nativeAuthBridgePlugin = getNativeAuthBridgePlugin();
  if (!nativeAuthBridgePlugin) {
    return null;
  }
  try {
    return await nativeAuthBridgePlugin.addListener("urlOpen", (event) => {
      const url = normalizeUrl(event?.url);
      if (url) {
        listener(url);
      }
    });
  } catch {
    return null;
  }
}
