import type {
  ProviderUiSurfaceControlOption,
  ProviderUiSurfaceSandboxHostAction,
  ProviderUiSurfaceSandboxHostControl,
  ProviderUiSurfaceSandboxHostResource,
  ProviderUiSurfaceSandboxHostSection,
} from "@instafy/provider-contract";
import { normalizeProviderUiSurfaceSandboxCapabilities } from "@instafy/provider-contract";
import {
  createProviderSandboxHostStatePayload,
  replaceProviderSandboxHostStateResources,
  type ProviderSandboxHostStatePayload,
} from "../../utils/providerSandboxBridge";

export type ParsedSandboxHostData = {
  sections: ProviderUiSurfaceSandboxHostSection[];
  resources: ProviderUiSurfaceSandboxHostResource[];
};

export type ParsedSandboxHostMutations = {
  actions: ProviderUiSurfaceSandboxHostAction[];
  controls: ProviderUiSurfaceSandboxHostControl[];
};

function parseSandboxHostControlOptions(
  value: unknown,
): ProviderUiSurfaceControlOption[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const options = value
    .filter((option) => option && typeof option === "object" && !Array.isArray(option))
    .map((option) => {
      const record = option as Record<string, unknown>;
      const label = typeof record.label === "string" ? record.label.trim() : "";
      const optionValue = typeof record.value === "string" ? record.value.trim() : "";
      if (!label || !optionValue) {
        return null;
      }
      return {
        label,
        value: optionValue,
        ...(typeof record.description === "string" && record.description.trim().length > 0
          ? { description: record.description.trim() }
          : {}),
      };
    })
    .filter((option): option is NonNullable<typeof option> => Boolean(option));
  return options.length > 0 ? options : undefined;
}

function parseSandboxHostFacts(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const facts = value
    .filter((fact) => fact && typeof fact === "object" && !Array.isArray(fact))
    .map((fact) => {
      const record = fact as Record<string, unknown>;
      const label = typeof record.label === "string" ? record.label.trim() : "";
      const factValue = typeof record.value === "string" ? record.value.trim() : "";
      if (!label || !factValue) {
        return null;
      }
      return {
        label,
        value: factValue,
      };
    })
    .filter((fact): fact is NonNullable<typeof fact> => Boolean(fact));
  return facts.length > 0 ? facts : undefined;
}

function parseSandboxHostItems(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export function parseSandboxHostResource(
  value: unknown,
): ProviderUiSurfaceSandboxHostResource | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const resourceId = typeof record.id === "string" ? record.id.trim() : "";
  if (!resourceId) {
    return null;
  }
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  const facts = parseSandboxHostFacts(record.facts);
  const items = parseSandboxHostItems(record.items);
  if (!title && !description && !facts?.length && !items?.length) {
    return null;
  }
  return {
    id: resourceId,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(facts ? { facts } : {}),
    ...(items ? { items } : {}),
  };
}

function parseSandboxHostAction(value: unknown): ProviderUiSurfaceSandboxHostAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const actionId = typeof record.id === "string" ? record.id.trim() : "";
  const label = typeof record.label === "string" ? record.label.trim() : "";
  if (!actionId || !label) {
    return null;
  }
  const variant: ProviderUiSurfaceSandboxHostAction["variant"] =
    record.variant === "primary" || record.variant === "outline" || record.variant === "ghost"
      ? record.variant
      : undefined;
  return {
    id: actionId,
    label,
    ...(typeof record.description === "string" && record.description.trim().length > 0
      ? { description: record.description.trim() }
      : {}),
    ...(variant ? { variant } : {}),
    ...(record.disabled === true ? { disabled: true } : {}),
  };
}

function parseSandboxHostControl(value: unknown): ProviderUiSurfaceSandboxHostControl | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const controlId = typeof record.id === "string" ? record.id.trim() : "";
  const label = typeof record.label === "string" ? record.label.trim() : "";
  const kind =
    record.kind === "readonly" || record.kind === "toggle" || record.kind === "select"
      ? record.kind
      : null;
  if (!controlId || !label || !kind) {
    return null;
  }
  const parsedOptions = parseSandboxHostControlOptions(record.options);
  return {
    id: controlId,
    kind,
    label,
    ...(typeof record.description === "string" && record.description.trim().length > 0
      ? { description: record.description.trim() }
      : {}),
    ...(typeof record.value === "string" || typeof record.value === "boolean"
      ? { value: record.value }
      : {}),
    ...(typeof record.placeholder === "string" && record.placeholder.trim().length > 0
      ? { placeholder: record.placeholder.trim() }
      : {}),
    ...(record.disabled === true ? { disabled: true } : {}),
    ...(record.loading === true ? { loading: true } : {}),
    ...(typeof record.error === "string" && record.error.trim().length > 0
      ? { error: record.error.trim() }
      : {}),
    ...(parsedOptions ? { options: parsedOptions } : {}),
  };
}

function parseSandboxHostSection(value: unknown): ProviderUiSurfaceSandboxHostSection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const sectionId = typeof record.id === "string" ? record.id.trim() : "";
  if (!sectionId) {
    return null;
  }
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  const facts = parseSandboxHostFacts(record.facts);
  const items = parseSandboxHostItems(record.items);
  if (!title && !description && !facts?.length && !items?.length) {
    return null;
  }
  return {
    id: sectionId,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(facts ? { facts } : {}),
    ...(items ? { items } : {}),
  };
}

export function parseSandboxHostMutations(
  value: Record<string, unknown> | null,
): ParsedSandboxHostMutations {
  const actions = Array.isArray(value?.hostActions)
    ? value.hostActions
        .map((action) => parseSandboxHostAction(action))
        .filter((action): action is NonNullable<typeof action> => Boolean(action))
    : [];
  const controls = Array.isArray(value?.hostControls)
    ? value.hostControls
        .map((control) => parseSandboxHostControl(control))
        .filter((control): control is NonNullable<typeof control> => Boolean(control))
    : [];
  return {
    actions,
    controls,
  };
}

export function parseSandboxHostData(value: Record<string, unknown> | null): ParsedSandboxHostData {
  const sections = Array.isArray(value?.hostSections)
    ? value.hostSections
        .map((section) => parseSandboxHostSection(section))
        .filter((section): section is NonNullable<typeof section> => Boolean(section))
    : [];
  const resources = Array.isArray(value?.hostResources)
    ? value.hostResources
        .map((resource) => parseSandboxHostResource(resource))
        .filter((resource): resource is NonNullable<typeof resource> => Boolean(resource))
    : [];
  return {
    sections,
    resources,
  };
}

export function parseSandboxHostResourceDeltaPayload(payload: unknown) {
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  const resources = Array.isArray(record?.resources)
    ? record.resources
        .map((resource) => parseSandboxHostResource(resource))
        .filter((resource): resource is NonNullable<typeof resource> => Boolean(resource))
    : [];
  const removedResourceIds = Array.isArray(record?.removedResourceIds)
    ? record.removedResourceIds
        .filter((resourceId): resourceId is string => typeof resourceId === "string")
        .map((resourceId) => resourceId.trim())
        .filter(Boolean)
    : [];
  const stateToken =
    typeof record?.stateToken === "string" && record.stateToken.trim().length > 0
      ? record.stateToken.trim()
      : undefined;
  return {
    resources,
    removedResourceIds,
    ...(stateToken ? { stateToken } : {}),
  };
}

export function parseSandboxInvalidatedResourceIds(payload: unknown) {
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  return Array.isArray(record?.resourceIds)
    ? record.resourceIds
        .filter((resourceId): resourceId is string => typeof resourceId === "string")
        .map((resourceId) => resourceId.trim())
        .filter(Boolean)
    : [];
}

export function mergeSandboxHostResources(
  currentResources: ProviderUiSurfaceSandboxHostResource[],
  changedResources: ProviderUiSurfaceSandboxHostResource[],
  removedResourceIds: string[],
) {
  const nextById = new Map(currentResources.map((resource) => [resource.id, resource]));
  for (const resourceId of removedResourceIds) {
    nextById.delete(resourceId);
  }
  for (const resource of changedResources) {
    nextById.set(resource.id, resource);
  }
  const nextOrder = currentResources
    .map((resource) => resource.id)
    .filter((resourceId) => nextById.has(resourceId));
  for (const resource of changedResources) {
    if (!nextOrder.includes(resource.id)) {
      nextOrder.push(resource.id);
    }
  }
  return nextOrder
    .map((resourceId) => nextById.get(resourceId))
    .filter((resource): resource is ProviderUiSurfaceSandboxHostResource => Boolean(resource));
}

export function mergeSandboxHostResourceDeltaIntoState(input: {
  currentState: ProviderSandboxHostStatePayload;
  changedResources: ProviderUiSurfaceSandboxHostResource[];
  removedResourceIds: string[];
  stateToken?: string;
}): ProviderSandboxHostStatePayload {
  const { currentState, changedResources, removedResourceIds, stateToken } = input;
  const nextResources = mergeSandboxHostResources(
    currentState.hostResources ?? [],
    changedResources,
    removedResourceIds,
  );
  return replaceProviderSandboxHostStateResources(currentState, nextResources, {
    stateToken,
  });
}

export function parseProviderSandboxHostState(
  payload: unknown,
): ProviderSandboxHostStatePayload | null {
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  const nextVersion = record?.version === 1 ? record.version : null;
  const nextStateToken =
    typeof record?.stateToken === "string" ? record.stateToken.trim() : "";
  const nextProviderId =
    typeof record?.providerId === "string" ? record.providerId.trim() : "";
  const nextSurfaceId =
    typeof record?.surfaceId === "string" ? record.surfaceId.trim() : "";
  const nextProviderTitle =
    typeof record?.providerTitle === "string" ? record.providerTitle.trim() : nextProviderId;
  const nextFamilyId =
    typeof record?.familyId === "string" ? record.familyId.trim() : "";
  const nextTheme = record?.resolvedTheme === "dark" ? "dark" : "light";
  const nextGrantedCapabilities =
    normalizeProviderUiSurfaceSandboxCapabilities(record?.grantedCapabilities) ?? [];
  const nextHostMutations = parseSandboxHostMutations(record);
  const nextHostData = parseSandboxHostData(record);

  if (nextVersion !== 1 || !nextProviderId || !nextSurfaceId) {
    return null;
  }

  return createProviderSandboxHostStatePayload({
    version: nextVersion,
    stateToken: nextStateToken || undefined,
    providerId: nextProviderId,
    providerTitle: nextProviderTitle,
    familyId: nextFamilyId,
    surfaceId: nextSurfaceId,
    resolvedTheme: nextTheme,
    grantedCapabilities: nextGrantedCapabilities,
    hostData: nextHostData,
    hostMutations: nextHostMutations,
  });
}
