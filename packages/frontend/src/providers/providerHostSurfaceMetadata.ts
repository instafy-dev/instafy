import type {
  ProviderHostSurfaceContribution,
  ProviderSummary,
  ProviderUiSurfaceAction,
  ProviderUiSurfaceControl,
  ProviderUiSurfaceSection,
} from "@instafy/provider-contract";
import { BUILT_IN_PROVIDER_FAMILIES_BY_ID } from "@instafy/provider-contract/builtins";
import { resolveExtensionFamilyId } from "./extensionProviderId";
import type { ProviderHostSurfaceEntry } from "./providerHostSurfaceTypes";
import { normalizeString } from "./providerHostSurfaceTypes";

function readSurfaceMetadata(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function readSurfaceElementEntries(value: unknown, elementId: string) {
  const metadata = readSurfaceMetadata(value);
  if (!metadata || !Array.isArray((metadata as { elements?: unknown[] }).elements)) {
    return [];
  }
  return ((metadata as { elements?: unknown[] }).elements ?? []).filter((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    return normalizeString(
      typeof (entry as { element?: unknown }).element === "string"
        ? (entry as { element?: string }).element
        : null,
    ) === elementId;
  });
}

function readSurfaceSections(value: unknown) {
  return readSurfaceElementEntries(value, "section");
}

function readSurfaceActions(value: unknown) {
  return readSurfaceElementEntries(value, "actions").flatMap((entry) =>
    Array.isArray((entry as { actions?: unknown[] }).actions)
      ? ((entry as { actions?: unknown[] }).actions ?? [])
      : [],
  );
}

function readSurfaceControls(value: unknown) {
  return readSurfaceElementEntries(value, "controls").flatMap((entry) =>
    Array.isArray((entry as { controls?: unknown[] }).controls)
      ? ((entry as { controls?: unknown[] }).controls ?? [])
      : [],
  );
}

export function resolveProviderSurfaceSummary(provider: ProviderSummary): ProviderSummary {
  if ((provider.manifest?.hostSurfaces?.length ?? 0) > 0) {
    return provider;
  }
  const familyId =
    normalizeString(provider.manifest?.familyId) ||
    resolveExtensionFamilyId(provider.id) ||
    normalizeString(provider.id);
  if (!familyId) {
    return provider;
  }
  const builtInFamily = BUILT_IN_PROVIDER_FAMILIES_BY_ID[familyId];
  if (!builtInFamily?.manifest?.hostSurfaces?.length) {
    return provider;
  }
  return {
    ...provider,
    manifest: {
      familyId,
      hostSurfaces: [...builtInFamily.manifest.hostSurfaces],
    },
  };
}

export function listProviderHostSurfaceActions(
  entry: ProviderHostSurfaceEntry | null | undefined,
): ProviderUiSurfaceAction[] {
  if (!entry) {
    return [];
  }
  return readSurfaceActions(entry.surface.metadata).filter(
    (action): action is ProviderUiSurfaceAction =>
      Boolean(
        action &&
          typeof action === "object" &&
          !Array.isArray(action) &&
          typeof (action as { label?: unknown }).label === "string",
      ),
  );
}

export function listProviderHostSurfaceControls(
  entry: ProviderHostSurfaceEntry | null | undefined,
): ProviderUiSurfaceControl[] {
  if (!entry) {
    return [];
  }
  return readSurfaceControls(entry.surface.metadata).filter(
    (control): control is ProviderUiSurfaceControl =>
      Boolean(control) &&
      typeof control === "object" &&
      !Array.isArray(control) &&
      (control as { kind?: unknown }).kind !== undefined &&
      typeof (control as { label?: unknown }).label === "string",
  );
}

export function listProviderHostSurfaceSections(
  entry: ProviderHostSurfaceEntry | null | undefined,
): ProviderUiSurfaceSection[] {
  if (!entry) {
    return [];
  }
  return readSurfaceSections(entry.surface.metadata).filter(
    (section): section is ProviderUiSurfaceSection =>
      Boolean(section) &&
      typeof section === "object" &&
      !Array.isArray(section) &&
      ((typeof (section as { title?: unknown }).title === "string" &&
        (section as { title?: string }).title?.trim().length !== 0) ||
        (Boolean((section as { binding?: unknown }).binding) &&
          typeof (section as { binding?: unknown }).binding === "object" &&
          !Array.isArray((section as { binding?: unknown }).binding) &&
          typeof ((section as { binding?: { hostBindingId?: unknown } }).binding?.hostBindingId) ===
            "string")),
  );
}

export function providerHostSurfaceHasSectionBinding(
  entry: ProviderHostSurfaceEntry | null | undefined,
  hostBindingId: string,
) {
  const normalizedBindingId = normalizeString(hostBindingId);
  if (!entry || !normalizedBindingId) {
    return false;
  }
  return readSurfaceSections(entry.surface.metadata).some((section) => {
    if (!section || typeof section !== "object" || Array.isArray(section)) {
      return false;
    }
    const binding =
      (section as { binding?: unknown }).binding &&
      typeof (section as { binding?: unknown }).binding === "object" &&
      !Array.isArray((section as { binding?: unknown }).binding)
        ? ((section as { binding?: Record<string, unknown> }).binding ?? {})
        : null;
    return normalizeString(
      typeof binding?.hostBindingId === "string" ? binding.hostBindingId : null,
    ) === normalizedBindingId;
  });
}

export function providerHostSurfaceHasActionBinding(
  entry: ProviderHostSurfaceEntry | null | undefined,
  hostBindingId: string,
) {
  const normalizedBindingId = normalizeString(hostBindingId);
  if (!entry || !normalizedBindingId) {
    return false;
  }
  return readSurfaceActions(entry.surface.metadata).some((action) => {
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      return false;
    }
    const binding =
      (action as { binding?: unknown }).binding &&
      typeof (action as { binding?: unknown }).binding === "object" &&
      !Array.isArray((action as { binding?: unknown }).binding)
        ? ((action as { binding?: Record<string, unknown> }).binding ?? {})
        : null;
    return normalizeString(
      typeof binding?.hostBindingId === "string" ? binding.hostBindingId : null,
    ) === normalizedBindingId;
  });
}

export function getProviderHostSurfaceSections(surface: ProviderHostSurfaceContribution | null | undefined) {
  return readSurfaceSections(surface?.metadata);
}
