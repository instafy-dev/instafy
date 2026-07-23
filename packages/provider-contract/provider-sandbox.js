import {
  normalizeFiniteNumber,
  normalizeStringArray,
  normalizeTrimmedString,
} from "./shared.js";

export const PROVIDER_UI_SURFACE_SANDBOX_CAPABILITIES = Object.freeze([
  "resize",
  "open_external",
  "host_actions",
  "host_controls",
  "host_sections",
  "host_resources",
  "host_resource_deltas",
]);

const SANDBOX_CAPABILITIES = new Set(PROVIDER_UI_SURFACE_SANDBOX_CAPABILITIES);

function readSandboxCapabilityValues(input) {
  if (Array.isArray(input)) {
    return input;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  if (Array.isArray(input.capabilities)) {
    return input.capabilities;
  }
  if (Array.isArray(input.grantedCapabilities)) {
    return input.grantedCapabilities;
  }
  return null;
}

export function isProviderUiSurfaceSandboxCapability(value) {
  return typeof value === "string" && SANDBOX_CAPABILITIES.has(value);
}

export function normalizeProviderUiSurfaceSandboxCapabilities(values) {
  return Array.isArray(values)
    ? values.filter((capability) => isProviderUiSurfaceSandboxCapability(capability))
    : undefined;
}

export function providerUiSurfaceSandboxHasCapability(input, capability) {
  if (!isProviderUiSurfaceSandboxCapability(capability)) {
    return false;
  }
  const capabilities = normalizeProviderUiSurfaceSandboxCapabilities(
    readSandboxCapabilityValues(input),
  );
  return Boolean(capabilities?.includes(capability));
}

export function createProviderUiSurfaceSandboxCapabilityProfile(input) {
  const capabilities =
    normalizeProviderUiSurfaceSandboxCapabilities(readSandboxCapabilityValues(input)) ?? [];
  const canResize = capabilities.includes("resize");
  const canOpenExternal = capabilities.includes("open_external");
  const canInvokeHostActions = capabilities.includes("host_actions");
  const canUpdateHostControls = capabilities.includes("host_controls");
  const canReadHostSections = capabilities.includes("host_sections");
  const canReadHostResources = capabilities.includes("host_resources");
  const supportsHostResourceDeltas =
    canReadHostResources && capabilities.includes("host_resource_deltas");
  return {
    capabilities,
    canResize,
    canOpenExternal,
    canInvokeHostActions,
    canUpdateHostControls,
    canReadHostSections,
    canReadHostResources,
    canReadHostData: canReadHostSections || canReadHostResources,
    canMutateHost: canInvokeHostActions || canUpdateHostControls,
    supportsHostResourceDeltas,
  };
}

function normalizeFacts(values) {
  if (!Array.isArray(values)) {
    return undefined;
  }
  const facts = values
    .map((fact) => {
      if (!fact || typeof fact !== "object" || Array.isArray(fact)) {
        return null;
      }
      const label = normalizeTrimmedString(fact.label);
      const value = normalizeTrimmedString(fact.value);
      if (!label || !value) {
        return null;
      }
      return { label, value };
    })
    .filter(Boolean);
  return facts.length > 0 ? facts : undefined;
}

function normalizeItems(values) {
  return normalizeStringArray(values);
}

function createSandboxHostAction(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const id = normalizeTrimmedString(input.id);
  const label = normalizeTrimmedString(input.label);
  const description = normalizeTrimmedString(input.description);
  const variant =
    input.variant === "primary" || input.variant === "outline" || input.variant === "ghost"
      ? input.variant
      : undefined;
  const disabled = typeof input.disabled === "boolean" ? input.disabled : undefined;
  if (!id || !label) {
    return null;
  }
  return {
    id,
    label,
    ...(description ? { description } : {}),
    ...(variant ? { variant } : {}),
    ...(disabled !== undefined ? { disabled } : {}),
  };
}

function createSandboxHostControl(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const id = normalizeTrimmedString(input.id);
  const kind =
    input.kind === "readonly" || input.kind === "toggle" || input.kind === "select"
      ? input.kind
      : undefined;
  const label = normalizeTrimmedString(input.label);
  const description = normalizeTrimmedString(input.description);
  const placeholder = normalizeTrimmedString(input.placeholder);
  const disabled = typeof input.disabled === "boolean" ? input.disabled : undefined;
  const loading = typeof input.loading === "boolean" ? input.loading : undefined;
  const error = normalizeTrimmedString(input.error);
  const value =
    typeof input.value === "string" || typeof input.value === "boolean" ? input.value : undefined;
  const options = Array.isArray(input.options)
    ? input.options
        .map((option) => {
          if (!option || typeof option !== "object" || Array.isArray(option)) {
            return null;
          }
          const optionLabel = normalizeTrimmedString(option.label);
          const optionValue = normalizeTrimmedString(option.value);
          const optionDescription = normalizeTrimmedString(option.description);
          if (!optionLabel || !optionValue) {
            return null;
          }
          return {
            label: optionLabel,
            value: optionValue,
            ...(optionDescription ? { description: optionDescription } : {}),
          };
        })
        .filter(Boolean)
    : undefined;
  if (!id || !kind || !label) {
    return null;
  }
  return {
    id,
    kind,
    label,
    ...(description ? { description } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(placeholder ? { placeholder } : {}),
    ...(disabled !== undefined ? { disabled } : {}),
    ...(loading !== undefined ? { loading } : {}),
    ...(error ? { error } : {}),
    ...(options?.length ? { options } : {}),
  };
}

function createSandboxHostSection(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const id = normalizeTrimmedString(input.id);
  const title = normalizeTrimmedString(input.title);
  const description = normalizeTrimmedString(input.description);
  const facts = normalizeFacts(input.facts);
  const items = normalizeItems(input.items);
  if (!id) {
    return null;
  }
  return {
    id,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(facts ? { facts } : {}),
    ...(items ? { items } : {}),
  };
}

function createSandboxHostResource(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const id = normalizeTrimmedString(input.id);
  const title = normalizeTrimmedString(input.title);
  const description = normalizeTrimmedString(input.description);
  const facts = normalizeFacts(input.facts);
  const items = normalizeItems(input.items);
  if (!id) {
    return null;
  }
  return {
    id,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(facts ? { facts } : {}),
    ...(items ? { items } : {}),
  };
}

export function createProviderUiSurfaceSandboxContainer(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const kind = input.kind === "iframe" ? input.kind : undefined;
  const src = normalizeTrimmedString(input.src);
  const title = normalizeTrimmedString(input.title);
  const allow = normalizeTrimmedString(input.allow);
  const capabilities = normalizeProviderUiSurfaceSandboxCapabilities(input.capabilities);
  const resources = Array.isArray(input.resources)
    ? input.resources
        .map((resource) => {
          if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
            return null;
          }
          const id = normalizeTrimmedString(resource.id);
          const title = normalizeTrimmedString(resource.title);
          const description = normalizeTrimmedString(resource.description);
          const binding =
            resource.binding &&
            typeof resource.binding === "object" &&
            !Array.isArray(resource.binding) &&
            normalizeTrimmedString(resource.binding.hostBindingId)
              ? {
                  hostBindingId: normalizeTrimmedString(resource.binding.hostBindingId),
                }
              : undefined;
          if (!id || !binding?.hostBindingId) {
            return null;
          }
          return {
            id,
            ...(title ? { title } : {}),
            ...(description ? { description } : {}),
            binding,
          };
        })
        .filter((resource) => Boolean(resource))
    : undefined;
  if (!kind || !src) {
    return undefined;
  }
  return {
    kind,
    src,
    ...(title ? { title } : {}),
    ...(allow ? { allow } : {}),
    ...(capabilities?.length ? { capabilities } : {}),
    ...(resources?.length ? { resources } : {}),
  };
}

export function createProviderUiSurfaceSandboxHostState(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const providerId = normalizeTrimmedString(input.providerId);
  const providerTitle = normalizeTrimmedString(input.providerTitle);
  const familyId = normalizeTrimmedString(input.familyId);
  const surfaceId = normalizeTrimmedString(input.surfaceId);
  const resolvedTheme = input.resolvedTheme === "light" || input.resolvedTheme === "dark"
    ? input.resolvedTheme
    : undefined;
  const stateToken = normalizeTrimmedString(input.stateToken);
  const grantedCapabilities =
    normalizeProviderUiSurfaceSandboxCapabilities(input.grantedCapabilities) ?? [];
  const hostActions = Array.isArray(input.hostActions)
    ? input.hostActions.map(createSandboxHostAction).filter(Boolean)
    : undefined;
  const hostControls = Array.isArray(input.hostControls)
    ? input.hostControls.map(createSandboxHostControl).filter(Boolean)
    : undefined;
  const hostSections = Array.isArray(input.hostSections)
    ? input.hostSections.map(createSandboxHostSection).filter(Boolean)
    : undefined;
  const hostResources = Array.isArray(input.hostResources)
    ? input.hostResources.map(createSandboxHostResource).filter(Boolean)
    : undefined;
  if (!providerId || !providerTitle || !familyId || !surfaceId || !resolvedTheme) {
    return undefined;
  }
  return {
    version: 1,
    ...(stateToken ? { stateToken } : {}),
    providerId,
    providerTitle,
    familyId,
    surfaceId,
    resolvedTheme,
    grantedCapabilities,
    ...(hostActions?.length ? { hostActions } : {}),
    ...(hostControls?.length ? { hostControls } : {}),
    ...(hostSections?.length ? { hostSections } : {}),
    ...(hostResources?.length ? { hostResources } : {}),
  };
}

export function createProviderUiSurfaceSandboxHostResourceInvalidationPayload(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const resourceIds = normalizeStringArray(input.resourceIds);
  const stateToken = normalizeTrimmedString(input.stateToken);
  if (!resourceIds?.length) {
    return undefined;
  }
  return {
    resourceIds,
    ...(stateToken ? { stateToken } : {}),
  };
}

export function createProviderUiSurfaceSandboxHostResourceDeltaPayload(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const resources = Array.isArray(input.resources)
    ? input.resources.map(createSandboxHostResource).filter(Boolean)
    : undefined;
  const removedResourceIds = normalizeStringArray(input.removedResourceIds);
  const stateToken = normalizeTrimmedString(input.stateToken);
  if (!resources?.length && !removedResourceIds?.length) {
    return undefined;
  }
  return {
    ...(resources?.length ? { resources } : {}),
    ...(removedResourceIds?.length ? { removedResourceIds } : {}),
    ...(stateToken ? { stateToken } : {}),
  };
}

export function createProviderUiSurfaceSandboxBridgeMessage(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  switch (input.type) {
    case "instafy:providerSandboxReady":
    case "instafy:providerSandboxRequestHostState":
      return { type: input.type };
    case "instafy:providerSandboxResize": {
      const height = normalizeFiniteNumber(input.payload?.height);
      return height !== undefined
        ? {
            type: input.type,
            payload: { height },
          }
        : undefined;
    }
    case "instafy:providerSandboxOpenExternal": {
      const url = normalizeTrimmedString(input.url);
      return url ? { type: input.type, url } : undefined;
    }
    case "instafy:providerSandboxInvokeHostAction": {
      const actionId = normalizeTrimmedString(input.payload?.actionId);
      return actionId
        ? {
            type: input.type,
            payload: { actionId },
          }
        : undefined;
    }
    case "instafy:providerSandboxUpdateHostControl": {
      const controlId = normalizeTrimmedString(input.payload?.controlId);
      const value =
        typeof input.payload?.value === "string" || typeof input.payload?.value === "boolean"
          ? input.payload.value
          : undefined;
      return controlId && value !== undefined
        ? {
            type: input.type,
            payload: { controlId, value },
          }
        : undefined;
    }
    case "instafy:providerSandboxHostState": {
      const payload = createProviderUiSurfaceSandboxHostState(input.payload);
      return payload ? { type: input.type, payload } : undefined;
    }
    case "instafy:providerSandboxHostResourcesInvalidated": {
      const payload = createProviderUiSurfaceSandboxHostResourceInvalidationPayload(input.payload);
      return payload ? { type: input.type, payload } : undefined;
    }
    case "instafy:providerSandboxHostResourceDelta": {
      const payload = createProviderUiSurfaceSandboxHostResourceDeltaPayload(input.payload);
      return payload ? { type: input.type, payload } : undefined;
    }
    default:
      return undefined;
  }
}
