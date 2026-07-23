import {
  normalizeAgentHandle,
  type AssistantProviderDefinition,
  type BuiltInAssistantDefinition,
  type BuiltInAssistantDefinitionInput,
  type BuiltInAssistantHandle,
  type BuiltInAssistantMentionToken,
  type BuiltInAssistantPromptContextMetadata,
} from "@instafy/sdk/agents";
import type {
  CapabilityAvailability,
  CapabilityBinding,
  CapabilityDefinition,
  CapabilityId,
} from "@instafy/sdk/capabilities";
import { APPLICATION_FRONTEND_REGISTRATION_INPUTS } from "../features/applicationFrontendFeatureComposition";

export const LOCAL_ASSISTANT_PROVIDERS: AssistantProviderDefinition[] = Array.from(
  APPLICATION_FRONTEND_REGISTRATION_INPUTS.assistantProviders,
);

export const LOCAL_ASSISTANT_PROVIDER_REGISTRY =
  APPLICATION_FRONTEND_REGISTRATION_INPUTS.assistantProviderRegistry;

export const LOCAL_BUILT_IN_ASSISTANT_DEFINITIONS: readonly BuiltInAssistantDefinitionInput[] =
  APPLICATION_FRONTEND_REGISTRATION_INPUTS.builtInAssistantDefinitions;

export const LOCAL_BUILT_IN_ASSISTANT_REGISTRY =
  APPLICATION_FRONTEND_REGISTRATION_INPUTS.builtInAssistantRegistry;

const LOCAL_CAPABILITY_ASSISTANT_REGISTRY =
  APPLICATION_FRONTEND_REGISTRATION_INPUTS.capabilityAssistantRegistry;

export { normalizeAgentHandle };
export type {
  BuiltInAssistantDefinition,
  BuiltInAssistantDefinitionInput,
  BuiltInAssistantHandle,
  BuiltInAssistantMentionToken,
  BuiltInAssistantPromptContextEntry,
  BuiltInAssistantPromptContextMetadata,
} from "@instafy/sdk/agents";

export function listBuiltInAssistantDefinitions(): BuiltInAssistantDefinition[] {
  return LOCAL_BUILT_IN_ASSISTANT_REGISTRY.listDefinitions();
}

export function listLocalCapabilityAssistantDefinitions(): BuiltInAssistantDefinition[] {
  return LOCAL_CAPABILITY_ASSISTANT_REGISTRY.listDefinitions();
}

export function getDefaultAssistantDefinition(): BuiltInAssistantDefinition {
  return LOCAL_BUILT_IN_ASSISTANT_REGISTRY.getDefaultDefinition();
}

export function getDefaultAssistantHandle(): BuiltInAssistantHandle {
  return LOCAL_BUILT_IN_ASSISTANT_REGISTRY.getDefaultHandle();
}

export function getDefaultAssistantMentionToken(): BuiltInAssistantMentionToken {
  return LOCAL_BUILT_IN_ASSISTANT_REGISTRY.getDefaultMentionToken();
}

export function listBuiltInAssistantHandles(): BuiltInAssistantHandle[] {
  return LOCAL_BUILT_IN_ASSISTANT_REGISTRY.listHandles();
}

export function listBuiltInAssistantMentionTokens(): BuiltInAssistantMentionToken[] {
  return LOCAL_BUILT_IN_ASSISTANT_REGISTRY.listMentionTokens();
}

export function listBuiltInAssistantMentionAliases(): string[] {
  return LOCAL_BUILT_IN_ASSISTANT_REGISTRY.listMentionAliases();
}

export function getBuiltInAssistantMentionPatternSource(): string {
  return LOCAL_BUILT_IN_ASSISTANT_REGISTRY.getMentionPatternSource();
}

export function getBuiltInAssistantDefinition(
  raw: string | null | undefined,
): BuiltInAssistantDefinition | null {
  return LOCAL_BUILT_IN_ASSISTANT_REGISTRY.getDefinition(raw);
}

export function getBuiltInAssistantDisplayName(raw: string | null | undefined): string | null {
  return LOCAL_BUILT_IN_ASSISTANT_REGISTRY.getDisplayName(raw);
}

export function buildBuiltInAssistantPromptContext(
  raw: string | null | undefined,
  capabilityDefinitions: Iterable<CapabilityDefinition> = [],
  capabilityAvailability: Iterable<CapabilityAvailability> = [],
): string | null {
  return LOCAL_BUILT_IN_ASSISTANT_REGISTRY.buildPromptContext(
    raw,
    capabilityDefinitions,
    capabilityAvailability,
  );
}

export function buildBuiltInAssistantPromptContextMetadata(
  handles: Iterable<BuiltInAssistantHandle>,
  capabilityDefinitions: Iterable<CapabilityDefinition> = [],
  capabilityAvailability: Iterable<CapabilityAvailability> = [],
): BuiltInAssistantPromptContextMetadata | null {
  return LOCAL_BUILT_IN_ASSISTANT_REGISTRY.buildPromptContextMetadata(
    handles,
    capabilityDefinitions,
    capabilityAvailability,
  );
}

export function buildLocalCapabilityAssistantPromptContext(
  raw: string | null | undefined,
  capabilityDefinitions: Iterable<CapabilityDefinition> = [],
  capabilityAvailability: Iterable<CapabilityAvailability> = [],
): string | null {
  return LOCAL_CAPABILITY_ASSISTANT_REGISTRY.buildPromptContext(
    raw,
    capabilityDefinitions,
    capabilityAvailability,
  );
}

export function buildLocalCapabilityAssistantPromptContextMetadata(
  handles: Iterable<BuiltInAssistantHandle>,
  capabilityDefinitions: Iterable<CapabilityDefinition> = [],
  capabilityAvailability: Iterable<CapabilityAvailability> = [],
): BuiltInAssistantPromptContextMetadata | null {
  return LOCAL_CAPABILITY_ASSISTANT_REGISTRY.buildPromptContextMetadata(
    handles,
    capabilityDefinitions,
    capabilityAvailability,
  );
}

export function resolveBuiltInAssistantHandle(
  raw: string | null | undefined,
): BuiltInAssistantHandle | null {
  return LOCAL_BUILT_IN_ASSISTANT_REGISTRY.resolveHandle(raw);
}

export function isReservedBuiltInAgentHandle(raw: string | null | undefined): boolean {
  return LOCAL_BUILT_IN_ASSISTANT_REGISTRY.isReservedHandle(raw);
}

export function normalizeCustomAgentHandle(raw: string | null | undefined): string | null {
  return LOCAL_BUILT_IN_ASSISTANT_REGISTRY.normalizeCustomHandle(raw);
}

export function extractBuiltInAssistantMentionToken(
  rawToken: string | null | undefined,
): BuiltInAssistantMentionToken | null {
  return LOCAL_BUILT_IN_ASSISTANT_REGISTRY.extractMentionToken(rawToken);
}

export function resolveBuiltInAssistantMentionToken(
  rawToken: string | null | undefined,
): BuiltInAssistantMentionToken {
  return LOCAL_BUILT_IN_ASSISTANT_REGISTRY.resolveMentionToken(rawToken);
}

export function listBuiltInAssistantCapabilityBindings(
  raw: string | null | undefined,
): CapabilityBinding[] {
  return LOCAL_BUILT_IN_ASSISTANT_REGISTRY.listCapabilityBindings(raw);
}

export function builtInAssistantHasCapability(
  raw: string | null | undefined,
  capabilityId: CapabilityId,
): boolean {
  return LOCAL_BUILT_IN_ASSISTANT_REGISTRY.hasCapability(raw, capabilityId);
}

export function getLocalCapabilityAssistantDefinition(
  raw: string | null | undefined,
): BuiltInAssistantDefinition | null {
  return LOCAL_CAPABILITY_ASSISTANT_REGISTRY.getDefinition(raw);
}

export function resolveLocalCapabilityAssistantHandle(
  raw: string | null | undefined,
): BuiltInAssistantHandle | null {
  return LOCAL_CAPABILITY_ASSISTANT_REGISTRY.resolveHandle(raw);
}

export function localCapabilityAssistantHasCapability(
  raw: string | null | undefined,
  capabilityId: CapabilityId,
): boolean {
  return LOCAL_CAPABILITY_ASSISTANT_REGISTRY.hasCapability(raw, capabilityId);
}
