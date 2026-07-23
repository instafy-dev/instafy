import {
  localCapabilityAssistantHasCapability,
  resolveLocalCapabilityAssistantHandle,
  type BuiltInAssistantHandle,
} from "../assistants/localBuiltInAssistantCatalog";
import {
  createCapabilityRegistry,
  type CapabilityId,
} from "@instafy/sdk/capabilities";
import {
  LOCAL_CAPABILITY_DEFINITIONS,
} from "./localCapabilityProviders";

export {
  LOCAL_CAPABILITY_DEFINITIONS,
  LOCAL_CAPABILITY_PROVIDER_REGISTRY,
  LOCAL_CAPABILITY_PROVIDERS,
} from "./localCapabilityProviders";

const LOCAL_CAPABILITY_REGISTRY = createCapabilityRegistry(LOCAL_CAPABILITY_DEFINITIONS);

export function resolveSingleLocalBuiltInCapabilityHandle(
  targetHandles: Iterable<string>,
  capabilityId: CapabilityId,
): BuiltInAssistantHandle | null {
  const handles = Array.from(targetHandles);
  if (handles.length !== 1) {
    return null;
  }

  const normalizedCapabilityId = capabilityId.trim();
  if (!normalizedCapabilityId || !LOCAL_CAPABILITY_REGISTRY.has(normalizedCapabilityId)) {
    return null;
  }

  const handle = resolveLocalCapabilityAssistantHandle(handles[0] ?? "");
  if (!handle) {
    return null;
  }

  return localCapabilityAssistantHasCapability(handle, normalizedCapabilityId) ? handle : null;
}
