import { Capacitor, registerPlugin } from "@capacitor/core";

interface NativeRuntimeConfigResult {
  disableNativeOta?: boolean;
}

interface NativeRuntimeConfigPlugin {
  getRuntimeConfig(): Promise<NativeRuntimeConfigResult>;
}

let nativeRuntimeConfigPlugin: NativeRuntimeConfigPlugin | null = null;

function getNativeRuntimeConfigPlugin(): NativeRuntimeConfigPlugin {
  nativeRuntimeConfigPlugin ??= registerPlugin<NativeRuntimeConfigPlugin>(
    "InstafyRuntimeConfig",
  );
  return nativeRuntimeConfigPlugin;
}

export function nativeRuntimeConfigDisablesOta(input: {
  platform: string;
  disableNativeOta?: boolean;
}): boolean {
  return input.platform === "android" && input.disableNativeOta === true;
}

/**
 * Debug Android binaries delete retained Live Update state in MainApplication.
 * Read their matching native policy before starting JavaScript OTA checks so
 * the stable channel cannot immediately download and reselect an old bundle.
 */
export async function nativeBuildDisablesOta(): Promise<boolean> {
  const platform = Capacitor.getPlatform();
  if (platform !== "android") {
    return false;
  }
  try {
    const config = await getNativeRuntimeConfigPlugin().getRuntimeConfig();
    return nativeRuntimeConfigDisablesOta({
      platform,
      disableNativeOta: config?.disableNativeOta,
    });
  } catch {
    // Older release binaries do not have the bridge. Preserve their current
    // OTA behavior when a newer web bundle runs on top of them.
    return false;
  }
}
