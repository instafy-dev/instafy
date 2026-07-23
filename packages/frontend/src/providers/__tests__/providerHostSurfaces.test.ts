import { describe, expect, it, vi } from "vitest";
import {
  createProviderSummary,
  createProviderUiSurfaceElements,
  createProviderUiSurfaceExtensionAttachmentAction,
  createProviderUiSurfaceExtensionStatusSections,
  createProviderUiSurfaceFacts,
  createProviderUiSurfaceHighlights,
  createProviderUiSurfaceHint,
  createProviderUiSurfaceMetadata,
  createProviderUiSurfacePolicy,
  createProviderUiSurfaceSandboxContainer,
  createProviderUiSurfaceSection,
  createProviderUiSurfaceSpeechDesktopHostActions,
  createProviderUiSurfaceSpeechSettingsControls,
  createProviderUiSurfaceSpeechStatusControls,
} from "@instafy/provider-contract";
import type { ProviderSummary, ProviderUiSurfaceMetadata } from "@instafy/provider-contract";
import {
  CAMERA_PROVIDER_FAMILY,
  SPEECH_PROVIDER_FAMILY,
} from "@instafy/provider-contract/builtins";
import {
  listProviderShellSurfaceEntries,
  listProviderHostSurfaceControls,
  providerHostSurfaceHasActionBinding,
  providerHostSurfaceHasSectionBinding,
  resolveProviderHostSurfaceSandboxDescriptor,
  resolveProviderHostSurfacePolicy,
  resolveExtensionProviderShellSurfaceEntry,
} from "../providerHostSurfaces";

describe("providerHostSurfaces", () => {
  it("picks the first preferred settings shell surface from each provider manifest", () => {
    const providers = [
      createProviderSummary({
        id: "speech",
        title: "Speech",
        manifest: {
          familyId: "speech",
          hostSurfaces: [
            {
              surface: "settings_card",
              title: "Speech settings",
            },
            {
              surface: "status_card",
              title: "Speech status",
            },
          ],
        },
      }),
    ];

    const entries = listProviderShellSurfaceEntries(providers);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      familyId: "speech",
      provider: {
        id: "speech",
      },
      surface: {
        surface: "settings_card",
        title: "Speech settings",
      },
    });
  });

  it("excludes provider ids and ignores unsupported settings shell surfaces", () => {
    const providers = [
      createProviderSummary({
        id: "speech",
        title: "Speech",
        manifest: {
          familyId: "speech",
          hostSurfaces: [
            {
              surface: "settings_card",
              title: "Speech settings",
            },
          ],
        },
      }),
      createProviderSummary({
        id: "screen-share",
        title: "Screen Share",
        manifest: {
          familyId: "screen-share",
          hostSurfaces: [
            {
              surface: "extension_tile",
              title: "Screen Share",
            },
            {
              surface: "status_card",
              title: "Screen Share status",
            },
          ],
        },
      }),
    ];

    const entries = listProviderShellSurfaceEntries(providers, {
      excludeProviderIds: ["speech"],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      provider: {
        id: "screen-share",
      },
      surface: {
        surface: "status_card",
      },
    });
  });

  it("falls back to the next supported surface when the preferred one is missing", () => {
    const providers = [
      createProviderSummary({
        id: "camera",
        title: "Camera",
        manifest: {
          familyId: "camera",
          hostSurfaces: [
            {
              surface: "status_card",
              title: "Camera status",
            },
          ],
        },
      }),
    ];

    const entries = listProviderShellSurfaceEntries(providers, {
      surfaceIds: ["settings_card", "status_card"],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      provider: {
        id: "camera",
      },
      surface: {
        surface: "status_card",
        title: "Camera status",
      },
    });
  });

  it("prefers extension detail surfaces when selecting provider-backed extension shell details", () => {
    const provider = createProviderSummary({
      id: "demo:board-test",
      title: "Demo board",
      manifest: {
        familyId: "demo",
        hostSurfaces: [
          {
            surface: "extension_tile",
            title: "Demo tile",
          },
          {
            surface: "detail_view",
            title: "Demo diagnostics",
          },
        ],
      },
    });

    const entry = resolveExtensionProviderShellSurfaceEntry(provider);

    expect(entry).toMatchObject({
      familyId: "demo",
      surface: {
        surface: "detail_view",
        title: "Demo diagnostics",
      },
    });
  });

  it("keeps built-in Camera detail surfaces wired to the full extension status-section bundle", () => {
    const entry = resolveExtensionProviderShellSurfaceEntry(
      createProviderSummary({
        id: "camera",
        title: "Camera",
        providerType: "camera",
        capabilityIds: ["camera_observation"],
      }),
    );

    expect(entry).toBeTruthy();
    expect(providerHostSurfaceHasSectionBinding(entry, "extension_setup_guidance")).toBe(true);
    expect(providerHostSurfaceHasSectionBinding(entry, "extension_attachment_status")).toBe(true);
    expect(providerHostSurfaceHasSectionBinding(entry, "extension_runtime_status")).toBe(true);
    expect(providerHostSurfaceHasSectionBinding(entry, "extension_saved_state")).toBe(true);
    expect(providerHostSurfaceHasSectionBinding(entry, "extension_issue_status")).toBe(true);
  });

  it("keeps built-in Camera detail surfaces free of the old shell-vs-native guidance sections", () => {
    const cameraEntry = resolveExtensionProviderShellSurfaceEntry(
      createProviderSummary({
        id: "camera",
        title: "Camera",
        providerType: "camera",
        capabilityIds: ["camera_observation"],
      }),
    );

    const cameraSectionTitles =
      (cameraEntry?.surface.metadata?.elements ?? [])
        .filter((element) => element.element === "section")
        .map((element) => element.title) ?? [];

    expect(cameraSectionTitles).not.toContain("Inspect");
    expect(cameraSectionTitles).not.toContain("On-device actions");
  });

  it("prefers non-sandboxed extension detail surfaces in the generic shell", () => {
    const provider = createProviderSummary({
      id: "demo:board-test",
      title: "Demo board",
      manifest: {
        familyId: "demo",
        hostSurfaces: [
          {
            surface: "detail_view",
            title: "Sandboxed diagnostics",
            metadata: createProviderUiSurfaceMetadata({
              policy: createProviderUiSurfacePolicy({
                trustLevel: "untrusted",
                renderMode: "sandboxed",
              }),
            }),
          },
          {
            surface: "detail_view",
            title: "Host diagnostics",
            metadata: createProviderUiSurfaceMetadata({
              policy: createProviderUiSurfacePolicy({
                trustLevel: "local_trusted",
                renderMode: "host_declarative",
              }),
            }),
          },
        ],
      },
    });

    const entry = resolveExtensionProviderShellSurfaceEntry(provider);

    expect(entry).toMatchObject({
      surface: {
        surface: "detail_view",
        title: "Host diagnostics",
      },
    });
  });

  it("keeps sandboxed detail surfaces as fallback only when no declarative shell surface exists", () => {
    const provider = createProviderSummary({
      id: "camera:pixel-test",
      title: "Kitchen camera",
      manifest: {
        familyId: "camera",
        hostSurfaces: [
          {
            surface: "detail_view",
            title: "Sandboxed diagnostics",
            metadata: createProviderUiSurfaceMetadata({
              policy: createProviderUiSurfacePolicy({
                trustLevel: "untrusted",
                renderMode: "sandboxed",
              }),
            }),
          },
          {
            surface: "extension_tile",
            title: "Camera tile",
            metadata: createProviderUiSurfaceMetadata({
              policy: createProviderUiSurfacePolicy({
                trustLevel: "local_trusted",
                renderMode: "host_declarative",
              }),
            }),
          },
        ],
      },
    });

    const shellEntry = resolveExtensionProviderShellSurfaceEntry(provider);

    expect(shellEntry).toMatchObject({
      surface: {
        surface: "extension_tile",
        title: "Camera tile",
      },
    });
  });

  it("uses the simulated devices provider detail surface as a sandboxed extension shell entry with host actions", async () => {
    const { createLocalDeviceToggleProviderRegistration } = await vi.importActual<{
      createLocalDeviceToggleProviderRegistration: () => { summary: ProviderSummary };
    }>("../../../scripts/providers/local-device-toggle-provider.mjs");
    const registration = createLocalDeviceToggleProviderRegistration();

    const entry = resolveExtensionProviderShellSurfaceEntry(registration.summary);
    const sandbox = resolveProviderHostSurfaceSandboxDescriptor(entry);

    expect(entry).toMatchObject({
      provider: {
        id: "simulated-devices",
      },
      surface: {
        surface: "detail_view",
        title: "Simulated device details",
      },
    });
    expect(providerHostSurfaceHasActionBinding(entry, "extension_attachment_action")).toBe(true);
    expect(sandbox).toMatchObject({
      kind: "iframe",
      src: "/provider-sandbox/simulated-devices/detail_view",
      capabilities: [
        "resize",
        "open_external",
        "host_actions",
        "host_resources",
        "host_resource_deltas",
      ],
      resources: [
        expect.objectContaining({
          id: "attachment_status",
          title: "Current attachment",
          binding: expect.objectContaining({
            hostBindingId: "extension_attachment_status",
          }),
        }),
      ],
    });
  });

  it("uses the simulated devices settings surface as a sandboxed host-control entry", async () => {
    const { createLocalDeviceToggleProviderRegistration } = await vi.importActual<{
      createLocalDeviceToggleProviderRegistration: () => { summary: ProviderSummary };
    }>("../../../scripts/providers/local-device-toggle-provider.mjs");
    const registration = createLocalDeviceToggleProviderRegistration();
    const settingsEntry = listProviderShellSurfaceEntries([registration.summary], {
      surfaceIds: ["settings_card"],
      includeSandboxed: true,
    })[0];
    const sandbox = resolveProviderHostSurfaceSandboxDescriptor(settingsEntry);
    const controls = listProviderHostSurfaceControls(settingsEntry);

    expect(settingsEntry).toMatchObject({
      provider: {
        id: "simulated-devices",
      },
      surface: {
        surface: "settings_card",
        title: "Simulated device controls",
      },
    });
    expect(sandbox).toMatchObject({
      kind: "iframe",
      src: "/provider-sandbox/simulated-devices/settings_card",
      capabilities: ["resize", "open_external", "host_controls"],
    });
    expect(controls).toEqual([
      expect.objectContaining({
        kind: "toggle",
        label: "Desk lamp power",
        binding: expect.objectContaining({
          hostBindingId: "simulated_device_power_state",
        }),
      }),
    ]);
  });

  it("resolves shell entries by preferring renderable surfaces and falling back to deferred sandboxed ones", () => {
    const provider = createProviderSummary({
      id: "camera:pixel-test",
      title: "Kitchen camera",
      manifest: {
        familyId: "camera",
        hostSurfaces: [
          {
            surface: "settings_card",
            title: "Sandboxed settings",
            metadata: createProviderUiSurfaceMetadata({
              policy: createProviderUiSurfacePolicy({
                trustLevel: "untrusted",
                renderMode: "sandboxed",
              }),
            }),
          },
        ],
      },
    });

    const deferredEntries = listProviderShellSurfaceEntries([provider], {
      surfaceIds: ["settings_card", "status_card"],
    });
    const deferredExtensionEntry = resolveExtensionProviderShellSurfaceEntry(
      createProviderSummary({
        id: "demo:board-test",
        title: "Demo board",
        manifest: {
          familyId: "demo",
          hostSurfaces: [
            {
              surface: "detail_view",
              title: "Sandboxed diagnostics",
              metadata: createProviderUiSurfaceMetadata({
                policy: createProviderUiSurfacePolicy({
                  trustLevel: "untrusted",
                  renderMode: "sandboxed",
                }),
              }),
            },
          ],
        },
      }),
    );

    expect(deferredEntries).toHaveLength(1);
    expect(deferredEntries[0]).toMatchObject({
      surface: {
        surface: "settings_card",
        title: "Sandboxed settings",
      },
    });
    expect(deferredExtensionEntry).toMatchObject({
      surface: {
        surface: "detail_view",
        title: "Sandboxed diagnostics",
      },
    });
  });

  it("falls back to built-in family manifests when a provider summary omits shell surfaces", () => {
    const provider = createProviderSummary({
      id: CAMERA_PROVIDER_FAMILY.id,
      title: CAMERA_PROVIDER_FAMILY.title,
      capabilityIds: [...CAMERA_PROVIDER_FAMILY.capabilityIds],
    });

    const entry = resolveExtensionProviderShellSurfaceEntry(provider);

    expect(entry).toMatchObject({
      familyId: CAMERA_PROVIDER_FAMILY.id,
      provider: {
        id: CAMERA_PROVIDER_FAMILY.id,
        manifest: {
          familyId: CAMERA_PROVIDER_FAMILY.id,
        },
      },
      surface: {
        surface: "detail_view",
        title: "Camera setup",
      },
    });
  });

  it("uses extension family ids when falling back built-in surfaces for provider instances", () => {
    const provider = createProviderSummary({
      id: "camera:pixel-test",
      title: "Kitchen camera",
      capabilityIds: ["camera_observation"],
    });

    const entry = resolveExtensionProviderShellSurfaceEntry(provider);

    expect(entry).toMatchObject({
      familyId: "camera",
      surface: {
        surface: "detail_view",
        title: "Camera setup",
      },
    });
  });

  it("detects host bindings declared through provider UI SDK elements", () => {
    const provider = createProviderSummary({
      id: "demo:board-test",
      title: "Demo board",
      manifest: {
        familyId: "demo",
        hostSurfaces: [
          {
            surface: "detail_view",
            title: "Demo diagnostics",
            metadata: {
              elements: [
                {
                  element: "section",
                  title: "Current runtime",
                  binding: {
                    hostBindingId: "demo_runtime",
                  },
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
              ],
            },
          },
        ],
      },
    });

    const entry = resolveExtensionProviderShellSurfaceEntry(provider);

    expect(providerHostSurfaceHasSectionBinding(entry, "demo_runtime")).toBe(true);
    expect(providerHostSurfaceHasActionBinding(entry, "demo_attachment")).toBe(true);
    expect(providerHostSurfaceHasSectionBinding(entry, "missing_binding")).toBe(false);
    expect(providerHostSurfaceHasActionBinding(entry, "missing_binding")).toBe(false);
  });

  it("stores built-in host surface metadata in canonical UI surface elements", () => {
    const cameraSurface = CAMERA_PROVIDER_FAMILY.manifest.hostSurfaces?.find(
      (surface) => surface.surface === "detail_view",
    );
    const speechSurface = SPEECH_PROVIDER_FAMILY.manifest.hostSurfaces?.find(
      (surface) => surface.surface === "settings_card",
    );

    expect(cameraSurface?.metadata).toMatchObject({
      kind: "sensor",
      policy: {
        trustLevel: "first_party",
        renderMode: "host_declarative",
      },
      elements: expect.arrayContaining([
        expect.objectContaining({ element: "actions" }),
        expect.objectContaining({ element: "section", title: "Setup" }),
        expect.objectContaining({ element: "section", title: "Current attachment" }),
        expect.objectContaining({ element: "section", title: "Saved setup" }),
        expect.objectContaining({ element: "section", title: "Availability issue" }),
      ]),
    });
    expect((cameraSurface?.metadata as Record<string, unknown> | undefined)?.highlights).toBeUndefined();
    expect((cameraSurface?.metadata as Record<string, unknown> | undefined)?.facts).toBeUndefined();
    expect((cameraSurface?.metadata as Record<string, unknown> | undefined)?.actions).toBeUndefined();
    expect((cameraSurface?.metadata as Record<string, unknown> | undefined)?.sections).toBeUndefined();

    expect(speechSurface?.metadata).toMatchObject({
      kind: "speech_service",
      policy: {
        trustLevel: "first_party",
        renderMode: "host_declarative",
      },
      elements: expect.arrayContaining([
        expect.objectContaining({
          element: "section",
          binding: expect.objectContaining({
            hostBindingId: "speech_settings_summary",
          }),
        }),
        expect.objectContaining({ element: "controls" }),
        expect.objectContaining({ element: "actions" }),
      ]),
    });
    expect((speechSurface?.metadata as Record<string, unknown> | undefined)?.controls).toBeUndefined();
    expect((speechSurface?.metadata as Record<string, unknown> | undefined)?.actions).toBeUndefined();
  });

  it("builds canonical surface metadata from UI SDK element helpers", () => {
    const metadata = createProviderUiSurfaceMetadata({
      kind: "sensor",
      elements: createProviderUiSurfaceElements([
        createProviderUiSurfaceHighlights(["Native phone capture", "Native phone capture"]),
        createProviderUiSurfaceFacts([
          { label: "Capture modes", value: "Single photo" },
        ]),
        createProviderUiSurfaceSection({
          title: "Setup",
          items: ["Grant camera access on the attached device."],
        }),
        createProviderUiSurfaceHint("Use Extensions to attach a device."),
      ]),
    });

    expect(metadata).toEqual({
      kind: "sensor",
      elements: [
        {
          element: "highlights",
          items: ["Native phone capture"],
        },
        {
          element: "facts",
          facts: [{ label: "Capture modes", value: "Single photo" }],
        },
        {
          element: "section",
          title: "Setup",
          items: ["Grant camera access on the attached device."],
        },
        {
          element: "hint",
          text: "Use Extensions to attach a device.",
        },
      ],
    });
  });

  it("builds reusable extension attachment and status section bundles", () => {
    const elements = createProviderUiSurfaceElements([
      createProviderUiSurfaceExtensionAttachmentAction(),
      createProviderUiSurfaceExtensionStatusSections({
        setup: {
          items: ["Attach a device before starting capture."],
        },
        savedSetup: false,
      }),
    ]);

    expect(elements).toEqual([
      {
        element: "actions",
        actions: [
          {
            label: "Attachment",
            description:
              "Attach or detach this provider.",
            variant: "outline",
            binding: {
              hostBindingId: "extension_attachment_action",
            },
          },
        ],
      },
      {
        element: "section",
        title: "Setup",
        items: ["Attach a device before starting capture."],
        binding: {
          hostBindingId: "extension_setup_guidance",
        },
      },
      {
        element: "section",
        title: "Current attachment",
        binding: {
          hostBindingId: "extension_attachment_status",
        },
      },
      {
        element: "section",
        title: "Current runtime",
        binding: {
          hostBindingId: "extension_runtime_status",
        },
      },
      {
        element: "section",
        title: "Availability issue",
        binding: {
          hostBindingId: "extension_issue_status",
        },
      },
    ]);
  });

  it("builds reusable speech settings and status bundles", () => {
    const settingsElements = createProviderUiSurfaceElements([
      createProviderUiSurfaceSpeechSettingsControls({
        includeScopeControl: false,
      }),
      createProviderUiSurfaceSpeechDesktopHostActions({
        includeRefreshTunnel: false,
      }),
    ]);
    const statusElements = createProviderUiSurfaceElements([
      createProviderUiSurfaceSpeechStatusControls({
        includeFallbackControl: false,
      }),
    ]);

    expect(settingsElements).toEqual([
      {
        element: "controls",
        controls: [
          {
            kind: "select",
            label: "Speech route",
            description: "Choose the preferred speech backend for this space.",
            placeholder: "Auto",
            binding: {
              hostBindingId: "speech_route_mode",
            },
            options: [
              {
                label: "Auto",
                value: "auto",
                description: "Use the best available speech path.",
              },
              {
                label: "Speech provider",
                value: "provider",
                description: "Use the shared speech host when it is ready.",
              },
              {
                label: "This device",
                value: "device",
                description: "Keep speech on this device.",
              },
            ],
          },
          {
            kind: "readonly",
            label: "Preference source",
            description: "Shows whether this setting is shared or device-only.",
            binding: {
              hostBindingId: "speech_preference_source",
            },
          },
          {
            kind: "select",
            label: "Provider voice",
            description: "Optional provider voice.",
            placeholder: "Automatic provider voice",
            binding: {
              hostBindingId: "speech_provider_voice",
            },
          },
          {
            kind: "select",
            label: "Device voice",
            description: "Optional device voice.",
            placeholder: "Automatic device voice",
            binding: {
              hostBindingId: "speech_device_voice",
            },
          },
        ],
      },
      {
        element: "actions",
        actions: [
          {
            label: "Desktop host",
            description:
              "Turn this Mac into a shared speech host for your other Instafy clients, or turn it back off.",
            variant: "primary",
            binding: {
              hostBindingId: "desktop_voice_host_toggle",
            },
          },
          {
            label: "Repair Desktop host",
            description: "Repair the desktop speech runtime.",
            variant: "outline",
            binding: {
              hostBindingId: "desktop_voice_host_repair",
            },
          },
          {
            label: "Restart Desktop host",
            description: "Restart desktop speech services.",
            variant: "outline",
            binding: {
              hostBindingId: "desktop_voice_host_restart",
            },
          },
          {
            label: "Remove downloaded runtime",
            description: "Delete the downloaded speech runtime when Desktop hosting is off.",
            variant: "outline",
            binding: {
              hostBindingId: "desktop_voice_runtime_remove",
            },
          },
        ],
      },
    ]);

    expect(statusElements).toEqual([
      {
        element: "controls",
        controls: [
          {
            kind: "toggle",
            label: "Warmup-aware readiness",
            description: "Use hosted speech only after it is ready.",
            value: true,
            disabled: true,
          },
        ],
      },
    ]);
  });

  it("resolves host-surface trust policy and binding permissions", () => {
    const trustedEntry = createEntryWithSurfaceMetadata({
      policy: createProviderUiSurfacePolicy({
        trustLevel: "first_party",
        renderMode: "host_declarative",
      }),
    });
    const untrustedEntry = createEntryWithSurfaceMetadata({
      policy: createProviderUiSurfacePolicy({
        trustLevel: "untrusted",
        renderMode: "sandboxed",
      }),
    });

    expect(resolveProviderHostSurfacePolicy(trustedEntry)).toEqual({
      trustLevel: "first_party",
      renderMode: "host_declarative",
      allowHostBindings: true,
    });
    expect(resolveProviderHostSurfacePolicy(untrustedEntry)).toEqual({
      trustLevel: "untrusted",
      renderMode: "sandboxed",
      allowHostBindings: false,
    });
  });

  it("resolves sandbox container descriptors only for sandboxed surfaces", () => {
    const sandboxedEntry = createEntryWithSurfaceMetadata({
      policy: createProviderUiSurfacePolicy({
        trustLevel: "untrusted",
        renderMode: "sandboxed",
      }),
      sandbox: createProviderUiSurfaceSandboxContainer({
        kind: "iframe",
        src: "https://providers.instafy.dev/camera/surface",
        title: "Camera sandbox",
        capabilities: ["resize", "open_external", "host_actions"],
      }),
    });
    const trustedEntry = createEntryWithSurfaceMetadata({
      policy: createProviderUiSurfacePolicy({
        trustLevel: "first_party",
        renderMode: "host_declarative",
      }),
      sandbox: createProviderUiSurfaceSandboxContainer({
        kind: "iframe",
        src: "https://providers.instafy.dev/camera/surface",
      }),
    });

    expect(resolveProviderHostSurfaceSandboxDescriptor(sandboxedEntry)).toEqual({
      kind: "iframe",
      src: "https://providers.instafy.dev/camera/surface",
      title: "Camera sandbox",
      capabilities: ["resize", "open_external", "host_actions"],
    });
    expect(resolveProviderHostSurfaceSandboxDescriptor(trustedEntry)).toBeNull();
  });
});

function createEntryWithSurfaceMetadata(metadata: ProviderUiSurfaceMetadata | undefined) {
  const provider = createProviderSummary({
    id: "camera",
    title: "Camera",
    manifest: {
      familyId: "camera",
      hostSurfaces: [
        {
          surface: "extension_tile",
          title: "Camera",
          metadata,
        },
      ],
    },
  });
  const selectedEntry = resolveExtensionProviderShellSurfaceEntry(provider);
  if (!selectedEntry) {
    throw new Error("expected host surface entry");
  }
  return selectedEntry;
}
