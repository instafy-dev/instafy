export type CapabilityId = string;

export interface CapabilityActionDefinition {
  id: string;
  title: string;
  description: string;
}

export interface CapabilityPromptContext {
  summary?: string | null;
  instructions?: string[];
  constraints?: string[];
  examples?: string[];
}

export type CapabilityAvailabilityStatus =
  | "available"
  | "available_on_request"
  | "permission_required"
  | "not_paired"
  | "unavailable";

export interface CapabilityAvailability {
  capabilityId: CapabilityId;
  status: CapabilityAvailabilityStatus;
  summary: string;
  resources?: string[];
}

export interface CapabilityDefinition {
  id: CapabilityId;
  title: string;
  description: string;
  actions: CapabilityActionDefinition[];
  promptContext?: CapabilityPromptContext | null;
}

export interface CapabilityProviderDefinition {
  id: string;
  title: string;
  description: string;
  capabilities: CapabilityDefinition[];
}

export interface CapabilityBinding {
  capabilityId: CapabilityId;
  enabled: boolean;
  source: "system" | "project" | "integration" | "agent";
  metadata?: Record<string, unknown> | null;
}

export interface CapabilityInvocation<TInput = unknown> {
  capabilityId: CapabilityId;
  actionId: string;
  input: TInput;
  source?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface CapabilityExecutionSuccess<TResult = unknown> {
  ok: true;
  capabilityId: CapabilityId;
  actionId: string;
  value: TResult;
}

export interface CapabilityExecutionFailure {
  ok: false;
  capabilityId: CapabilityId;
  actionId: string;
  error: string;
  code?: string;
}

export type CapabilityExecutionResult<TResult = unknown> =
  | CapabilityExecutionSuccess<TResult>
  | CapabilityExecutionFailure;

export interface CapabilityExecutor<
  TInvocation extends CapabilityInvocation = CapabilityInvocation,
  TResult = unknown,
> {
  capabilityId: CapabilityId;
  execute(
    invocation: TInvocation,
  ): Promise<CapabilityExecutionResult<TResult>> | CapabilityExecutionResult<TResult>;
}

export type AnyCapabilityExecutor = CapabilityExecutor<CapabilityInvocation, unknown>;

export interface CapabilityExecutorProviderDefinition<TContext = void> {
  id: string;
  title: string;
  description: string;
  createExecutors: (context: TContext) => Iterable<AnyCapabilityExecutor>;
}

function normalizePromptContextLines(lines: string[] | null | undefined): string[] {
  return (lines ?? [])
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function normalizeCapabilityPromptContext(
  context: CapabilityPromptContext | null | undefined,
): CapabilityPromptContext | null {
  if (!context) {
    return null;
  }
  const summary = (context.summary ?? "").trim();
  const instructions = normalizePromptContextLines(context.instructions);
  const constraints = normalizePromptContextLines(context.constraints);
  const examples = normalizePromptContextLines(context.examples);
  if (!summary && instructions.length === 0 && constraints.length === 0 && examples.length === 0) {
    return null;
  }
  return {
    summary: summary || null,
    instructions,
    constraints,
    examples,
  };
}

function normalizeCapabilityAvailability(
  availability: CapabilityAvailability,
): CapabilityAvailability | null {
  const capabilityId = availability.capabilityId.trim();
  const summary = availability.summary.trim();
  const resources = normalizePromptContextLines(availability.resources);
  if (!capabilityId || !summary) {
    return null;
  }
  return {
    capabilityId,
    status: availability.status,
    summary,
    resources,
  };
}

function normalizeCapabilityProviderDefinition(
  provider: CapabilityProviderDefinition,
): CapabilityProviderDefinition | null {
  const id = provider.id.trim();
  const title = provider.title.trim();
  const description = provider.description.trim();
  if (!id || !title || !description) {
    return null;
  }
  const capabilities = Array.from(createCapabilityRegistry(provider.capabilities).values());
  if (capabilities.length === 0) {
    return null;
  }
  return {
    id,
    title,
    description,
    capabilities,
  };
}

function normalizeCapabilityExecutorProviderDefinition<TContext>(
  provider: CapabilityExecutorProviderDefinition<TContext>,
): CapabilityExecutorProviderDefinition<TContext> | null {
  const id = provider.id.trim();
  const title = provider.title.trim();
  const description = provider.description.trim();
  if (!id || !title || !description) {
    return null;
  }
  return {
    id,
    title,
    description,
    createExecutors: provider.createExecutors,
  };
}

function formatPromptContextLines(
  title: string,
  lines: string[] | null | undefined,
): string | null {
  const normalized = normalizePromptContextLines(lines);
  if (normalized.length === 0) {
    return null;
  }
  return `${title}:\n${normalized.map((line) => `- ${line}`).join("\n")}`;
}

export function createCapabilityRegistry(
  definitions: Iterable<CapabilityDefinition>,
): Map<CapabilityId, CapabilityDefinition> {
  const registry = new Map<CapabilityId, CapabilityDefinition>();
  for (const definition of definitions) {
    const normalizedId = definition.id.trim();
    if (!normalizedId || registry.has(normalizedId)) {
      continue;
    }
    registry.set(normalizedId, {
      ...definition,
      id: normalizedId,
      actions: definition.actions.map((action) => ({
        ...action,
        id: action.id.trim(),
      })),
      promptContext: normalizeCapabilityPromptContext(definition.promptContext),
    });
  }
  return registry;
}

export function createCapabilityAvailabilityRegistry(
  availabilityEntries: Iterable<CapabilityAvailability>,
): Map<CapabilityId, CapabilityAvailability> {
  const registry = new Map<CapabilityId, CapabilityAvailability>();
  for (const entry of availabilityEntries) {
    const normalized = normalizeCapabilityAvailability(entry);
    if (!normalized || registry.has(normalized.capabilityId)) {
      continue;
    }
    registry.set(normalized.capabilityId, normalized);
  }
  return registry;
}

export function createCapabilityProviderRegistry(
  providers: Iterable<CapabilityProviderDefinition>,
): Map<string, CapabilityProviderDefinition> {
  const registry = new Map<string, CapabilityProviderDefinition>();
  for (const provider of providers) {
    const normalized = normalizeCapabilityProviderDefinition(provider);
    if (!normalized || registry.has(normalized.id)) {
      continue;
    }
    registry.set(normalized.id, normalized);
  }
  return registry;
}

export function listCapabilityDefinitionsFromProviders(
  providers: Iterable<CapabilityProviderDefinition>,
): CapabilityDefinition[] {
  const definitions: CapabilityDefinition[] = [];
  const seen = new Set<CapabilityId>();
  for (const provider of createCapabilityProviderRegistry(providers).values()) {
    for (const definition of provider.capabilities) {
      const normalizedId = definition.id.trim();
      if (!normalizedId || seen.has(normalizedId)) {
        continue;
      }
      seen.add(normalizedId);
      definitions.push(definition);
    }
  }
  return definitions;
}

export function formatCapabilityPromptContext(
  definition: CapabilityDefinition,
): string {
  const promptContext = normalizeCapabilityPromptContext(definition.promptContext);
  const sections = [
    `${definition.title} (${definition.id})`,
    (promptContext?.summary ?? definition.description)?.trim() ?? definition.description,
    definition.actions.length > 0
      ? `Actions: ${definition.actions.map((action) => action.id.trim()).filter(Boolean).join(", ")}`
      : null,
    formatPromptContextLines("Instructions", promptContext?.instructions),
    formatPromptContextLines("Constraints", promptContext?.constraints),
    formatPromptContextLines("Examples", promptContext?.examples),
  ].filter((section): section is string => Boolean(section && section.trim().length > 0));

  return sections.join("\n");
}

export function formatCapabilityAvailability(
  availability: CapabilityAvailability,
): string {
  const normalized = normalizeCapabilityAvailability(availability);
  if (!normalized) {
    return "";
  }
  const resourceLine =
    normalized.resources && normalized.resources.length > 0
      ? ` Resources: ${normalized.resources.join(", ")}.`
      : "";
  return `${normalized.capabilityId}: ${normalized.status} - ${normalized.summary}.${resourceLine}`.trim();
}

export function listEnabledCapabilityIds(
  bindings: Iterable<CapabilityBinding>,
): CapabilityId[] {
  const enabled = new Set<CapabilityId>();
  for (const binding of bindings) {
    const normalizedId = binding.capabilityId.trim();
    if (!normalizedId || !binding.enabled) {
      continue;
    }
    enabled.add(normalizedId);
  }
  return Array.from(enabled);
}

export function hasEnabledCapability(
  bindings: Iterable<CapabilityBinding>,
  capabilityId: CapabilityId,
): boolean {
  const normalizedTarget = capabilityId.trim();
  if (!normalizedTarget) {
    return false;
  }
  for (const binding of bindings) {
    if (binding.enabled && binding.capabilityId.trim() === normalizedTarget) {
      return true;
    }
  }
  return false;
}

export function createCapabilityExecutorRegistry(
  executors: Iterable<AnyCapabilityExecutor>,
): Map<CapabilityId, AnyCapabilityExecutor> {
  const registry = new Map<CapabilityId, AnyCapabilityExecutor>();
  for (const executor of executors) {
    const normalizedId = executor.capabilityId.trim();
    if (!normalizedId || registry.has(normalizedId)) {
      continue;
    }
    registry.set(normalizedId, {
      ...executor,
      capabilityId: normalizedId,
    });
  }
  return registry;
}

export function createCapabilityExecutorProviderRegistry<TContext>(
  providers: Iterable<CapabilityExecutorProviderDefinition<TContext>>,
): Map<string, CapabilityExecutorProviderDefinition<TContext>> {
  const registry = new Map<string, CapabilityExecutorProviderDefinition<TContext>>();
  for (const provider of providers) {
    const normalized = normalizeCapabilityExecutorProviderDefinition(provider);
    if (!normalized || registry.has(normalized.id)) {
      continue;
    }
    registry.set(normalized.id, normalized);
  }
  return registry;
}

export function listCapabilityExecutorsFromProviders<TContext>(
  providers: Iterable<CapabilityExecutorProviderDefinition<TContext>>,
  context: TContext,
): AnyCapabilityExecutor[] {
  const executors: AnyCapabilityExecutor[] = [];
  for (const provider of createCapabilityExecutorProviderRegistry(providers).values()) {
    for (const executor of provider.createExecutors(context)) {
      executors.push(executor);
    }
  }
  return executors;
}

export function createCapabilityExecutorRegistryFromProviders<TContext>(
  providers: Iterable<CapabilityExecutorProviderDefinition<TContext>>,
  context: TContext,
): Map<CapabilityId, AnyCapabilityExecutor> {
  return createCapabilityExecutorRegistry(listCapabilityExecutorsFromProviders(providers, context));
}

export async function executeCapabilityInvocation<TResult = unknown>(
  registry: ReadonlyMap<CapabilityId, AnyCapabilityExecutor>,
  invocation: CapabilityInvocation,
): Promise<CapabilityExecutionResult<TResult>> {
  const normalizedCapabilityId = invocation.capabilityId.trim();
  const normalizedActionId = invocation.actionId.trim();

  if (!normalizedCapabilityId || !normalizedActionId) {
    return {
      ok: false,
      capabilityId: normalizedCapabilityId,
      actionId: normalizedActionId,
      error: "Capability invocation requires both capabilityId and actionId.",
      code: "invalid_invocation",
    };
  }

  const executor = registry.get(normalizedCapabilityId);
  if (!executor) {
    return {
      ok: false,
      capabilityId: normalizedCapabilityId,
      actionId: normalizedActionId,
      error: `No capability executor is registered for ${normalizedCapabilityId}.`,
      code: "missing_executor",
    };
  }

  return (await executor.execute({
    ...invocation,
    capabilityId: normalizedCapabilityId,
    actionId: normalizedActionId,
  })) as CapabilityExecutionResult<TResult>;
}
