import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  createProviderSummary,
  createProviderUiSurfacePolicy,
} from "@instafy/provider-contract";
import type { ProviderHostSurfaceEntry } from "../../../../providers/providerHostSurfaces";
import { ProviderHostSurfaceCard } from "../ProviderHostSurfaceCard";

function createEntry(
  overrides: Partial<ProviderHostSurfaceEntry> = {},
): ProviderHostSurfaceEntry {
  return {
    familyId: "camera",
    provider: createProviderSummary({
      id: "camera",
      title: "Camera",
      providerType: "phone_camera",
      capabilityIds: ["camera_observation"],
      manifest: {
        familyId: "camera",
      },
    }),
    surface: {
      surface: "status_card",
      title: "Camera status",
      description: "Current camera setup for this space.",
    },
    ...overrides,
  };
}

describe("ProviderHostSurfaceCard", () => {
  it("renders structured highlights, facts, and action hints from manifest metadata", () => {
    const html = renderToStaticMarkup(
      <ProviderHostSurfaceCard
        entry={createEntry({
          surface: {
            surface: "status_card",
            title: "Camera status",
            description: "Current camera setup for this space.",
            capabilityIds: ["camera_observation"],
            metadata: {
              kind: "sensor",
              policy: createProviderUiSurfacePolicy({
                trustLevel: "first_party",
                renderMode: "host_declarative",
              }),
              elements: [
                {
                  element: "highlights",
                  items: ["Native phone capture", "Per-space attachment"],
                },
                {
                  element: "facts",
                  facts: [
                    {
                      label: "Capture modes",
                      value: "Single photo or guided series",
                    },
                    {
                      label: "Runtime",
                      value: "Phone camera on the attached device",
                    },
                  ],
                },
                {
                  element: "section",
                  title: "Setup",
                  items: [
                    "Attach a camera-capable device to this space.",
                    "Grant native camera permission on the attached device.",
                  ],
                },
                {
                  element: "controls",
                  controls: [
                    {
                      kind: "select",
                      label: "Capture source",
                      description: "Choose where this space should capture photos from.",
                      placeholder: "Attached device",
                      options: [
                        { label: "Attached device", value: "attached-device" },
                        { label: "Desktop webcam", value: "desktop-webcam" },
                      ],
                    },
                    {
                      kind: "toggle",
                      label: "Guided capture",
                      description: "Prompt the attached device for multi-step photo capture.",
                      value: true,
                      disabled: true,
                    },
                  ],
                },
                {
                  element: "hint",
                  text: "Attach a device in Extensions to start capturing photos for this space.",
                },
              ],
            },
          },
        })}
      />,
    );

    expect(html).toContain("Camera status");
    expect(html).toContain("Native phone capture");
    expect(html).toContain("Per-space attachment");
    expect(html).toContain("Capture modes");
    expect(html).toContain("Single photo or guided series");
    expect(html).toContain("Runtime");
    expect(html).toContain("Phone camera on the attached device");
    expect(html).toContain("Setup");
    expect(html).toContain("Attach a camera-capable device to this space.");
    expect(html).toContain("Grant native camera permission on the attached device.");
    expect(html).toContain("Capture source");
    expect(html).toContain("Choose where this space should capture photos from.");
    expect(html).toContain("Attached device");
    expect(html).toContain("Guided capture");
    expect(html).toContain("Prompt the attached device for multi-step photo capture.");
    expect(html).toContain("checked=\"\"");
    expect(html).toContain("Host-managed");
    expect(html).toContain("Attach a device in Extensions to start capturing photos for this space.");
    expect(html).not.toContain("phone_camera");
    expect(html).not.toContain("camera_observation");
    expect(html).not.toContain("Settings card");
    expect(html).not.toContain("Status card");
    expect(html).not.toContain("Provider: Camera · Type phone_camera · Capabilities camera_observation");
  });

  it("falls back to provider summary details when no structured metadata exists", () => {
    const html = renderToStaticMarkup(<ProviderHostSurfaceCard entry={createEntry()} />);

    expect(html).toContain("Provider");
    expect(html).toContain("Camera");
    expect(html).toContain("Type");
    expect(html).toContain("phone_camera");
    expect(html).toContain("Capabilities");
    expect(html).toContain("camera_observation");
  });

  it("renders host-bound diagnostic sections on top of manifest-declared section slots", () => {
    const html = renderToStaticMarkup(
      <ProviderHostSurfaceCard
        entry={createEntry({
          surface: {
            surface: "settings_card",
            title: "Speech provider",
            description: "Configure speech for this space.",
            metadata: {
              policy: createProviderUiSurfacePolicy({
                trustLevel: "first_party",
                renderMode: "host_declarative",
              }),
              elements: [
                {
                  element: "section",
                  title: "Current connection",
                  binding: {
                    hostBindingId: "speech_connection",
                  },
                },
              ],
            },
          },
        })}
        hostSectionBindings={{
          speech_connection: {
            description: "Speech provider is reachable on this machine and ready for transcription and reply playback.",
            facts: [
              { label: "Route", value: "Direct route" },
              { label: "Provider host", value: "Mac desktop host" },
            ],
            items: ["Device speech remains available if the hosted route goes down."],
          },
        }}
      />,
    );

    expect(html).toContain("Current connection");
    expect(html).toContain("Speech provider is reachable on this machine and ready for transcription and reply playback.");
    expect(html).toContain("Route");
    expect(html).toContain("Direct route");
    expect(html).toContain("Provider host");
    expect(html).toContain("Mac desktop host");
    expect(html).toContain("Device speech remains available if the hosted route goes down.");
    expect(html).not.toContain("Capabilities");
  });

  it("renders declarative host-bound actions from the generic provider surface", () => {
    const html = renderToStaticMarkup(
      <ProviderHostSurfaceCard
        entry={createEntry({
          surface: {
            surface: "settings_card",
            title: "Speech provider",
            description: "Configure speech for this space.",
            metadata: {
              policy: createProviderUiSurfacePolicy({
                trustLevel: "first_party",
                renderMode: "host_declarative",
              }),
              elements: [
                {
                  element: "actions",
                  actions: [
                    {
                      label: "Desktop host",
                      variant: "primary",
                      binding: {
                        hostBindingId: "desktop_voice_host_toggle",
                      },
                    },
                  ],
                },
              ],
            },
          },
        })}
        hostActionBindings={{
          desktop_voice_host_toggle: {
            label: "Enable on this Mac",
            description: "Desktop voice hosting is currently off on this Mac.",
            onPress: () => undefined,
          },
        }}
      />,
    );

    expect(html).toContain("Desktop host");
    expect(html).toContain("Enable on this Mac");
    expect(html).toContain("Desktop voice hosting is currently off on this Mac.");
  });

  it("renders declarative provider UI from canonical elements only", () => {
    const html = renderToStaticMarkup(
      <ProviderHostSurfaceCard
        entry={createEntry({
          surface: {
            surface: "detail_view",
            title: "Demo diagnostics",
            description: "Inspect the attached Demo runtime.",
            metadata: {
              policy: createProviderUiSurfacePolicy({
                trustLevel: "first_party",
                renderMode: "host_declarative",
              }),
              elements: [
                {
                  element: "highlights",
                  items: ["BLE runtime", "Per-space attachment"],
                },
                {
                  element: "facts",
                  facts: [
                    {
                      label: "Transport",
                      value: "Bluetooth Low Energy",
                    },
                  ],
                },
                {
                  element: "section",
                  title: "Current runtime",
                  binding: {
                    hostBindingId: "demo_runtime",
                  },
                },
                {
                  element: "controls",
                  controls: [
                    {
                      kind: "toggle",
                      label: "Background scanning",
                      description: "Keep scanning for nearby boards between sessions.",
                      value: true,
                      disabled: true,
                    },
                  ],
                },
                {
                  element: "actions",
                  actions: [
                    {
                      label: "Attachment",
                      binding: {
                        hostBindingId: "demo_attachment",
                      },
                    },
                  ],
                },
                {
                  element: "hint",
                  text: "Use the native setup panel for device pairing and BLE recovery.",
                },
              ],
            },
          },
        })}
        hostSectionBindings={{
          demo_runtime: {
            facts: [{ label: "Status", value: "Ready on this Mac" }],
          },
        }}
        hostActionBindings={{
          demo_attachment: {
            label: "Detach device",
            description: "This board is currently attached to the space.",
            onPress: () => undefined,
          },
        }}
      />,
    );

    expect(html).toContain("BLE runtime");
    expect(html).toContain("Per-space attachment");
    expect(html).toContain("Transport");
    expect(html).toContain("Bluetooth Low Energy");
    expect(html).toContain("Current runtime");
    expect(html).toContain("Status");
    expect(html).toContain("Ready on this Mac");
    expect(html).toContain("Background scanning");
    expect(html).toContain("Keep scanning for nearby boards between sessions.");
    expect(html).toContain("Attachment");
    expect(html).toContain("Detach device");
    expect(html).toContain("This board is currently attached to the space.");
    expect(html).toContain("Use the native setup panel for device pairing and BLE recovery.");
    expect(html).not.toContain("Legacy highlight should not render");
    expect(html).not.toContain("Legacy hint should not render.");
  });

  it("does not apply host bindings when the surface policy is untrusted or sandboxed", () => {
    const html = renderToStaticMarkup(
      <ProviderHostSurfaceCard
        entry={createEntry({
          surface: {
            surface: "detail_view",
            title: "External provider",
            description: "Third-party surface",
            metadata: {
              policy: createProviderUiSurfacePolicy({
                trustLevel: "untrusted",
                renderMode: "sandboxed",
              }),
              elements: [
                {
                  element: "actions",
                  actions: [
                    {
                      label: "Desktop host",
                      binding: {
                        hostBindingId: "desktop_voice_host_toggle",
                      },
                    },
                  ],
                },
                {
                  element: "section",
                  title: "Current connection",
                  binding: {
                    hostBindingId: "speech_connection",
                  },
                },
              ],
            },
          },
        })}
        hostActionBindings={{
          desktop_voice_host_toggle: {
            label: "Enable on this Mac",
            description: "Desktop voice hosting is currently off on this Mac.",
            onPress: () => undefined,
          },
        }}
        hostSectionBindings={{
          speech_connection: {
            description: "Speech provider is reachable on this machine.",
            facts: [{ label: "Route", value: "Direct route" }],
          },
        }}
      />,
    );

    expect(html).toContain("External provider");
    expect(html).toContain("Desktop host");
    expect(html).not.toContain("Enable on this Mac");
    expect(html).not.toContain("Speech provider is reachable on this machine.");
    expect(html).not.toContain("Route");
    expect(html).not.toContain("Direct route");
  });
});
