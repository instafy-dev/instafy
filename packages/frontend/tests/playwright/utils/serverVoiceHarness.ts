import {
  launchServerVoicePublisher as launchSharedServerVoicePublisher,
  publishServerSpeechRoute as publishSharedServerSpeechRoute,
} from "../../../../../scripts/shared/server-voice-publisher.mjs";

export type ServerVoicePublisherHandle = {
  publicUrl: string;
  hostname: string | null;
  speechServiceHealthUrl: string;
  providerHostHealthUrl: string;
  stop: () => Promise<void>;
};

export async function launchServerVoicePublisher(): Promise<ServerVoicePublisherHandle> {
  return (await launchSharedServerVoicePublisher()) as ServerVoicePublisherHandle;
}

export async function publishServerSpeechRoute(input: {
  controllerUrl: string;
  controllerAccessToken: string;
  projectId: string;
  publicUrl: string;
}) {
  await publishSharedServerSpeechRoute(input);
}
