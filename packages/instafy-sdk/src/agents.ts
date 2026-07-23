import {
  createCapabilityAvailabilityRegistry,
  formatCapabilityPromptContext,
  hasEnabledCapability,
  listEnabledCapabilityIds,
  type CapabilityAvailability,
  type CapabilityBinding,
  type CapabilityDefinition,
  type CapabilityId,
} from "./capabilities";

export const AGENT_HANDLE_REGEX = /^[a-z0-9][a-z0-9_-]{0,19}$/;

export type BuiltInAssistantDefinitionInput = {
  handle: string;
  mentionToken?: string;
  displayName?: string;
  aliases?: readonly string[];
  capabilityBindings?: readonly CapabilityBinding[];
  summary: string;
  promptSummary?: string;
  promptInstructions?: readonly string[];
};

export type BuiltInAssistantDefinition = {
  handle: string;
  mentionToken: string;
  displayName: string;
  aliases: string[];
  capabilityBindings: CapabilityBinding[];
  summary: string;
  promptSummary: string;
  promptInstructions: string[];
};

export type BuiltInAssistantHandle = BuiltInAssistantDefinition["handle"];
export type BuiltInAssistantMentionToken = BuiltInAssistantDefinition["mentionToken"];

export interface AssistantProviderDefinition {
  id: string;
  title: string;
  description: string;
  assistants: BuiltInAssistantDefinitionInput[];
}

export interface BuiltInAssistantPromptContextEntry {
  handle: BuiltInAssistantHandle;
  mentionToken: string;
  displayName: string;
  enabledCapabilityIds: string[];
  promptContext: string;
}

export interface BuiltInAssistantPromptContextMetadata {
  assistants: BuiltInAssistantPromptContextEntry[];
}

export interface BuiltInAssistantRegistry {
  listDefinitions(): BuiltInAssistantDefinition[];
  getDefaultDefinition(): BuiltInAssistantDefinition;
  getDefaultHandle(): BuiltInAssistantHandle;
  getDefaultMentionToken(): BuiltInAssistantMentionToken;
  listHandles(): BuiltInAssistantHandle[];
  listMentionTokens(): BuiltInAssistantMentionToken[];
  listMentionAliases(): string[];
  getMentionPatternSource(): string;
  getDefinition(raw: string | null | undefined): BuiltInAssistantDefinition | null;
  getDisplayName(raw: string | null | undefined): string | null;
  buildPromptContext(
    raw: string | null | undefined,
    capabilityDefinitions?: Iterable<CapabilityDefinition>,
    capabilityAvailability?: Iterable<CapabilityAvailability>,
  ): string | null;
  buildPromptContextMetadata(
    handles: Iterable<BuiltInAssistantHandle>,
    capabilityDefinitions?: Iterable<CapabilityDefinition>,
    capabilityAvailability?: Iterable<CapabilityAvailability>,
  ): BuiltInAssistantPromptContextMetadata | null;
  resolveHandle(raw: string | null | undefined): BuiltInAssistantHandle | null;
  isReservedHandle(raw: string | null | undefined): boolean;
  normalizeCustomHandle(raw: string | null | undefined): string | null;
  extractMentionToken(rawToken: string | null | undefined): BuiltInAssistantMentionToken | null;
  resolveMentionToken(rawToken: string | null | undefined): BuiltInAssistantMentionToken;
  listCapabilityBindings(raw: string | null | undefined): CapabilityBinding[];
  hasCapability(raw: string | null | undefined, capabilityId: CapabilityId): boolean;
}

function normalizeAssistantProviderDefinition(
  provider: AssistantProviderDefinition,
): AssistantProviderDefinition | null {
  const id = provider.id.trim();
  const title = provider.title.trim();
  const description = provider.description.trim();
  const assistants = provider.assistants.filter((definition) =>
    typeof definition.handle === "string" && definition.handle.trim().length > 0,
  );
  if (!id || !title || !description || assistants.length === 0) {
    return null;
  }
  return {
    id,
    title,
    description,
    assistants,
  };
}

function cloneCapabilityBindings(bindings: readonly CapabilityBinding[]): CapabilityBinding[] {
  return bindings.map((binding) => ({ ...binding }));
}

function cloneBuiltInAssistantDefinition(
  definition: BuiltInAssistantDefinition,
): BuiltInAssistantDefinition {
  return {
    ...definition,
    aliases: [...definition.aliases],
    capabilityBindings: cloneCapabilityBindings(definition.capabilityBindings),
    promptInstructions: [...definition.promptInstructions],
  };
}

export function normalizeAgentHandle(raw: string | null | undefined): string | null {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) {
    return null;
  }
  const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  const normalized = withoutAt.trim().toLowerCase();
  if (!normalized || !AGENT_HANDLE_REGEX.test(normalized)) {
    return null;
  }
  return normalized;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatDisplayName(handle: string) {
  return handle.length > 0 ? `${handle.charAt(0).toUpperCase()}${handle.slice(1)}` : handle;
}

function normalizeAliases(handle: string, aliases: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalizedAliases: string[] = [];
  for (const alias of aliases) {
    const normalized = normalizeAgentHandle(alias);
    if (!normalized || normalized === handle || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    normalizedAliases.push(normalized);
  }
  return normalizedAliases;
}

function normalizeBuiltInAssistantDefinition(
  input: BuiltInAssistantDefinitionInput,
): BuiltInAssistantDefinition {
  const handle = normalizeAgentHandle(input.handle);
  if (!handle) {
    throw new Error(`Invalid built-in assistant handle: ${input.handle}`);
  }

  const mentionToken = typeof input.mentionToken === "string" && input.mentionToken.trim().length > 0
    ? input.mentionToken.trim()
    : `@${handle}`;
  const displayName = typeof input.displayName === "string" && input.displayName.trim().length > 0
    ? input.displayName.trim()
    : formatDisplayName(handle);
  const aliases = normalizeAliases(handle, input.aliases ?? []);
  const capabilityBindings = cloneCapabilityBindings(input.capabilityBindings ?? []);
  const summary = input.summary.trim();
  const promptSummary =
    typeof input.promptSummary === "string" && input.promptSummary.trim().length > 0
      ? input.promptSummary.trim()
      : summary;
  const promptInstructions = (input.promptInstructions ?? []).map((line) => line.trim()).filter(Boolean);

  return {
    handle,
    mentionToken,
    displayName,
    aliases,
    capabilityBindings,
    summary,
    promptSummary,
    promptInstructions,
  };
}

export function createBuiltInAssistantRegistry(
  definitionsInput: readonly BuiltInAssistantDefinitionInput[],
): BuiltInAssistantRegistry {
  if (definitionsInput.length === 0) {
    throw new Error("At least one built-in assistant definition is required.");
  }

  const definitions = definitionsInput.map(normalizeBuiltInAssistantDefinition);
  const defaultDefinition = definitions[0];
  if (!defaultDefinition) {
    throw new Error("A default built-in assistant definition is required.");
  }

  const definitionByHandle = new Map<string, BuiltInAssistantDefinition>();
  const handleByAlias = new Map<string, BuiltInAssistantHandle>();
  const mentionAliases = new Set<string>();

  for (const definition of definitions) {
    if (definitionByHandle.has(definition.handle)) {
      throw new Error(`Duplicate built-in assistant handle: ${definition.handle}`);
    }
    definitionByHandle.set(definition.handle, definition);
    handleByAlias.set(definition.handle, definition.handle);
    mentionAliases.add(definition.mentionToken);
    for (const alias of definition.aliases) {
      if (!handleByAlias.has(alias)) {
        handleByAlias.set(alias, definition.handle);
      }
      mentionAliases.add(`@${alias}`);
    }
  }

  const mentionPatternSource = Array.from(mentionAliases)
    .map((token) => escapeRegExp(token))
    .join("|");

  function resolveHandle(raw: string | null | undefined): BuiltInAssistantHandle | null {
    const normalized = normalizeAgentHandle(raw);
    if (!normalized) {
      return null;
    }
    return handleByAlias.get(normalized) ?? null;
  }

  function getDefinition(raw: string | null | undefined): BuiltInAssistantDefinition | null {
    const handle = resolveHandle(raw);
    if (!handle) {
      return null;
    }
    const definition = definitionByHandle.get(handle);
    return definition ? cloneBuiltInAssistantDefinition(definition) : null;
  }

  function buildPromptContext(
    raw: string | null | undefined,
    capabilityDefinitions: Iterable<CapabilityDefinition> = [],
    capabilityAvailability: Iterable<CapabilityAvailability> = [],
  ): string | null {
    const definition = getDefinition(raw);
    if (!definition) {
      return null;
    }

    const enabledCapabilityIds = new Set(listEnabledCapabilityIds(definition.capabilityBindings));
    const capabilitySections: string[] = [];
    const availabilityRegistry = createCapabilityAvailabilityRegistry(capabilityAvailability);
    for (const capabilityDefinition of capabilityDefinitions) {
      if (!enabledCapabilityIds.has(capabilityDefinition.id.trim())) {
        continue;
      }
      capabilitySections.push(formatCapabilityPromptContext(capabilityDefinition));
    }
    const availabilitySections = Array.from(availabilityRegistry.values())
      .filter((entry) => enabledCapabilityIds.has(entry.capabilityId))
      .map((entry) => {
        const resources =
          entry.resources && entry.resources.length > 0
            ? ` Resources: ${entry.resources.join(", ")}.`
            : "";
        return `- ${entry.capabilityId}: ${entry.status} — ${entry.summary}.${resources}`;
      });

    const sections = [
      `Assistant: ${definition.displayName} (${definition.mentionToken})`,
      definition.promptSummary,
      definition.promptInstructions.length > 0
        ? `Operating rules:\n${definition.promptInstructions.map((line) => `- ${line}`).join("\n")}`
        : null,
      capabilitySections.length > 0
        ? `Enabled capabilities:\n${capabilitySections.map((section) => section.replace(/^/gm, "  ")).join("\n\n")}`
        : null,
      availabilitySections.length > 0
        ? `Current capability availability:\n${availabilitySections.join("\n")}`
        : null,
    ].filter((section): section is string => Boolean(section && section.trim().length > 0));

    return sections.join("\n\n");
  }

  function buildPromptContextMetadata(
    handles: Iterable<BuiltInAssistantHandle>,
    capabilityDefinitions: Iterable<CapabilityDefinition> = [],
    capabilityAvailability: Iterable<CapabilityAvailability> = [],
  ): BuiltInAssistantPromptContextMetadata | null {
    const seen = new Set<string>();
    const assistants: BuiltInAssistantPromptContextEntry[] = [];

    for (const handle of handles) {
      const normalized = resolveHandle(handle);
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);

      const definition = getDefinition(normalized);
      if (!definition) {
        continue;
      }

      const enabledCapabilityIds = listEnabledCapabilityIds(definition.capabilityBindings);
      if (enabledCapabilityIds.length === 0) {
        continue;
      }

      const promptContext = buildPromptContext(
        normalized,
        capabilityDefinitions,
        capabilityAvailability,
      );
      if (!promptContext) {
        continue;
      }

      assistants.push({
        handle: normalized,
        mentionToken: definition.mentionToken,
        displayName: definition.displayName,
        enabledCapabilityIds,
        promptContext,
      });
    }

    return assistants.length > 0 ? { assistants } : null;
  }

  function extractMentionToken(rawToken: string | null | undefined): BuiltInAssistantMentionToken | null {
    const handle = resolveHandle(rawToken);
    if (!handle) {
      return null;
    }
    return definitionByHandle.get(handle)?.mentionToken ?? null;
  }

  function listCapabilityBindings(raw: string | null | undefined): CapabilityBinding[] {
    return getDefinition(raw)?.capabilityBindings ?? [];
  }

  function hasCapability(raw: string | null | undefined, capabilityId: CapabilityId): boolean {
    return hasEnabledCapability(listCapabilityBindings(raw), capabilityId);
  }

  return {
    listDefinitions() {
      return definitions.map(cloneBuiltInAssistantDefinition);
    },
    getDefaultDefinition() {
      return cloneBuiltInAssistantDefinition(defaultDefinition);
    },
    getDefaultHandle() {
      return defaultDefinition.handle;
    },
    getDefaultMentionToken() {
      return defaultDefinition.mentionToken;
    },
    listHandles() {
      return definitions.map((definition) => definition.handle);
    },
    listMentionTokens() {
      return definitions.map((definition) => definition.mentionToken);
    },
    listMentionAliases() {
      return Array.from(mentionAliases);
    },
    getMentionPatternSource() {
      return mentionPatternSource;
    },
    getDefinition,
    getDisplayName(raw) {
      return getDefinition(raw)?.displayName ?? null;
    },
    buildPromptContext,
    buildPromptContextMetadata,
    resolveHandle,
    isReservedHandle(raw) {
      return resolveHandle(raw) !== null;
    },
    normalizeCustomHandle(raw) {
      const normalized = normalizeAgentHandle(raw);
      if (!normalized || resolveHandle(normalized)) {
        return null;
      }
      return normalized;
    },
    extractMentionToken,
    resolveMentionToken(rawToken) {
      return extractMentionToken(rawToken) ?? defaultDefinition.mentionToken;
    },
    listCapabilityBindings,
    hasCapability,
  };
}

export function createAssistantProviderRegistry(
  providers: Iterable<AssistantProviderDefinition>,
): Map<string, AssistantProviderDefinition> {
  const registry = new Map<string, AssistantProviderDefinition>();
  for (const provider of providers) {
    const normalized = normalizeAssistantProviderDefinition(provider);
    if (!normalized || registry.has(normalized.id)) {
      continue;
    }
    registry.set(normalized.id, normalized);
  }
  return registry;
}

export function listBuiltInAssistantDefinitionsFromProviders(
  providers: Iterable<AssistantProviderDefinition>,
): BuiltInAssistantDefinitionInput[] {
  const definitions: BuiltInAssistantDefinitionInput[] = [];
  const seen = new Set<string>();
  for (const provider of createAssistantProviderRegistry(providers).values()) {
    for (const definition of provider.assistants) {
      const normalizedHandle = normalizeAgentHandle(definition.handle);
      if (!normalizedHandle || seen.has(normalizedHandle)) {
        continue;
      }
      seen.add(normalizedHandle);
      definitions.push(definition);
    }
  }
  return definitions;
}

export function createBuiltInAssistantRegistryFromProviders(
  providers: Iterable<AssistantProviderDefinition>,
): BuiltInAssistantRegistry {
  return createBuiltInAssistantRegistry(listBuiltInAssistantDefinitionsFromProviders(providers));
}
