import {
  INSTAFY_FEATURE_MODULE_API_VERSION,
  defineInstafyFeatureModule,
} from "@instafy/sdk/feature-modules";
import { LOCAL_CORE_ASSISTANT_PROVIDER } from "../assistants/coreAssistantProvider";
import { LOCAL_CAMERA_CAPABILITY_PROVIDER } from "../camera/cameraCapabilityProvider";
import { LOCAL_DEVICE_TOGGLE_CAPABILITY_PROVIDER } from "../devices/deviceToggleCapabilityProvider";
import {
  LOCAL_DEVICE_TOGGLE_CAPABILITY_EXECUTOR_PROVIDER,
  type LocalDeviceToggleCapabilityExecutorContext,
} from "../devices/deviceToggleCapabilityExecutorProvider";
import { CAMERA_NATIVE_EXTENSION_REGISTRATION } from "../extensions/nativeExtensions/cameraNativeExtensionRegistration";
import type { FrontendFeatureModule } from "./frontendFeatureModule";
import type { FrontendFeatureServices } from "./frontendFeatureServices";

export const DEVICE_TOGGLE_FEATURE_SERVICE_ID = "instafy.device-toggle";

export const PUBLIC_CORE_FRONTEND_FEATURE_MODULE: FrontendFeatureModule =
  defineInstafyFeatureModule({
    apiVersion: INSTAFY_FEATURE_MODULE_API_VERSION,
    id: "instafy.public-core",
    assistantProviders: [LOCAL_CORE_ASSISTANT_PROVIDER],
    capabilityAssistantProviders: [LOCAL_CORE_ASSISTANT_PROVIDER],
    capabilityProviders: [
      LOCAL_CAMERA_CAPABILITY_PROVIDER,
      LOCAL_DEVICE_TOGGLE_CAPABILITY_PROVIDER,
    ],
    executorProviders: [
      {
        id: LOCAL_DEVICE_TOGGLE_CAPABILITY_EXECUTOR_PROVIDER.id,
        title: LOCAL_DEVICE_TOGGLE_CAPABILITY_EXECUTOR_PROVIDER.title,
        description: LOCAL_DEVICE_TOGGLE_CAPABILITY_EXECUTOR_PROVIDER.description,
        createExecutors(services: FrontendFeatureServices) {
          return LOCAL_DEVICE_TOGGLE_CAPABILITY_EXECUTOR_PROVIDER.createExecutors({
            deviceToggle:
              services.get<LocalDeviceToggleCapabilityExecutorContext["deviceToggle"]>(
                DEVICE_TOGGLE_FEATURE_SERVICE_ID,
              ) ?? null,
          });
        },
      },
    ],
    nativeExtensionRegistrations: [CAMERA_NATIVE_EXTENSION_REGISTRATION],
  });
