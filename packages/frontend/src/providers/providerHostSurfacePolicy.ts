import type {
  ProviderUiSurfaceRenderMode,
  ProviderUiSurfaceTrustLevel,
} from "@instafy/provider-contract";
import { normalizeProviderUiSurfaceSandboxCapabilities } from "@instafy/provider-contract";
import type {
  ProviderHostSurfaceEntry,
  ProviderHostSurfaceResolvedPolicy,
  ProviderHostSurfaceSandboxDescriptor,
} from "./providerHostSurfaceTypes";
import { normalizeString } from "./providerHostSurfaceTypes";

function readSurfaceMetadata(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function readSurfacePolicy(value: unknown) {
  const metadata = readSurfaceMetadata(value);
  if (!metadata) {
    return null;
  }
  const policy =
    (metadata as { policy?: unknown }).policy &&
    typeof (metadata as { policy?: unknown }).policy === "object" &&
    !Array.isArray((metadata as { policy?: unknown }).policy)
      ? ((metadata as { policy?: Record<string, unknown> }).policy ?? {})
      : null;
  if (!policy) {
    return null;
  }
  const trustLevel =
    policy.trustLevel === "first_party" ||
    policy.trustLevel === "local_trusted" ||
    policy.trustLevel === "untrusted"
      ? policy.trustLevel
      : null;
  const renderMode =
    policy.renderMode === "host_declarative" ||
    policy.renderMode === "sandboxed"
      ? policy.renderMode
      : null;
  return trustLevel || renderMode
    ? {
        ...(trustLevel ? { trustLevel } : {}),
        ...(renderMode ? { renderMode } : {}),
      }
    : null;
}

function readSurfaceSandboxDescriptor(value: unknown): ProviderHostSurfaceSandboxDescriptor | null {
  const metadata = readSurfaceMetadata(value);
  if (!metadata) {
    return null;
  }
  const sandbox =
    (metadata as { sandbox?: unknown }).sandbox &&
    typeof (metadata as { sandbox?: unknown }).sandbox === "object" &&
    !Array.isArray((metadata as { sandbox?: unknown }).sandbox)
      ? ((metadata as { sandbox?: Record<string, unknown> }).sandbox ?? {})
      : null;
  if (!sandbox) {
    return null;
  }
  const kind = sandbox.kind === "iframe" ? sandbox.kind : null;
  const src = normalizeString(typeof sandbox.src === "string" ? sandbox.src : null);
  const title = normalizeString(typeof sandbox.title === "string" ? sandbox.title : null);
  const allow = normalizeString(typeof sandbox.allow === "string" ? sandbox.allow : null);
  const capabilities = normalizeProviderUiSurfaceSandboxCapabilities(sandbox.capabilities) ?? [];
  const resources = Array.isArray(sandbox.resources)
    ? sandbox.resources.flatMap((resource) => {
        if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
          return [];
        }
        const id = normalizeString(typeof resource.id === "string" ? resource.id : null);
        const title = normalizeString(typeof resource.title === "string" ? resource.title : null);
        const description = normalizeString(
          typeof resource.description === "string" ? resource.description : null,
        );
        const binding =
          resource.binding &&
          typeof resource.binding === "object" &&
          !Array.isArray(resource.binding)
            ? (resource.binding as Record<string, unknown>)
            : null;
        const hostBindingId = normalizeString(
          typeof binding?.hostBindingId === "string" ? binding.hostBindingId : null,
        );
        if (!id || !hostBindingId) {
          return [];
        }
        return [
          {
            id,
            ...(title ? { title } : {}),
            ...(description ? { description } : {}),
            binding: {
              hostBindingId,
            },
          },
        ];
      })
    : [];
  if (!kind || !src) {
    return null;
  }
  return {
    kind,
    src,
    ...(title ? { title } : {}),
    ...(allow ? { allow } : {}),
    ...(capabilities.length > 0 ? { capabilities } : {}),
    ...(resources.length > 0 ? { resources } : {}),
  };
}

export function resolveProviderHostSurfacePolicyFromMetadata(
  metadata: unknown,
): ProviderHostSurfaceResolvedPolicy {
  const policy = readSurfacePolicy(metadata);
  const trustLevel = (policy?.trustLevel ?? "untrusted") as ProviderUiSurfaceTrustLevel;
  const renderMode = (policy?.renderMode ?? "host_declarative") as ProviderUiSurfaceRenderMode;
  return {
    trustLevel,
    renderMode,
    allowHostBindings: renderMode !== "sandboxed" && trustLevel !== "untrusted",
  };
}

export function resolveProviderHostSurfacePolicy(
  entry: ProviderHostSurfaceEntry | null | undefined,
): ProviderHostSurfaceResolvedPolicy {
  return resolveProviderHostSurfacePolicyFromMetadata(entry?.surface.metadata);
}

export function resolveProviderHostSurfaceSandboxDescriptor(
  entry: ProviderHostSurfaceEntry | null | undefined,
): ProviderHostSurfaceSandboxDescriptor | null {
  if (!entry || resolveProviderHostSurfacePolicy(entry).renderMode !== "sandboxed") {
    return null;
  }
  return readSurfaceSandboxDescriptor(entry.surface.metadata);
}
