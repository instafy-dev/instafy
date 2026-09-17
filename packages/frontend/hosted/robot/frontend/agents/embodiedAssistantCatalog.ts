// Neutral bridge between the app assistant roster (src/assistants) and the
// robot/embodiment module (src/robot).
//
// src/robot must stay extractable, so it may not import src/assistants
// directly. Instead it reads the assistant roster through this injection
// point. src/assistants/localBuiltInAssistantCatalog.ts registers the full
// local-capability roster here at module evaluation; until that happens the
// catalog falls back to a registry built from the robot provider alone, which
// keeps src/robot usable in isolation (for example in unit tests).

import {
  createBuiltInAssistantRegistryFromProviders,
  type AssistantProviderDefinition,
  type BuiltInAssistantDefinition,
  type BuiltInAssistantHandle,
} from "@instafy/sdk/agents";
import type { CapabilityId } from "@instafy/sdk/capabilities";
import { LOCAL_ROBOT_ASSISTANT_PROVIDER } from "./robotAssistantProvider";

export type EmbodiedAssistantCatalog = {
  getDefaultAssistantHandle: () => BuiltInAssistantHandle;
  getAssistantDefinition: (raw: string | null | undefined) => BuiltInAssistantDefinition | null;
  listAssistantDefinitions: () => BuiltInAssistantDefinition[];
  assistantHasCapability: (
    raw: string | null | undefined,
    capabilityId: CapabilityId,
  ) => boolean;
  resolveAssistantHandle: (raw: string | null | undefined) => BuiltInAssistantHandle | null;
};

export function createEmbodiedAssistantCatalogFromProviders(
  providers: AssistantProviderDefinition[],
): EmbodiedAssistantCatalog {
  const registry = createBuiltInAssistantRegistryFromProviders(providers);
  return {
    getDefaultAssistantHandle: () => registry.getDefaultHandle(),
    getAssistantDefinition: (raw) => registry.getDefinition(raw),
    listAssistantDefinitions: () => registry.listDefinitions(),
    assistantHasCapability: (raw, capabilityId) => registry.hasCapability(raw, capabilityId),
    resolveAssistantHandle: (raw) => registry.resolveHandle(raw),
  };
}

let registeredCatalog: EmbodiedAssistantCatalog | null = null;
let fallbackCatalog: EmbodiedAssistantCatalog | null = null;

export function registerEmbodiedAssistantCatalog(catalog: EmbodiedAssistantCatalog) {
  registeredCatalog = catalog;
}

export function resetEmbodiedAssistantCatalog() {
  registeredCatalog = null;
}

export function getEmbodiedAssistantCatalog(): EmbodiedAssistantCatalog {
  if (registeredCatalog) {
    return registeredCatalog;
  }
  fallbackCatalog ??= createEmbodiedAssistantCatalogFromProviders([
    LOCAL_ROBOT_ASSISTANT_PROVIDER,
  ]);
  return fallbackCatalog;
}
