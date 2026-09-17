import {
  INSTAFY_FEATURE_MODULE_API_VERSION,
  defineInstafyFeatureModule,
} from "@instafy/sdk/feature-modules";
import { LOCAL_ROBOT_ASSISTANT_PROVIDER } from "./agents/robotAssistantProvider";
import type { NativeRuntimeFamilyRegistration } from "@instafy/frontend/feature-api";
import { KNOSH_PROVIDER_FAMILY } from "../provider/family.mjs";
import { KNOSH_NATIVE_EXTENSION_REGISTRATION } from "./extensions/knoshNativeExtensionRegistration";
import {
  LOCAL_ROBOT_CAPABILITY_EXECUTOR_PROVIDER,
  LOCAL_ROBOT_CAPABILITY_PROVIDER,
  type LocalRobotCapabilityExecutorContext,
} from "./robot";
import { ROBOT_EMBODIMENT_FEATURE_SERVICE_ID } from "./robot/robotCapabilityExecutorProvider";
import {
  createLazyFrontendRouteElement,
  type FrontendFeatureModule,
} from "@instafy/frontend/feature-api";
import type { FrontendFeatureServices } from "@instafy/frontend/feature-api";
import { getKnoshRuntimeAdapter } from "./robot/knoshRuntimeAdapter";
import { KNOSH_NATIVE_CAPABILITY_RUNTIME } from "./robot/nativeRobotRuntime";
import { KNOSH_LOCAL_CAPABILITY_ROUTE } from "./capabilities/knoshLocalCapabilityRoute";
import { KNOSH_LEARNING_ARTIFACT_REGISTRATION } from "./capabilities/knoshLearningArtifact";
import { KNOSH_SCRIPTED_VISION_CLASSIFIER } from "./vision/scriptedVisionClassifier";
import { KNOSH_ROBOT_LAB_ENABLED } from "./developmentFlags";
import { KnoshSkillRequestBridge } from "./extensions/KnoshSkillRequestBridge";

const robotLabRouteElement = KNOSH_ROBOT_LAB_ENABLED
  ? createLazyFrontendRouteElement(
      () => import("./screens/routes/RobotLabRoute"),
    )
  : null;
const runtimeRouteElement = createLazyFrontendRouteElement(
  () => import("./screens/routes/KnoshRuntimeRoute"),
);

const KNOSH_NATIVE_RUNTIME_FAMILY: NativeRuntimeFamilyRegistration = {
  familyId: KNOSH_PROVIDER_FAMILY.id,
  capabilityIds: KNOSH_PROVIDER_FAMILY.capabilityIds,
  supportsOnClient(platform) {
    return (
      platform === "android" ||
      platform === "ios" ||
      getKnoshRuntimeAdapter(platform) !== null
    );
  },
  async resolveCurrentProvider(providerId) {
    const provider = KNOSH_PROVIDER_FAMILY.extension?.nativeRuntimeProvider;
    if (!provider) {
      return null;
    }
    return providerId === provider.id
      ? provider
      : {
          ...provider,
          id: providerId,
        };
  },
};

// The complete Knosh-owned frontend slice is selected only by Instafy's
// excluded private composition manifest. Public builds never resolve this
// repository and retain an empty private-feature composition.
export const KNOSH_FRONTEND_FEATURE_MODULE: FrontendFeatureModule =
  defineInstafyFeatureModule({
    apiVersion: INSTAFY_FEATURE_MODULE_API_VERSION,
    id: "knosh.frontend",
    capabilityAssistantProviders: [LOCAL_ROBOT_ASSISTANT_PROVIDER],
    capabilityProviders: [LOCAL_ROBOT_CAPABILITY_PROVIDER],
    executorProviders: [
      {
        id: LOCAL_ROBOT_CAPABILITY_EXECUTOR_PROVIDER.id,
        title: LOCAL_ROBOT_CAPABILITY_EXECUTOR_PROVIDER.title,
        description: LOCAL_ROBOT_CAPABILITY_EXECUTOR_PROVIDER.description,
        createExecutors(services: FrontendFeatureServices) {
          return LOCAL_ROBOT_CAPABILITY_EXECUTOR_PROVIDER.createExecutors({
            robotEmbodiment:
              services.get<LocalRobotCapabilityExecutorContext["robotEmbodiment"]>(
                ROBOT_EMBODIMENT_FEATURE_SERVICE_ID,
              ) ?? null,
          });
        },
      },
    ],
    routes: [
      ...(KNOSH_ROBOT_LAB_ENABLED && robotLabRouteElement
        ? [{
            id: "knosh.robot-lab",
            path: "robot-lab",
            element: robotLabRouteElement,
          }]
        : []),
      {
        id: "knosh.runtime",
        path: "knosh-runtime",
        element: runtimeRouteElement,
      },
    ],
    studioRuntimeBridges: [
      {
        id: "knosh.skill-request-bridge",
        component: KnoshSkillRequestBridge,
      },
    ],
    nativeExtensionRegistrations: [KNOSH_NATIVE_EXTENSION_REGISTRATION],
    nativeRuntimeFamilyRegistrations: [KNOSH_NATIVE_RUNTIME_FAMILY],
    nativeCapabilityRuntimeRegistrations: [KNOSH_NATIVE_CAPABILITY_RUNTIME],
    localCapabilityRoutes: [KNOSH_LOCAL_CAPABILITY_ROUTE],
    localCapabilityArtifactRegistrations: [KNOSH_LEARNING_ARTIFACT_REGISTRATION],
    visionClassifierRegistrations: [KNOSH_SCRIPTED_VISION_CLASSIFIER],
  });
