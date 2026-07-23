import type {
  SpeechDependencyStatus,
  SpeechServiceConnectionSummary,
} from "./speechService";

export function describeSpeechRouteLabel(summary: SpeechServiceConnectionSummary) {
  switch (summary.route) {
    case "local":
      return "Provider on this machine";
    case "tunnel":
      return "Provider through tunnel";
    default:
      return summary.reachable ? "Provider route" : "This device";
  }
}

export function describeSpeechTranscriptionBackend(status: SpeechDependencyStatus | null) {
  if (!status) {
    return "Checking…";
  }
  if (status.transcription?.ready) {
    const engine = status.transcription.engine?.trim();
    const model = status.transcription.model?.trim();
    if (engine && model) {
      return `${engine} · ${model}`;
    }
    return engine || model || "Ready";
  }
  if (status.transcription?.configured) {
    return "Configured";
  }
  return "Setup needed";
}

export function describeSpeechSynthesisBackend(status: SpeechDependencyStatus | null) {
  if (!status) {
    return "Checking…";
  }
  if (status.synthesis?.ready) {
    const engine = status.synthesis.engine?.trim();
    const voice = status.synthesis.defaultVoice?.trim();
    if (engine && voice) {
      return `${engine} · ${voice}`;
    }
    return engine || voice || "Ready";
  }
  if (status.synthesis?.configured) {
    return "Configured";
  }
  return "Setup needed";
}

export function describeSpeechManagedRuntime(status: SpeechDependencyStatus | null) {
  const runtime = status?.dependencies?.managedRuntime;
  if (!runtime?.available) {
    return null;
  }
  const parts = [
    runtime.uvVersion?.trim() ? `uv ${runtime.uvVersion.trim()}` : null,
    runtime.pythonVersion?.trim() ? `Python ${runtime.pythonVersion.trim()}` : null,
    runtime.whisperVersion?.trim() ? `whisper ${runtime.whisperVersion.trim()}` : null,
  ].filter(Boolean);
  if (!parts.length) {
    return "Managed runtime installed";
  }
  return parts.join(" · ");
}

export function describeSpeechManagedRuntimeDetail(status: SpeechDependencyStatus | null) {
  const runtime = status?.dependencies?.managedRuntime;
  if (!runtime?.available) {
    return null;
  }
  const modelCacheStatus =
    runtime.modelCacheReady === true
      ? "Model cache ready for offline reuse"
      : "Model cache will populate on first successful warmup";
  const installerSource =
    runtime.uvInstallerSource?.trim() === "bundled"
      ? "Installer bundled"
      : runtime.uvInstallerSource?.trim() === "cached"
        ? "Installer cached"
        : runtime.uvInstallerSource?.trim() === "downloaded"
          ? "Installer downloaded"
          : null;
  const parts = [
    runtime.home?.trim() ? `Home ${runtime.home.trim()}` : null,
    runtime.cacheDir?.trim() ? `UV cache ${runtime.cacheDir.trim()}` : null,
    runtime.huggingfaceHubCache?.trim() ? `Model cache ${runtime.huggingfaceHubCache.trim()}` : null,
    modelCacheStatus,
    installerSource,
    runtime.imageioFfmpegVersion?.trim()
      ? `imageio-ffmpeg ${runtime.imageioFfmpegVersion.trim()}`
      : null,
    runtime.installedAt?.trim() ? `Installed ${runtime.installedAt.trim()}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}
