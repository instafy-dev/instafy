import type {
  ProviderHostSurfaceContribution,
  ProviderHostSurfaceId,
  ProviderSummary,
  ProviderUiSurfaceRenderMode,
  ProviderUiSurfaceSandboxContainer,
  ProviderUiSurfaceTrustLevel,
} from "@instafy/provider-contract";

export type SettingsProviderHostSurfaceId = "settings_card" | "status_card";
export type ExtensionProviderHostSurfaceId = "detail_view" | "status_card" | "extension_tile";
export type ProviderHostSurfaceSelectionId =
  | SettingsProviderHostSurfaceId
  | ExtensionProviderHostSurfaceId
  | ProviderHostSurfaceId;

export type ProviderHostSurfaceEntry = {
  provider: ProviderSummary;
  familyId: string;
  surface: ProviderHostSurfaceContribution;
};

export type ProviderHostSurfaceResolvedPolicy = {
  trustLevel: ProviderUiSurfaceTrustLevel;
  renderMode: ProviderUiSurfaceRenderMode;
  allowHostBindings: boolean;
};

export type ProviderHostSurfaceSandboxDescriptor = ProviderUiSurfaceSandboxContainer;

export type ProviderHostSurfaceSelectionOptions = {
  surfaceIds?: ProviderHostSurfaceSelectionId[];
  excludeProviderIds?: string[];
  includeSandboxed?: boolean;
};

export function normalizeString(value: string | null | undefined) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeProviderHostSurfaceId(
  value: ProviderHostSurfaceId | string | null | undefined,
) {
  return normalizeString(typeof value === "string" ? value : null).toLowerCase();
}
