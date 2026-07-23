import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ExtensionsPanelRow } from "../ExtensionsPanelRow";

function createRowController() {
  return {
    refreshLocalProviders: vi.fn().mockResolvedValue(undefined),
    extensionActions: {
      handleRememberProviderDevice: vi.fn(),
      handleForgetProviderDevice: vi.fn(),
      handleRuntimeProbe: vi.fn(),
      handleRuntimeStatusChange: vi.fn(),
      handleAuxiliaryStatusChange: vi.fn(),
      handlePersistCameraState: vi.fn(),
      handleCameraStatusChange: vi.fn(),
      handleAttachEntry: vi.fn(),
      handleDetachEntry: vi.fn(),
      handleMakeCameraFamilyDefault: vi.fn(),
    } as never,
    onToggleDetails: vi.fn(),
    onMakeDefaultCameraProvider: vi.fn(),
  };
}

describe("ExtensionsPanelRow", () => {
  it("renders an assembled extension row with actions and developer details", () => {
    const entry = {
      provider: {
        id: "camera:pixel-test",
        title: "Kitchen camera",
        capabilityIds: ["camera_observation"],
        discoverable: true,
        manifest: {
          familyId: "camera",
          hostSurfaces: [
            {
              surface: "detail_view",
              title: "Kitchen camera setup",
              description: "Use the shared provider surface path for extension details.",
              metadata: {
                policy: {
                  trustLevel: "first_party",
                  renderMode: "host_declarative",
                },
                elements: [
                  {
                    element: "section",
                    title: "Setup",
                    items: ["Attach a device and grant camera permission."],
                  },
                ],
              },
            },
          ],
        },
      },
      source: "host",
      integration: null,
      mutationProviderId: "camera:pixel-test",
      discoverable: true,
      attached: false,
      selectedDevice: null,
      cameraState: {
        selectedLens: null,
        lastCapture: null,
        updatedAt: null,
      },
      assistantDefinitions: [{ mentionToken: "@camera" }],
      capabilityIds: ["camera_observation"],
      providerCapabilityIds: ["camera_observation"],
      attachedCapabilityIds: ["camera_observation"],
    } as never;

    const html = renderToStaticMarkup(
      <ExtensionsPanelRow
        entry={entry}
        activeProjectName="Kitchen"
        pendingProviderId={null}
        showDeveloperDetails
        expanded
        currentNativeCameraStatus={null}
        nativeRuntimeStatusByProvider={{}}
        nativeAuxiliaryStatusByProvider={{}}
        nativeCameraHealthStateByProvider={{}}
        remoteCameraRequestsByProvider={{}}
        remoteCameraDevicesByProvider={{}}
        attachedExtensionFamilyCounts={new Map()}
        cameraAttachedDeviceItems={[]}
        rowController={createRowController()}
      />,
    );

    expect(html).toContain("Camera");
    expect(html).toContain("Attach");
    expect(html).toContain("aria-label=\"Collapse Camera\"");
    expect(html).not.toContain(">Close</button>");
    expect(html).toContain("Eligible assistants: @camera");
    expect(html).toContain("Discovered capabilities");
    expect(html).toContain("Kitchen camera setup");
    expect(html).toContain("Attach a device and grant camera permission.");
    expect(html).not.toContain("project-provider-diagnostics-toggle-camera:pixel-test");
    expect(html).toContain("project-provider-diagnostics-panel-camera:pixel-test");
    expect(html).toContain("Refresh discovery");
  });

  it("renders built-in extension surfaces with dynamic attachment and runtime sections", () => {
    const entry = {
      provider: {
        id: "camera:pixel-test",
        title: "Kitchen camera",
        capabilityIds: ["camera_observation"],
        discoverable: true,
      },
      source: "host",
      integration: null,
      mutationProviderId: "camera:pixel-test",
      discoverable: true,
      attached: true,
      selectedDevice: null,
      cameraState: {
        selectedLens: null,
        lastCapture: null,
        updatedAt: null,
      },
      assistantDefinitions: [],
      capabilityIds: ["camera_observation"],
      providerCapabilityIds: ["camera_observation"],
      attachedCapabilityIds: ["camera_observation"],
    } as never;

    const html = renderToStaticMarkup(
      <ExtensionsPanelRow
        entry={entry}
        activeProjectName="Kitchen"
        pendingProviderId={null}
        showDeveloperDetails={false}
        expanded
        currentNativeCameraStatus={null}
        nativeRuntimeStatusByProvider={{}}
        nativeAuxiliaryStatusByProvider={{}}
        nativeCameraHealthStateByProvider={{}}
        remoteCameraRequestsByProvider={{}}
        remoteCameraDevicesByProvider={{}}
        attachedExtensionFamilyCounts={new Map()}
        cameraAttachedDeviceItems={[]}
        rowController={createRowController()}
      />,
    );

    expect(html).toContain("Current attachment");
    expect(html).toContain("aria-label=\"Attached\"");
    expect(html).not.toContain("Needs setup");
    expect(html).toContain("Attached");
    expect(html).toContain("Current runtime");
    expect(html).toContain("Available locally.");
    expect(
      html.match(/Available locally\./g)?.length ?? 0,
    ).toBe(1);
    expect(html).not.toContain("project-provider-health-camera:pixel-test");
    expect(html).toContain("Available");
    expect(html).toContain("Attachment");
    expect(html).toContain("Detach");
  });

  it("keeps the runtime summary in collapsed rows", () => {
    const entry = {
      provider: {
        id: "camera:pixel-test",
        title: "Kitchen camera",
        capabilityIds: ["camera_observation"],
        discoverable: true,
      },
      source: "host",
      integration: null,
      mutationProviderId: "camera:pixel-test",
      discoverable: true,
      attached: true,
      selectedDevice: null,
      cameraState: {
        selectedLens: null,
        lastCapture: null,
        updatedAt: null,
      },
      assistantDefinitions: [],
      capabilityIds: ["camera_observation"],
      providerCapabilityIds: ["camera_observation"],
      attachedCapabilityIds: ["camera_observation"],
    } as never;

    const html = renderToStaticMarkup(
      <ExtensionsPanelRow
        entry={entry}
        activeProjectName="Kitchen"
        pendingProviderId={null}
        showDeveloperDetails={false}
        expanded={false}
        currentNativeCameraStatus={null}
        nativeRuntimeStatusByProvider={{}}
        nativeAuxiliaryStatusByProvider={{}}
        nativeCameraHealthStateByProvider={{}}
        remoteCameraRequestsByProvider={{}}
        remoteCameraDevicesByProvider={{}}
        attachedExtensionFamilyCounts={new Map()}
        cameraAttachedDeviceItems={[]}
        rowController={createRowController()}
      />,
    );

    expect(html).toContain("project-provider-health-camera:pixel-test");
    expect(html).not.toContain("Current runtime");
  });

  it("keeps the attached native setup shell focused while its panel loads", () => {
    const entry = {
      provider: {
        id: "camera:pixel-test",
        title: "Kitchen camera",
        capabilityIds: ["camera_observation"],
        discoverable: true,
      },
      source: "native_runtime",
      integration: null,
      mutationProviderId: "camera:pixel-test",
      discoverable: true,
      attached: true,
      selectedDevice: null,
      cameraState: {
        selectedLens: null,
        lastCapture: null,
        updatedAt: null,
      },
      assistantDefinitions: [],
      capabilityIds: ["camera_observation"],
      providerCapabilityIds: ["camera_observation"],
      attachedCapabilityIds: ["camera_observation"],
    } as never;

    const html = renderToStaticMarkup(
      <ExtensionsPanelRow
        entry={entry}
        activeProjectName="Kitchen"
        pendingProviderId={null}
        showDeveloperDetails={false}
        expanded
        currentNativeCameraStatus={null}
        nativeRuntimeStatusByProvider={{}}
        nativeAuxiliaryStatusByProvider={{}}
        nativeCameraHealthStateByProvider={{}}
        remoteCameraRequestsByProvider={{}}
        remoteCameraDevicesByProvider={{}}
        attachedExtensionFamilyCounts={new Map()}
        cameraAttachedDeviceItems={[]}
        rowController={createRowController()}
      />,
    );

    expect(html).toContain('data-testid="project-provider-details-camera:pixel-test"');
    expect(html).toContain("Needs setup");
    expect(html).not.toContain("Access blocked");
    expect(html).not.toContain("Attach a camera-capable device to this space.");
    expect(html).not.toContain("Grant native camera permission on the attached device.");
    expect(html).not.toContain("Saved setup");
    expect(html).not.toContain("Attachment");
    expect(html).not.toContain("Detach Camera");
    expect(html).not.toContain("Developer details");
  });

  it("renders a deferred provider-surface notice for sandboxed extension details", () => {
    const entry = {
      provider: {
        id: "demo:board-test",
        title: "Demo board",
        capabilityIds: ["robot_control"],
        discoverable: true,
        manifest: {
          familyId: "demo",
          hostSurfaces: [
            {
              surface: "detail_view",
              title: "Demo remote console",
              metadata: {
                policy: {
                  trustLevel: "untrusted",
                  renderMode: "sandboxed",
                },
              },
            },
          ],
        },
      },
      source: "host",
      integration: null,
      mutationProviderId: "demo:board-test",
      discoverable: true,
      attached: false,
      selectedDevice: null,
      cameraState: {
        selectedLens: null,
        lastCapture: null,
        updatedAt: null,
      },
      assistantDefinitions: [],
      capabilityIds: ["robot_control"],
      providerCapabilityIds: ["robot_control"],
      attachedCapabilityIds: ["robot_control"],
    } as never;

    const html = renderToStaticMarkup(
      <ExtensionsPanelRow
        entry={entry}
        activeProjectName="Kitchen"
        pendingProviderId={null}
        showDeveloperDetails={false}
        expanded
        currentNativeCameraStatus={null}
        nativeRuntimeStatusByProvider={{}}
        nativeAuxiliaryStatusByProvider={{}}
        nativeCameraHealthStateByProvider={{}}
        remoteCameraRequestsByProvider={{}}
        remoteCameraDevicesByProvider={{}}
        attachedExtensionFamilyCounts={new Map()}
        cameraAttachedDeviceItems={[]}
        rowController={createRowController()}
      />,
    );

    expect(html).toContain("Demo remote console");
    expect(html).toContain("isolated provider UI container");
    expect(html).toContain("sandboxed");
  });
});
