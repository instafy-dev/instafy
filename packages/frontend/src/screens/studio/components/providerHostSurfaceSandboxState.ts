import {
  listProviderHostSurfaceActions,
  listProviderHostSurfaceControls,
  listProviderHostSurfaceSections,
  type ProviderHostSurfaceEntry,
  type ProviderHostSurfaceSandboxDescriptor,
} from "../../../providers/providerHostSurfaces";
import { createProviderUiSurfaceSandboxCapabilityProfile } from "@instafy/provider-contract";
import type {
  ProviderSandboxHostStatePayload,
} from "../../../utils/providerSandboxBridge";
import { createProviderSandboxHostStatePayload } from "../../../utils/providerSandboxBridge";
import type { SurfaceHostActionBinding } from "./ProviderHostSurfaceActions";
import type { SurfaceHostBinding } from "./ProviderHostSurfaceControls";
import type { SurfaceHostSectionBinding } from "./ProviderHostSurfaceCard";

// Host-side projection layer for sandboxed provider surfaces.
// This is the single place that turns provider shell entries + host bindings
// into grouped hostData/hostMutations plus the serialized bridge payload.
export type ProviderSandboxHostResource = NonNullable<
  ProviderSandboxHostStatePayload["hostResources"]
>[number];

export type ProviderHostSurfaceSandboxHostDataProjection = {
  sections: NonNullable<ProviderSandboxHostStatePayload["hostSections"]>;
  resources: ProviderSandboxHostResource[];
};

export type ProviderHostSurfaceSandboxHostMutationsProjection = {
  actions: NonNullable<ProviderSandboxHostStatePayload["hostActions"]>;
  controls: NonNullable<ProviderSandboxHostStatePayload["hostControls"]>;
};

export type ProviderHostSurfaceSandboxStateProjection = {
  hostData: ProviderHostSurfaceSandboxHostDataProjection;
  hostMutations: ProviderHostSurfaceSandboxHostMutationsProjection;
  hostPushSnapshot: string;
  hostResourceSnapshot: string;
  hostStateToken: string;
  hostState: ProviderSandboxHostStatePayload;
};

export function normalizeOptionalString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function buildProviderHostSurfaceSandboxResourceDelta(
  previousResources: ProviderSandboxHostResource[],
  nextResources: ProviderSandboxHostResource[],
) {
  const previousById = new Map(
    previousResources.map((resource) => [resource.id, JSON.stringify(resource)]),
  );
  const nextIds = new Set(nextResources.map((resource) => resource.id));
  const resources = nextResources.filter(
    (resource) => previousById.get(resource.id) !== JSON.stringify(resource),
  );
  const removedResourceIds = previousResources
    .map((resource) => resource.id)
    .filter((resourceId) => !nextIds.has(resourceId));
  return {
    resources,
    removedResourceIds,
  };
}

export function buildProviderHostSurfaceSandboxHostMutations(input: {
  entry: ProviderHostSurfaceEntry;
  sandbox: ProviderHostSurfaceSandboxDescriptor | null;
  hostActionBindings?: Record<string, SurfaceHostActionBinding>;
  hostControlBindings?: Record<string, SurfaceHostBinding>;
}): ProviderHostSurfaceSandboxHostMutationsProjection {
  const { entry, sandbox, hostActionBindings, hostControlBindings } = input;
  const capabilityProfile = createProviderUiSurfaceSandboxCapabilityProfile(sandbox);

  const actions =
    capabilityProfile.canInvokeHostActions
      ? listProviderHostSurfaceActions(entry).flatMap((action) => {
          const hostBindingId = normalizeOptionalString(action.binding?.hostBindingId);
          if (!hostBindingId) {
            return [];
          }
          const hostBinding = hostActionBindings?.[hostBindingId];
          if (!hostBinding || hostBinding.hidden) {
            return [];
          }
          return [
            {
              id: hostBindingId,
              label: hostBinding.label ?? action.label,
              ...(hostBinding.description ?? action.description
                ? { description: hostBinding.description ?? action.description }
                : {}),
              ...(hostBinding.variant ?? action.variant
                ? { variant: hostBinding.variant ?? action.variant }
                : {}),
              disabled:
                hostBinding.disabled === true ||
                hostBinding.loading === true ||
                !hostBinding.onPress,
            },
          ];
        })
      : [];

  const controls =
    capabilityProfile.canUpdateHostControls
      ? listProviderHostSurfaceControls(entry).flatMap((control) => {
          const hostBindingId = normalizeOptionalString(control.binding?.hostBindingId);
          if (!hostBindingId) {
            return [];
          }
          const hostBinding = hostControlBindings?.[hostBindingId];
          const value = hostBinding?.value !== undefined ? hostBinding.value : control.value;
          const options = hostBinding?.options ?? control.options;
          const disabled =
            control.disabled === true ||
            hostBinding?.disabled === true ||
            hostBinding?.loading === true ||
            (control.kind !== "readonly" && !hostBinding?.onChange);
          return [
            {
              id: hostBindingId,
              kind: control.kind,
              label: control.label,
              ...(hostBinding?.description ?? control.description
                ? { description: hostBinding?.description ?? control.description }
                : {}),
              ...(value !== undefined ? { value } : {}),
              ...(hostBinding?.placeholder ?? control.placeholder
                ? { placeholder: hostBinding?.placeholder ?? control.placeholder }
                : {}),
              ...(disabled ? { disabled: true } : {}),
              ...(hostBinding?.loading === true ? { loading: true } : {}),
              ...(hostBinding?.error ? { error: hostBinding.error } : {}),
              ...(options && options.length > 0 ? { options } : {}),
            },
          ];
        })
      : [];

  return {
    actions,
    controls,
  };
}

export function buildProviderHostSurfaceSandboxHostData(input: {
  entry: ProviderHostSurfaceEntry;
  sandbox: ProviderHostSurfaceSandboxDescriptor | null;
  hostSectionBindings?: Record<string, SurfaceHostSectionBinding>;
}): ProviderHostSurfaceSandboxHostDataProjection {
  const { entry, sandbox, hostSectionBindings } = input;
  const capabilityProfile = createProviderUiSurfaceSandboxCapabilityProfile(sandbox);

  const sections =
    capabilityProfile.canReadHostSections
      ? listProviderHostSurfaceSections(entry).flatMap((section) => {
          const hostBindingId = normalizeOptionalString(section.binding?.hostBindingId);
          if (!hostBindingId) {
            return [];
          }
          const hostBinding = hostSectionBindings?.[hostBindingId];
          if (!hostBinding || hostBinding.hidden) {
            return [];
          }
          const title = hostBinding.title ?? section.title;
          const description = hostBinding.description ?? section.description;
          const facts = hostBinding.facts ?? section.facts;
          const items = hostBinding.items ?? section.items;
          if (
            !title &&
            !description &&
            (!facts || facts.length === 0) &&
            (!items || items.length === 0)
          ) {
            return [];
          }
          return [
            {
              id: hostBindingId,
              ...(title ? { title } : {}),
              ...(description ? { description } : {}),
              ...(facts && facts.length > 0 ? { facts } : {}),
              ...(items && items.length > 0 ? { items } : {}),
            },
          ];
        })
      : [];

  const resources =
    capabilityProfile.canReadHostResources && sandbox?.resources?.length
      ? sandbox.resources.flatMap((resource) => {
          const hostBindingId = normalizeOptionalString(resource.binding?.hostBindingId);
          if (!hostBindingId) {
            return [];
          }
          const hostBinding = hostSectionBindings?.[hostBindingId];
          if (!hostBinding || hostBinding.hidden) {
            return [];
          }
          const title = hostBinding.title ?? resource.title;
          const description = hostBinding.description ?? resource.description;
          const facts = hostBinding.facts;
          const items = hostBinding.items;
          if (
            !title &&
            !description &&
            (!facts || facts.length === 0) &&
            (!items || items.length === 0)
          ) {
            return [];
          }
          return [
            {
              id: resource.id,
              ...(title ? { title } : {}),
              ...(description ? { description } : {}),
              ...(facts && facts.length > 0 ? { facts } : {}),
              ...(items && items.length > 0 ? { items } : {}),
            },
          ];
        })
      : [];

  return {
    sections,
    resources,
  };
}

export function buildProviderHostSurfaceSandboxState(input: {
  entry: ProviderHostSurfaceEntry;
  sandbox: ProviderHostSurfaceSandboxDescriptor | null;
  resolvedTheme: "light" | "dark";
  hostActionBindings?: Record<string, SurfaceHostActionBinding>;
  hostControlBindings?: Record<string, SurfaceHostBinding>;
  hostSectionBindings?: Record<string, SurfaceHostSectionBinding>;
}): ProviderHostSurfaceSandboxStateProjection {
  const { entry, hostActionBindings, hostControlBindings, hostSectionBindings, resolvedTheme, sandbox } =
    input;
  const capabilityProfile = createProviderUiSurfaceSandboxCapabilityProfile(sandbox);
  const hostMutations = buildProviderHostSurfaceSandboxHostMutations({
    entry,
    sandbox,
    hostActionBindings,
    hostControlBindings,
  });
  const hostData = buildProviderHostSurfaceSandboxHostData({
    entry,
    sandbox,
    hostSectionBindings,
  });

  const grantedCapabilities = capabilityProfile.capabilities;
  const hostPushSnapshot = JSON.stringify({
    providerId: entry.provider.id,
    familyId: entry.familyId,
    surfaceId: entry.surface.surface,
    resolvedTheme,
    grantedCapabilities,
    hostData: {
      sections: hostData.sections,
    },
    hostMutations,
  });
  const hostResourceSnapshot = JSON.stringify(hostData.resources);
  const hostStateToken = JSON.stringify({
    providerId: entry.provider.id,
    familyId: entry.familyId,
    surfaceId: entry.surface.surface,
    resolvedTheme,
    grantedCapabilities,
    hostData,
    hostMutations,
  });
  const hostState: ProviderSandboxHostStatePayload = createProviderSandboxHostStatePayload({
    stateToken: hostStateToken,
    providerId: entry.provider.id,
    providerTitle: entry.provider.title,
    familyId: entry.familyId,
    surfaceId: entry.surface.surface,
    resolvedTheme,
    grantedCapabilities,
    hostData,
    hostMutations,
  });

  return {
    hostData,
    hostMutations,
    hostPushSnapshot,
    hostResourceSnapshot,
    hostStateToken,
    hostState,
  };
}
