import type {
  ProviderHostSurfaceContribution,
  ProviderSummary,
} from "@instafy/provider-contract";
import { resolveProviderSurfaceSummary } from "./providerHostSurfaceMetadata";
import { resolveProviderHostSurfacePolicy } from "./providerHostSurfacePolicy";
import type {
  ProviderHostSurfaceEntry,
  ProviderHostSurfaceSelectionOptions,
} from "./providerHostSurfaceTypes";
import {
  normalizeProviderHostSurfaceId,
  normalizeString,
} from "./providerHostSurfaceTypes";

function buildProviderHostSurfaceEntry(
  provider: ProviderSummary,
  surface: ProviderHostSurfaceContribution,
): ProviderHostSurfaceEntry {
  return {
    provider,
    familyId:
      normalizeString(provider.manifest?.familyId) || normalizeString(provider.id),
    surface,
  };
}

function matchesSurfaceId(
  surface: ProviderHostSurfaceContribution | null | undefined,
  surfaceId: string,
) {
  return normalizeProviderHostSurfaceId(surface?.surface) === surfaceId;
}

function selectPreferredShellSurfaceEntry(
  provider: ProviderSummary,
  prioritizedSurfaceIds: string[],
  options: Pick<ProviderHostSurfaceSelectionOptions, "includeSandboxed"> = {},
): ProviderHostSurfaceEntry | null {
  const hostSurfaces = provider.manifest?.hostSurfaces ?? [];
  let deferredSandboxEntry: ProviderHostSurfaceEntry | null = null;

  for (const surfaceId of prioritizedSurfaceIds) {
    const matchingEntries = hostSurfaces
      .filter((surface) => matchesSurfaceId(surface, surfaceId))
      .map((surface) => buildProviderHostSurfaceEntry(provider, surface));

    if (matchingEntries.length === 0) {
      continue;
    }

    const declarativeEntry =
      matchingEntries.find(
        (entry) => resolveProviderHostSurfacePolicy(entry).renderMode !== "sandboxed",
      ) ?? null;
    if (declarativeEntry) {
      return declarativeEntry;
    }

    if (!deferredSandboxEntry && options.includeSandboxed !== false) {
      deferredSandboxEntry =
        matchingEntries.find(
          (entry) => resolveProviderHostSurfacePolicy(entry).renderMode === "sandboxed",
        ) ?? null;
    }
  }

  return deferredSandboxEntry;
}

export function listProviderShellSurfaceEntries(
  providers: Array<ProviderSummary | null | undefined>,
  options: ProviderHostSurfaceSelectionOptions = {},
): ProviderHostSurfaceEntry[] {
  const prioritizedSurfaceIds = (options.surfaceIds ?? ["settings_card", "status_card"])
    .map((surfaceId) => normalizeProviderHostSurfaceId(surfaceId))
    .filter(Boolean);
  const excludedProviderIds = new Set(
    (options.excludeProviderIds ?? []).map((providerId) =>
      normalizeString(providerId).toLowerCase(),
    ),
  );
  const seenProviderIds = new Set<string>();
  const results: ProviderHostSurfaceEntry[] = [];

  for (const providerSummary of providers) {
    if (!providerSummary) {
      continue;
    }
    const provider = resolveProviderSurfaceSummary(providerSummary);
    const normalizedProviderId = normalizeString(provider.id).toLowerCase();
    if (
      !normalizedProviderId ||
      excludedProviderIds.has(normalizedProviderId) ||
      seenProviderIds.has(normalizedProviderId)
    ) {
      continue;
    }

    const entry = selectPreferredShellSurfaceEntry(provider, prioritizedSurfaceIds, options);
    if (!entry) {
      continue;
    }

    seenProviderIds.add(normalizedProviderId);
    results.push(entry);
  }

  return results;
}

export function resolveExtensionProviderShellSurfaceEntry(
  provider: ProviderSummary | null | undefined,
  options: Pick<ProviderHostSurfaceSelectionOptions, "includeSandboxed"> = {},
): ProviderHostSurfaceEntry | null {
  if (!provider) {
    return null;
  }

  return (
    listProviderShellSurfaceEntries([provider], {
      surfaceIds: ["detail_view", "status_card", "extension_tile"],
      includeSandboxed: options.includeSandboxed,
    })[0] ?? null
  );
}
