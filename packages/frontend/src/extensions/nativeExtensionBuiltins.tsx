import type { NativeExtensionRegistration } from "./nativeExtensionTypes";
import { APPLICATION_FRONTEND_REGISTRATION_INPUTS } from "../features/applicationFrontendFeatureComposition";

export const BUILT_IN_NATIVE_EXTENSION_REGISTRATIONS: Record<
  string,
  NativeExtensionRegistration
> = APPLICATION_FRONTEND_REGISTRATION_INPUTS.nativeExtensionRegistrations;
