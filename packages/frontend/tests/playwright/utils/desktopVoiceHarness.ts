import {
  launchDesktopVoicePublisher as launchSharedDesktopVoicePublisher,
  publishDesktopSpeechRoute as publishSharedDesktopSpeechRoute,
} from "../../../../../scripts/shared/desktop-voice-publisher.mjs";

export function isSkippableDesktopVoicePublisherError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    message.includes("Timed out waiting for Desktop voice tunnel publisher.") ||
    message.includes("Timed out waiting for desktop voice host report.") ||
    message.includes("Desktop app exited before voice tunnel publisher completed") ||
    message.includes("Desktop voice tunnel publisher did not return a healthy host report.") ||
    message.includes("Desktop voice tunnel publisher did not return a public URL.")
  );
}

export type DesktopVoicePublisherHandle = {
  projectId: string;
  publicUrl: string;
  lanBaseUrl: string | null;
  lanAuthToken: string | null;
  speechAuthToken: string | null;
  hostname: string | null;
  speechServiceHealthUrl: string;
  providerHostHealthUrl: string;
  stop: () => Promise<void>;
};

export type DesktopVoiceLanPublisherHandle = Omit<DesktopVoicePublisherHandle, "publicUrl"> & {
  publicUrl: string | null;
};

export async function launchDesktopVoicePublisher(input: {
  projectId: string;
  controllerUrl: string;
  controllerAccessToken: string;
  bootstrapClean?: boolean;
}): Promise<DesktopVoicePublisherHandle> {
  return (await launchSharedDesktopVoicePublisher({
    ...input,
    requireTunnel: true,
  })) as DesktopVoicePublisherHandle;
}

export async function launchDesktopVoiceLanPublisher(input: {
  projectId: string;
  controllerUrl: string;
  controllerAccessToken: string;
  bootstrapClean?: boolean;
}): Promise<DesktopVoiceLanPublisherHandle> {
  return (await launchSharedDesktopVoicePublisher({
    ...input,
    requireTunnel: false,
  })) as DesktopVoiceLanPublisherHandle;
}

export async function publishDesktopSpeechRoute(input: {
  controllerUrl: string;
  controllerAccessToken: string;
  projectId: string;
  publicUrl?: string | null;
  tunnelFallbackUrl?: string | null;
  lanBaseUrl?: string | null;
  lanAuthToken?: string | null;
  speechAuthToken?: string | null;
}) {
  await publishSharedDesktopSpeechRoute(input);
}
