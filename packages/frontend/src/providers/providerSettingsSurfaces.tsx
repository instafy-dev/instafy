import { createProviderSummary } from "@instafy/provider-contract";
import { SPEECH_PROVIDER_FAMILY } from "@instafy/provider-contract/builtins";
import type { LocalProviderSummary } from "../capabilities/localProviderHostClient";
import type { SurfaceHostActionBinding } from "../screens/studio/components/ProviderHostSurfaceActions";
import type { SurfaceHostBinding } from "../screens/studio/components/ProviderHostSurfaceControls";
import type { SurfaceHostSectionBinding } from "../screens/studio/components/ProviderHostSurfaceCard";
import {
  createSpeechProviderShellBindings,
  type SpeechProviderSurfaceBindingsContext,
} from "../voice/providerSpeechSurfaceBindings";
import { SPEECH_PROVIDER_ID } from "../voice/speechCapabilityMetadata";
import {
  listProviderShellSurfaceEntries,
  type ProviderHostSurfaceEntry,
} from "./providerHostSurfaces";

export type ProviderSettingsSurfaceEntry = {
  key: string;
  familyId: string;
  providerId?: string;
  entry: ProviderHostSurfaceEntry;
  hostActionBindings?: Record<string, SurfaceHostActionBinding>;
  hostControlBindings?: Record<string, SurfaceHostBinding>;
  hostSectionBindings?: Record<string, SurfaceHostSectionBinding>;
};

export type ProviderSettingsSurfacesContext = SpeechProviderSurfaceBindingsContext & {
  settingsProviders: LocalProviderSummary[];
};

const BUILT_IN_SPEECH_PROVIDER_SUMMARY = createProviderSummary({
  id: SPEECH_PROVIDER_FAMILY.id,
  title: SPEECH_PROVIDER_FAMILY.title,
  description: SPEECH_PROVIDER_FAMILY.description,
  kind: SPEECH_PROVIDER_FAMILY.kind,
  providerType: SPEECH_PROVIDER_FAMILY.providerType,
  transportProbeSupported: SPEECH_PROVIDER_FAMILY.transportProbeSupported,
  capabilityIds: [...SPEECH_PROVIDER_FAMILY.capabilityIds],
  toolAliases: SPEECH_PROVIDER_FAMILY.toolAliases,
  resourceAliases: SPEECH_PROVIDER_FAMILY.resourceAliases,
  manifest: SPEECH_PROVIDER_FAMILY.manifest,
});

function listSettingsShellSurfaceEntries(
  providers: Array<LocalProviderSummary | ReturnType<typeof createProviderSummary> | null | undefined>,
  excludeProviderIds: string[] = [],
) {
  const results: ProviderHostSurfaceEntry[] = [];
  const seenKeys = new Set<string>();

  for (const provider of providers) {
    if (!provider) {
      continue;
    }
    for (const surfaceId of ["settings_card", "status_card"] as const) {
      const entry =
        listProviderShellSurfaceEntries([provider], {
          surfaceIds: [surfaceId],
          excludeProviderIds,
        })[0] ?? null;
      if (!entry) {
        continue;
      }
      const key = `${entry.provider.id}:${entry.surface.surface}`;
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);
      results.push(entry);
    }
  }

  return results;
}

function buildSpeechProviderSettingsEntries(
  context: ProviderSettingsSurfacesContext,
): ProviderSettingsSurfaceEntry[] {
  const speechProvider =
    context.settingsProviders.find((provider) => provider.id === SPEECH_PROVIDER_ID) ??
    BUILT_IN_SPEECH_PROVIDER_SUMMARY;
  const speechBindings = createSpeechProviderShellBindings(context);

  return listSettingsShellSurfaceEntries([speechProvider]).map((entry) => ({
    key: `${entry.provider.id}:${entry.surface.surface}`,
    familyId: entry.familyId,
    providerId: entry.provider.id,
    entry,
    hostActionBindings: speechBindings.hostActionBindings,
    hostControlBindings: speechBindings.hostControlBindings,
    hostSectionBindings: speechBindings.hostSectionBindings,
  }));
}

function buildManifestSurfaceEntries(
  manifestSurfaceEntries: ProviderHostSurfaceEntry[],
): ProviderSettingsSurfaceEntry[] {
  return manifestSurfaceEntries.map((entry) => ({
    key: `${entry.provider.id}:${entry.surface.surface}`,
    familyId: entry.familyId,
    providerId: entry.provider.id,
    entry,
  }));
}

export function listProviderSettingsSurfaceEntries(
  context: ProviderSettingsSurfacesContext,
): ProviderSettingsSurfaceEntry[] {
  const speechEntries = buildSpeechProviderSettingsEntries(context);
  const manifestEntries = buildManifestSurfaceEntries(
    listSettingsShellSurfaceEntries(context.settingsProviders, [SPEECH_PROVIDER_ID]),
  );

  return [...speechEntries, ...manifestEntries];
}
