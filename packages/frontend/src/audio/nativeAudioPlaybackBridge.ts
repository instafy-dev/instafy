import { Capacitor, registerPlugin } from "@capacitor/core";

type NativeAudioPlaybackPlugin = {
  play(options: { audioUrl?: string; audioDataUrl?: string }): Promise<void>;
};

const NATIVE_AUDIO_PLAYBACK_TIMEOUT_MS = 10_000;

let nativeAudioPlaybackPlugin: NativeAudioPlaybackPlugin | null = null;
let nativeAudioPlaybackPluginInitialized = false;

function getNativeAudioPlaybackPlugin(): NativeAudioPlaybackPlugin | null {
  if (Capacitor.getPlatform() !== "android") {
    return null;
  }
  if (!nativeAudioPlaybackPluginInitialized) {
    nativeAudioPlaybackPlugin = registerPlugin<NativeAudioPlaybackPlugin>("InstafyAudioPlaybackBridge");
    nativeAudioPlaybackPluginInitialized = true;
  }
  return nativeAudioPlaybackPlugin;
}

export async function playNativeHostAudio(options: {
  audioUrl?: string;
  audioDataUrl?: string;
}): Promise<boolean> {
  const plugin = getNativeAudioPlaybackPlugin();
  if (!plugin) {
    return false;
  }
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      plugin.play({
        audioUrl: typeof options.audioUrl === "string" && options.audioUrl.trim() ? options.audioUrl.trim() : undefined,
        audioDataUrl:
          typeof options.audioDataUrl === "string" && options.audioDataUrl.trim()
            ? options.audioDataUrl.trim()
            : undefined,
      }),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Native audio playback timed out after ${NATIVE_AUDIO_PLAYBACK_TIMEOUT_MS}ms.`));
        }, NATIVE_AUDIO_PLAYBACK_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
