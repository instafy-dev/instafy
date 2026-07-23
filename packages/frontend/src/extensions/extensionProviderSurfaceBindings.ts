import { formatProjectProviderSelectedDeviceLabel } from "../capabilities/projectProviderAccess";
import type { ExtensionsPanelRowModel } from "../screens/studio/components/extensionsPanelRowModel";
import type { SurfaceHostSectionBinding } from "../screens/studio/components/ProviderHostSurfaceCard";

type SurfaceFact = NonNullable<SurfaceHostSectionBinding["facts"]>[number];

function formatConnectionTypeLabel(connectionType: string) {
  switch (connectionType.trim().toLowerCase()) {
    case "native_runtime":
      return "Native provider";
    case "local_provider":
      return "Local provider";
    default:
      return connectionType.replaceAll("_", " ").trim() || "Local provider";
  }
}

function formatSelectedDevicePlatformLabel(model: ExtensionsPanelRowModel) {
  const selectedDevice = model.entry.selectedDevice;
  if (!selectedDevice) {
    return null;
  }
  if (selectedDevice.nativePlatform === "android") {
    return "Android";
  }
  if (selectedDevice.nativePlatform === "ios") {
    return "iPhone";
  }
  if (selectedDevice.transport.trim().toLowerCase() === "desktop_webcam") {
    return "Desktop";
  }
  return null;
}

function formatSourceLabel(model: ExtensionsPanelRowModel) {
  if (model.entry.source === "host") {
    return "Local provider";
  }
  if (model.entry.source === "native_runtime") {
    return "This device";
  }
  const remotePlatformLabel =
    model.remoteCameraPresentation?.deviceDetails?.platformLabel ??
    formatSelectedDevicePlatformLabel(model);
  if (remotePlatformLabel) {
    return remotePlatformLabel;
  }
  return formatConnectionTypeLabel(model.connectionType);
}

function formatSelectedDeviceValue(model: ExtensionsPanelRowModel) {
  const selectedDevice = model.entry.selectedDevice;
  if (!selectedDevice) {
    return null;
  }
  return selectedDevice.name?.trim() || formatProjectProviderSelectedDeviceLabel(selectedDevice);
}

function summarizeRuntimeStatus(model: ExtensionsPanelRowModel) {
  if (model.attachedRemoteOnlySummary) {
    return model.attachedRemoteOnlySummary;
  }
  if (model.nativeExtension && model.hasNativeSetup) {
    return model.nativeExtension
      .summarize({
        attached: model.entry.attached,
        selectedDevice: model.entry.selectedDevice,
        cameraState: model.entry.cameraState,
        runtimeStatus: model.runtimeStatus,
        auxiliaryStatus: model.auxiliaryStatus,
        cameraLiveStatus: model.cameraLiveStatus,
      })
      .text;
  }
  if (model.entry.source === "host") {
    return model.entry.discoverable
      ? "Available locally."
      : "Local provider unavailable.";
  }
  return null;
}

function buildAttachmentFacts(model: ExtensionsPanelRowModel): SurfaceFact[] {
  const facts: SurfaceFact[] = [
    {
      label: "Status",
      value:
        model.entry.source === "native_runtime" && model.entry.attached
          ? "Using this device"
          : model.entry.attached
            ? "Attached"
            : "Not attached",
    },
  ];
  if (model.entry.source !== "native_runtime") {
    facts.push({
      label: "Source",
      value: formatSourceLabel(model),
    });
  }
  const selectedDeviceValue = formatSelectedDeviceValue(model);
  if (selectedDeviceValue) {
    facts.push({
      label: "Device",
      value: selectedDeviceValue,
    });
  }
  if (model.isFamilyDefault) {
    facts.push({
      label: "Preference",
      value: "Default for new requests",
    });
  }
  return facts;
}

function buildRuntimeFacts(model: ExtensionsPanelRowModel): SurfaceFact[] {
  const facts: SurfaceFact[] = [];

  const remoteDeviceDetails = model.remoteCameraPresentation?.deviceDetails ?? null;
  if (remoteDeviceDetails?.platformLabel) {
    facts.push({
      label: "Platform",
      value: remoteDeviceDetails.platformLabel,
    });
  }
  if (remoteDeviceDetails?.presenceStatus) {
    facts.push({
      label: "Presence",
      value: remoteDeviceDetails.presenceStatus === "online" ? "Online" : "Offline",
    });
  }
  const remoteRequestSummary = model.remoteCameraPresentation?.requestSummary ?? null;
  if (remoteRequestSummary?.requestState) {
    facts.push({
      label: "Request",
      value: remoteRequestSummary.requestState.replaceAll("_", " "),
    });
  }
  if (model.entry.source === "host") {
    facts.push({
      label: "Available",
      value: model.entry.discoverable ? "Yes" : "No",
    });
  }

  return facts;
}

function shouldCollapseNativeRuntimeSections(model: ExtensionsPanelRowModel) {
  return model.hasNativeSetup && model.entry.source === "native_runtime" && model.entry.attached;
}

export function buildExtensionProviderHostSectionBindings(
  model: ExtensionsPanelRowModel,
): Record<string, SurfaceHostSectionBinding> {
  const runtimeDescription = summarizeRuntimeStatus(model);
  const runtimeFacts = buildRuntimeFacts(model);
  const collapseNativeRuntimeSections = shouldCollapseNativeRuntimeSections(model);

  return {
    extension_setup_guidance: {
      hidden: collapseNativeRuntimeSections,
    },
    extension_attachment_status: {
      facts: buildAttachmentFacts(model),
      hidden: collapseNativeRuntimeSections,
    },
    extension_runtime_status: {
      description: runtimeDescription ?? undefined,
      facts: runtimeFacts,
      hidden: collapseNativeRuntimeSections || (!runtimeDescription && runtimeFacts.length === 0),
    },
    extension_saved_state: {
      description: model.savedNativeStateLabel ?? undefined,
      hidden: collapseNativeRuntimeSections || !model.savedNativeStateLabel,
    },
    extension_issue_status: {
      description:
        !model.entry.discoverable && model.entry.provider.error
          ? `Discovery error: ${model.entry.provider.error}`
          : undefined,
      hidden: model.entry.discoverable || !model.entry.provider.error,
    },
  };
}
