// Stable, trusted build-time integration surface for frontend feature modules.
// Keep this entrypoint composition-safe: application-bound runtime/UI modules
// belong in the sibling runtime, UI, voice, or controller entrypoints.
export {
  createLazyFrontendRouteElement,
} from "../features/frontendFeatureModule";
export type {
  FrontendFeatureComposition,
  FrontendFeatureContributions,
  FrontendFeatureModule,
  TrustedFrontendRouteContribution,
} from "../features/frontendFeatureModule";
export type { FrontendFeatureServices } from "../features/frontendFeatureServices";

export {
  getRegisteredNativeRuntimeProvider,
} from "../extensions/extensionCatalog";
export type { NativeRuntimeFamilyRegistration } from "../extensions/nativeRuntimeProviderTypes";
export {
  createNativeExtensionRegistration,
  renderStaticExtensionHealthSummary,
} from "../extensions/nativeExtensionRegistrationFactory";
export type {
  NativeExtensionRegistration,
  NativeExtensionSummary,
  NativeExtensionSummaryProps,
  NativeExtensionSurfaceCoverage,
} from "../extensions/nativeExtensionTypes";
export type {
  NativeCapabilityRuntimeEvent,
  NativeCapabilityRuntimeProbeResult,
  NativeCapabilityRuntimeRegistration,
  NativeCapabilityRuntimeSelection,
} from "../extensions/nativeCapabilityRuntimeTypes";

export {
  callLocalProviderTool,
  getLocalProviderForCapability,
  getLocalProviderSummary,
  LOCAL_PROVIDER_HOST_BASE_URL,
  postLocalProviderTransportProbe,
  readLocalProviderResource,
} from "../capabilities/localProviderHostClient";
export type { LocalProviderSummary } from "../capabilities/localProviderHostClient";
export type {
  LocalCapabilityArtifactRegistration,
  LocalCapabilityConversationMessage,
  LocalCapabilityRouteDefinition,
  LocalCapabilityRouteExecuteOptions,
  LocalCapabilityRouteMatcherOptions,
  LocalCapabilityStatusValue,
} from "../capabilities/localCapabilityContributions";
export type {
  ProjectProviderSelectedDevice,
} from "../capabilities/projectProviderAccess";
export {
  matchesExtensionProviderFamily,
} from "../providers/extensionProviderId";

export type {
  VisionClassifierRegistration,
  VisionClassifyResult,
  VisionObservation,
} from "../camera/visionTypes";
