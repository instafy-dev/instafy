import { resolveExtensionFamilyInstanceTitle } from "./extensionFamilyUiRegistry";
import type { NativeExtensionRegistration } from "./nativeExtensionTypes";
import {
  resolveExtensionAttachActionLabel,
  resolveExtensionDetailsActionLabel,
  resolveExtensionDetachActionLabel,
  resolveExtensionDisplayState,
  resolveExtensionFallbackSummary,
  resolveExtensionStatusPresentation,
  type ExtensionDisplayState,
  type ExtensionPresentationSource,
  type ExtensionStatusTone,
} from "./extensionPresentation";

type NativeExtensionActionRegistration = Pick<
  NativeExtensionRegistration,
  | "formatAttachButtonLabel"
  | "formatAttachButtonVariant"
  | "formatDetachButtonLabel"
  | "formatDetailsButtonLabel"
>;

export type ExtensionRowPresentation = {
  hasSummaryLine: boolean;
  hasExpandableDetails: boolean;
  detailsExpanded: boolean;
  providerTitle: string;
  extensionState: ExtensionDisplayState;
  statusLabel: string;
  statusTone: ExtensionStatusTone;
  detailsButtonLabel: string;
  fallbackSummary: string;
  attachLabel: string;
  attachVariant: "primary" | "outline";
  detachLabel: string;
};

export function resolveExtensionRowPresentation(input: {
  attached: boolean;
  discoverable: boolean;
  discoveryError?: string | null;
  source: ExtensionPresentationSource;
  isPending: boolean;
  activeRequestState?: "pending" | "in_progress" | null;
  needsSetup: boolean;
  attachedRemoteOnly: boolean;
  remoteStatus?: "ready" | "permission" | "issue" | "offline" | null;
  scopeLabel?: string | null;
  providerId: string;
  providerTitle: string;
  attachedFamilyCount: number;
  remoteDeviceLabel?: string | null;
  selectedDeviceLabel?: string | null;
  nativeExtension: NativeExtensionActionRegistration | null;
  hasNativeSetup: boolean;
  hasProviderHostSurface?: boolean;
  showDeveloperDetails: boolean;
  integrationPresent: boolean;
  kindLabel?: string | null;
  savedNativeStateLabel?: string | null;
  expanded: boolean;
}) : ExtensionRowPresentation {
  const hasHostDeveloperPanel = input.source === "host" && input.showDeveloperDetails;
  const hasSummaryLine =
    input.source === "host" ||
    (input.nativeExtension !== null && input.hasNativeSetup) ||
    Boolean(input.savedNativeStateLabel);
  const hasExpandableDetails =
    Boolean(input.hasProviderHostSurface) ||
    input.hasNativeSetup ||
    hasHostDeveloperPanel ||
    Boolean(input.savedNativeStateLabel) ||
    Boolean(input.discoveryError) ||
    Boolean(input.showDeveloperDetails && (input.integrationPresent || input.kindLabel));
  const detailsExpanded = hasExpandableDetails && input.expanded;
  const providerTitle = resolveExtensionFamilyInstanceTitle({
    providerId: input.providerId,
    title: input.providerTitle,
    attachedFamilyCount: input.attachedFamilyCount,
    remoteDeviceLabel: input.remoteDeviceLabel ?? null,
    selectedDeviceLabel: input.selectedDeviceLabel ?? null,
  });
  const extensionState = resolveExtensionDisplayState({
    attached: input.attached,
    discoverable: input.discoverable,
    hasDiscoveryError: Boolean(input.discoveryError),
    isPending: input.isPending,
    activeRequestState: input.activeRequestState ?? null,
    needsSetup: input.needsSetup,
    attachedRemote: input.attachedRemoteOnly,
    remoteStatus: input.remoteStatus ?? null,
    source: input.source,
  });
  const status = resolveExtensionStatusPresentation(extensionState);
  const detailsButtonLabel = input.nativeExtension
    ? input.nativeExtension.formatDetailsButtonLabel({
        attached: input.attached,
        expanded: detailsExpanded,
        hasManageSurface: input.hasNativeSetup,
        needsSetup: input.needsSetup,
      })
    : resolveExtensionDetailsActionLabel({
        attached: input.attached,
        expanded: detailsExpanded,
        hasManageSurface: input.hasNativeSetup,
        needsSetup: input.needsSetup,
      });
  const fallbackSummary = resolveExtensionFallbackSummary({
    scopeLabel: input.scopeLabel,
    source: input.source,
    state: extensionState,
  });
  const attachLabel = input.nativeExtension
    ? input.nativeExtension.formatAttachButtonLabel(input.isPending, input.source)
    : resolveExtensionAttachActionLabel({
        isPending: input.isPending,
        useDeviceLanguage: false,
      });
  const attachVariant = input.nativeExtension
    ? input.nativeExtension.formatAttachButtonVariant(input.source)
    : "outline";
  const detachLabel = input.nativeExtension
    ? input.nativeExtension.formatDetachButtonLabel(input.isPending, input.source)
    : resolveExtensionDetachActionLabel({
        isPending: input.isPending,
        useDeviceLanguage: false,
      });

  return {
    hasSummaryLine,
    hasExpandableDetails,
    detailsExpanded,
    providerTitle,
    extensionState,
    statusLabel: status.label,
    statusTone: status.tone,
    detailsButtonLabel,
    fallbackSummary,
    attachLabel,
    attachVariant,
    detachLabel,
  };
}
