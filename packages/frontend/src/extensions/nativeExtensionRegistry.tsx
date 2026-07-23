import type { LocalProviderSummary } from "../capabilities/localProviderHostClient";
import { resolveExtensionDefinition } from "./extensionCatalog";
import { BUILT_IN_NATIVE_EXTENSION_REGISTRATIONS } from "./nativeExtensionBuiltins";

export type {
  NativeExtensionEntrySource,
  NativeExtensionRegistration,
  NativeExtensionSetupPanelProps,
  NativeExtensionStatusValue,
  NativeExtensionSummary,
  NativeExtensionSummaryProps,
  NativeExtensionSummaryTone,
} from "./nativeExtensionTypes";

export function resolveNativeExtensionRegistration(input: {
  provider?: LocalProviderSummary | null;
  capabilityIds?: Iterable<string> | null;
  integrationProviderId?: string | null;
}) {
  const definition = resolveExtensionDefinition(input);
  return BUILT_IN_NATIVE_EXTENSION_REGISTRATIONS[definition.familyId] ?? null;
}
