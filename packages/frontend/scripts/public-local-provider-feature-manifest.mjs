import { PUBLIC_CORE_LOCAL_PROVIDER_FEATURE_MODULE } from "./public-core-local-provider-feature-module.mjs";
import { SPEECH_PROVIDER_DEFAULT_ENABLED } from "./providers/speech-provider.mjs";

export const APPLICATION_LOCAL_PROVIDER_FEATURE_MODULES = Object.freeze([
  PUBLIC_CORE_LOCAL_PROVIDER_FEATURE_MODULE,
]);

export const APPLICATION_LOCAL_PROVIDER_DEFAULT_CONFIG = Object.freeze({
  defaultProviderId: "simulated-devices",
  providers: Object.freeze([
    Object.freeze({
      type: "simulated_devices",
      id: "simulated-devices",
      enabled: true,
    }),
    Object.freeze({ type: "camera", id: "camera", enabled: true }),
    Object.freeze({
      type: "speech",
      id: "speech",
      enabled: SPEECH_PROVIDER_DEFAULT_ENABLED,
    }),
  ]),
});

export const APPLICATION_LOCAL_PROVIDER_CONFIG_FILE =
  new URL("./local-provider-host.config.json", import.meta.url).pathname;
