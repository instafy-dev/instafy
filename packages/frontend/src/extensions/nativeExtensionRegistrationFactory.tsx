import { useEffect, useState } from "react";
import type { BuiltInProviderFamilyDefinition } from "@instafy/provider-contract/builtins";
import { Text } from "../components/Text";
import type { ProjectProviderSelectedDevice } from "../capabilities/projectProviderAccess";
import {
  resolveExtensionDefinition,
} from "./extensionCatalog";
import type {
  NativeExtensionEntrySource,
  NativeExtensionRegistration,
  NativeExtensionSetupPanelProps,
  NativeExtensionSummary,
} from "./nativeExtensionTypes";

type NativeExtensionRegistrationFactoryInput = {
  family: BuiltInProviderFamilyDefinition;
  formatSavedStateLabel?: (input: {
    selectedDevice: ProjectProviderSelectedDevice | null;
    cameraState: NativeExtensionSetupPanelProps["cameraState"];
  }) => string | null;
  summarize: NativeExtensionRegistration["summarize"];
  renderSummary: NativeExtensionRegistration["renderSummary"];
  renderSetupPanel: NativeExtensionRegistration["renderSetupPanel"];
  formatDefaultCaption?: NativeExtensionRegistration["formatDefaultCaption"];
  runRuntimeProbe?: NativeExtensionRegistration["runRuntimeProbe"];
};

function getNativeRuntimeUiDefinition(family: BuiltInProviderFamilyDefinition) {
  return family.extension?.nativeRuntimeUi ?? null;
}

function formatNativeRuntimeUiTemplate(
  template: string,
  input: { scopeLabel: string },
) {
  return template.replaceAll("{scopeLabel}", input.scopeLabel);
}

function formatNativeExtensionStateLabel(
  family: BuiltInProviderFamilyDefinition,
  input: {
    source: NativeExtensionEntrySource;
    attached: boolean;
    projectName?: string | null;
  },
) {
  const nativeRuntimeUi = getNativeRuntimeUiDefinition(family);
  if (!nativeRuntimeUi) {
    const scopeLabel = input.projectName ?? "this space";
    return input.attached ? `Attached for ${scopeLabel}.` : "Saved.";
  }
  const scopeLabel = input.projectName ?? "this space";
  const template =
    input.source === "native_runtime"
      ? input.attached
        ? nativeRuntimeUi.stateLabels.nativeAttached
        : nativeRuntimeUi.stateLabels.nativeDetached
      : input.attached
        ? nativeRuntimeUi.stateLabels.attached
        : nativeRuntimeUi.stateLabels.detached;
  return formatNativeRuntimeUiTemplate(template, { scopeLabel });
}

function formatNativeExtensionActionLabel(
  family: BuiltInProviderFamilyDefinition,
  action: "attach" | "detach",
  isPending: boolean,
  source: NativeExtensionEntrySource,
) {
  const nativeRuntimeUi = getNativeRuntimeUiDefinition(family);
  if (!nativeRuntimeUi) {
    return isPending
      ? action === "attach"
        ? "Attaching…"
        : "Detaching…"
      : action === "attach"
        ? "Attach"
        : "Detach";
  }
  const actionDefinition =
    action === "attach" ? nativeRuntimeUi.attachAction : nativeRuntimeUi.detachAction;
  if (source === "native_runtime") {
    return isPending
      ? actionDefinition.nativeRuntimePendingLabel ?? actionDefinition.pendingLabel
      : actionDefinition.nativeRuntimeLabel ?? actionDefinition.label;
  }
  return isPending ? actionDefinition.pendingLabel : actionDefinition.label;
}

function formatNativeExtensionAttachButtonVariant(
  family: BuiltInProviderFamilyDefinition,
  source: NativeExtensionEntrySource,
) {
  if (source !== "native_runtime") {
    return "outline" as const;
  }
  return getNativeRuntimeUiDefinition(family)?.attachAction.nativeRuntimeVariant ?? "outline";
}

export function formatSelectedDeviceLabel(
  selectedDevice: ProjectProviderSelectedDevice | null,
) {
  if (!selectedDevice) {
    return "No device saved yet.";
  }
  const name = selectedDevice.name?.trim();
  const address = selectedDevice.address?.trim() || selectedDevice.identifier?.trim() || "";
  return name ? `${name}${address ? ` (${address})` : ""}` : address || "Saved device";
}

export function formatSavedNativeDeviceValue(
  selectedDevice: ProjectProviderSelectedDevice | null,
) {
  if (!selectedDevice) {
    return null;
  }
  return formatSelectedDeviceLabel(selectedDevice);
}

export function formatSavedNativeDeviceLabel(
  family: BuiltInProviderFamilyDefinition,
  selectedDevice: ProjectProviderSelectedDevice | null,
) {
  const deviceValue = formatSavedNativeDeviceValue(selectedDevice);
  if (!deviceValue) {
    return null;
  }
  const labelPrefix = getNativeRuntimeUiDefinition(family)?.savedDeviceLabel ?? "Saved device";
  return `${labelPrefix}: ${deviceValue}`;
}

function formatNativeExtensionDetailsButtonLabel(
  family: BuiltInProviderFamilyDefinition,
  input: {
    attached: boolean;
    expanded: boolean;
    hasManageSurface: boolean;
    needsSetup?: boolean;
  },
) {
  const detailsAction = getNativeRuntimeUiDefinition(family)?.detailsAction;
  if (!detailsAction) {
    if (input.expanded) {
      return "Close";
    }
    if (input.hasManageSurface) {
      return input.attached && !input.needsSetup ? "Manage" : "Setup";
    }
    return "Details";
  }
  if (input.expanded) {
    return detailsAction.hideLabel;
  }
  return input.attached && !input.needsSetup ? detailsAction.manageLabel : detailsAction.setupLabel;
}

function formatHealthFreshnessLabel(checkedAt: string | null | undefined, nowMs: number) {
  if (!checkedAt) {
    return null;
  }
  const checkedMs = Date.parse(checkedAt);
  if (Number.isNaN(checkedMs)) {
    return null;
  }
  const diffMs = Math.max(0, nowMs - checkedMs);
  if (diffMs < 15_000) {
    return "Checked just now.";
  }
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) {
    return "Checked under a minute ago.";
  }
  if (diffMinutes === 1) {
    return "Checked 1 minute ago.";
  }
  if (diffMinutes < 60) {
    return `Checked ${diffMinutes} minutes ago.`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours === 1) {
    return "Checked 1 hour ago.";
  }
  return `Checked ${diffHours} hours ago.`;
}

function useFreshnessClock() {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNowMs(Date.now());
    }, 30_000);

    return () => {
      window.clearInterval(interval);
    };
  }, []);

  return nowMs;
}

export function ExtensionHealthSummaryBlock({
  providerId,
  summary,
  checkedAt,
}: {
  providerId: string;
  summary: NativeExtensionSummary;
  checkedAt?: string | null;
}) {
  const nowMs = useFreshnessClock();
  const freshnessLabel = formatHealthFreshnessLabel(checkedAt, nowMs);
  return (
    <div className="space-y-1">
      <Text
        variant="body"
        tone={summary.tone}
        data-testid={`project-provider-health-${providerId}`}
        className="leading-5"
      >
        {summary.text}
      </Text>
      {freshnessLabel ? (
        <Text variant="caption" tone="subtle">
          {freshnessLabel}
        </Text>
      ) : null}
    </div>
  );
}

export function renderStaticExtensionHealthSummary(input: {
  providerId: string;
  checkedAt?: string | null;
  summary: NativeExtensionSummary;
}) {
  return (
    <ExtensionHealthSummaryBlock
      providerId={input.providerId}
      summary={input.summary}
      checkedAt={input.checkedAt}
    />
  );
}

export function createNativeExtensionRegistration(
  input: NativeExtensionRegistrationFactoryInput,
): NativeExtensionRegistration {
  return {
    definition: resolveExtensionDefinition({
      integrationProviderId: input.family.id,
    }),
    formatStateLabel(props) {
      return formatNativeExtensionStateLabel(input.family, props);
    },
    formatSavedStateLabel(props) {
      return input.formatSavedStateLabel
        ? input.formatSavedStateLabel(props)
        : formatSavedNativeDeviceLabel(input.family, props.selectedDevice);
    },
    formatAttachButtonLabel(isPending, source) {
      return formatNativeExtensionActionLabel(
        input.family,
        "attach",
        isPending,
        source,
      );
    },
    formatAttachButtonVariant(source) {
      return formatNativeExtensionAttachButtonVariant(input.family, source);
    },
    formatDetachButtonLabel(isPending, source) {
      return formatNativeExtensionActionLabel(
        input.family,
        "detach",
        isPending,
        source,
      );
    },
    formatDetailsButtonLabel(props) {
      return formatNativeExtensionDetailsButtonLabel(input.family, props);
    },
    formatDefaultCaption() {
      return input.formatDefaultCaption ? input.formatDefaultCaption() : null;
    },
    runRuntimeProbe: input.runRuntimeProbe,
    summarize: input.summarize,
    renderSummary: input.renderSummary,
    renderSetupPanel: input.renderSetupPanel,
  };
}
