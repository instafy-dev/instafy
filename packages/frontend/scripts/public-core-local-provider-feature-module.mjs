import {
  INSTAFY_FEATURE_MODULE_API_VERSION,
  defineInstafyFeatureModule,
} from "@instafy/sdk/feature-modules";
import { createCameraProviderRegistration } from "./providers/camera-provider.mjs";
import { createLocalDeviceToggleProviderRegistration } from "./providers/local-device-toggle-provider.mjs";
import { createSpeechProviderRegistration } from "./providers/speech-provider.mjs";

export const PUBLIC_CORE_LOCAL_PROVIDER_FEATURE_MODULE = defineInstafyFeatureModule({
  apiVersion: INSTAFY_FEATURE_MODULE_API_VERSION,
  id: "instafy.public-core.providers",
  providerFactories: [
    { type: "camera", create: createCameraProviderRegistration },
    { type: "speech", create: createSpeechProviderRegistration },
    { type: "simulated_devices", create: createLocalDeviceToggleProviderRegistration },
  ],
});
