#!/usr/bin/env node

import { startLocalProviderHost } from "./local-provider-host-server.mjs";
import { createSpeechProviderRegistration } from "./providers/speech-provider.mjs";

const port = Number(process.env.LOCAL_PROVIDER_HOST_PORT || process.env.ROBOT_BRIDGE_PORT || 8797);
const host = process.env.LOCAL_PROVIDER_HOST_HOST || process.env.ROBOT_BRIDGE_HOST || "0.0.0.0";

startLocalProviderHost({
  providers: [createSpeechProviderRegistration()],
  defaultProviderId: "speech",
  host,
  port,
  serviceName: "server-speech-provider-host",
});
