import {
  createProviderManifest,
  createProviderSummary,
  createProviderUiSurfaceActions,
  createProviderUiSurfaceControls,
  createProviderUiSurfaceElements,
  createProviderUiSurfaceMetadata,
  createProviderUiSurfacePolicy,
  createProviderUiSurfaceSandboxContainer,
} from "@instafy/provider-contract";

const DEVICE_PROVIDER_ID = "simulated-devices";
const DEVICE_PROVIDER_TITLE = "Simulated devices";
const DEVICE_PROVIDER_DESCRIPTION =
  "Local simulated devices provider for simple power-state actions like the desk lamp example.";
const DEVICE_STATUS_SUMMARY_URI = "instafy://devices/status-summary";
const DESK_LAMP_STATE_URI = "instafy://devices/desk_lamp/state";
const SET_POWER_TOOL_ID = "instafy.device_toggle.set_power";
const GET_STATE_TOOL_ID = "instafy.device_toggle.get_state";
const DEVICE_SETTINGS_SURFACE_ID = "settings_card";
const DEVICE_DETAIL_SURFACE_ID = "detail_view";

const DEVICE_DEFINITIONS = {
  desk_lamp: {
    id: "desk_lamp",
    label: "desk lamp",
  },
};

const devicePowerState = new Map([["desk_lamp", "off"]]);

function buildSandboxSurfaceSrc(providerId, surfaceId) {
  return `/provider-sandbox/${encodeURIComponent(providerId)}/${encodeURIComponent(surfaceId)}`;
}

function buildProviderManifest(providerId) {
  return createProviderManifest({
    familyId: providerId,
    hostSurfaces: [
      {
        surface: DEVICE_SETTINGS_SURFACE_ID,
        title: "Simulated device controls",
        description: "Run isolated provider-owned controls for sample desk-lamp style device actions.",
        capabilityIds: ["device_toggle"],
        metadata: createProviderUiSurfaceMetadata({
          kind: "simulated_device_provider",
          policy: createProviderUiSurfacePolicy({
            trustLevel: "local_trusted",
            renderMode: "sandboxed",
          }),
          sandbox: createProviderUiSurfaceSandboxContainer({
            kind: "iframe",
            src: buildSandboxSurfaceSrc(providerId, DEVICE_SETTINGS_SURFACE_ID),
            title: "Simulated devices sandbox",
            capabilities: ["resize", "open_external", "host_controls"],
          }),
          elements: createProviderUiSurfaceElements([
            createProviderUiSurfaceControls([
              {
                kind: "toggle",
                label: "Desk lamp power",
                description: "Toggle the simulated desk lamp through a bounded host-managed control.",
                binding: {
                  hostBindingId: "simulated_device_power_state",
                },
              },
            ]),
          ]),
        }),
      },
      {
        surface: DEVICE_DETAIL_SURFACE_ID,
        title: "Simulated device details",
        description:
          "Run isolated provider-owned details for project attachment and desk-lamp style device actions.",
        capabilityIds: ["device_toggle"],
        metadata: createProviderUiSurfaceMetadata({
          kind: "simulated_device_provider",
          policy: createProviderUiSurfacePolicy({
            trustLevel: "local_trusted",
            renderMode: "sandboxed",
          }),
          sandbox: createProviderUiSurfaceSandboxContainer({
            kind: "iframe",
            src: buildSandboxSurfaceSrc(providerId, DEVICE_DETAIL_SURFACE_ID),
            title: "Simulated devices sandbox",
            capabilities: [
              "resize",
              "open_external",
              "host_actions",
              "host_resources",
              "host_resource_deltas",
            ],
            resources: [
              {
                id: "attachment_status",
                title: "Current attachment",
                binding: {
                  hostBindingId: "extension_attachment_status",
                },
              },
            ],
          }),
          elements: createProviderUiSurfaceElements([
            createProviderUiSurfaceActions([
              {
                label: "Attachment",
                description: "Attach or detach this simulated device provider from the current space.",
                variant: "outline",
                binding: {
                  hostBindingId: "extension_attachment_action",
                },
              },
            ]),
          ]),
        }),
      },
    ],
  });
}

function normalizeDeviceId(value) {
  return typeof value === "string" && value in DEVICE_DEFINITIONS ? value : null;
}

function normalizeTargetState(value) {
  if (value === "on" || value === "off" || value === "toggle") {
    return value;
  }
  return null;
}

function getDeviceSnapshot(deviceId) {
  const definition = DEVICE_DEFINITIONS[deviceId];
  return {
    device_id: definition.id,
    label: definition.label,
    power_state: devicePowerState.get(deviceId) ?? "off",
    simulated: true,
  };
}

function getAllDeviceSnapshots() {
  return Object.keys(DEVICE_DEFINITIONS).map((deviceId) => getDeviceSnapshot(deviceId));
}

function applyDevicePower(deviceId, targetState) {
  const currentState = devicePowerState.get(deviceId) ?? "off";
  const nextState =
    targetState === "toggle" ? (currentState === "on" ? "off" : "on") : targetState;
  devicePowerState.set(deviceId, nextState);
  return {
    previousState: currentState,
    powerState: nextState,
  };
}

function createConfiguredSummary(overrides = {}) {
  const providerId =
    typeof overrides.id === "string" && overrides.id.trim().length > 0
      ? overrides.id.trim()
      : DEVICE_PROVIDER_ID;
  return createProviderSummary({
    id: providerId,
    title: DEVICE_PROVIDER_TITLE,
    description: DEVICE_PROVIDER_DESCRIPTION,
    kind: "simulated_device_provider",
    providerType: "simulated_devices",
    configured: true,
    discoverable: true,
    rootUri: "instafy://devices",
    transportProbeSupported: true,
    capabilityIds: ["device_toggle"],
    toolIds: [SET_POWER_TOOL_ID, GET_STATE_TOOL_ID],
    resourceUris: [DEVICE_STATUS_SUMMARY_URI, DESK_LAMP_STATE_URI],
    manifest: buildProviderManifest(providerId),
    ...overrides,
  });
}

function buildDiscoveryProvider(providerId = DEVICE_PROVIDER_ID) {
  return {
    id: providerId,
    title: DEVICE_PROVIDER_TITLE,
    description: DEVICE_PROVIDER_DESCRIPTION,
    provider_kind: "simulated_device_provider",
    provider_type: "simulated_devices",
    root_uri: "instafy://devices",
    capability_ids: ["device_toggle"],
    transport_probe_supported: true,
    tool_surfaces: [
      {
        id: SET_POWER_TOOL_ID,
        title: "Set device power",
        description: "Turn a simulated device on, off, or toggle it.",
      },
      {
        id: GET_STATE_TOOL_ID,
        title: "Get device state",
        description: "Read the current state of a simulated device.",
      },
    ],
    resources: [
      {
        uri: DEVICE_STATUS_SUMMARY_URI,
        title: "Simulated device status summary",
      },
      {
        uri: DESK_LAMP_STATE_URI,
        title: "Desk lamp state",
      },
    ],
    manifest: buildProviderManifest(providerId),
    device_state: {
      devices: getAllDeviceSnapshots(),
    },
  };
}

export function createLocalDeviceToggleProviderRegistration(overrides = {}) {
  const id =
    typeof overrides.id === "string" && overrides.id.trim().length > 0
      ? overrides.id.trim()
      : DEVICE_PROVIDER_ID;
  const title =
    typeof overrides.title === "string" && overrides.title.trim().length > 0
      ? overrides.title.trim()
      : DEVICE_PROVIDER_TITLE;
  const description =
    typeof overrides.description === "string" && overrides.description.trim().length > 0
      ? overrides.description.trim()
      : DEVICE_PROVIDER_DESCRIPTION;

  return {
    id,
    summary: createConfiguredSummary({
      id,
      title,
      description,
    }),
    async getSummary() {
      return createConfiguredSummary({
        id,
        title,
        description,
      });
    },
    async discover() {
      return {
        ok: true,
        statusCode: 200,
        provider: {
          ...buildDiscoveryProvider(id),
          id,
          title,
          description,
        },
      };
    },
    async readResource(uri) {
      if (uri === DEVICE_STATUS_SUMMARY_URI) {
        return {
          ok: true,
          statusCode: 200,
          uri,
          exists: true,
          value: {
            devices: getAllDeviceSnapshots(),
          },
        };
      }

      if (uri === DESK_LAMP_STATE_URI) {
        return {
          ok: true,
          statusCode: 200,
          uri,
          exists: true,
          value: getDeviceSnapshot("desk_lamp"),
        };
      }

      return {
        ok: false,
        statusCode: 404,
        uri,
        error: `unknown resource uri: ${uri}`,
      };
    },
    async callTool(name, args = {}) {
      if (name === GET_STATE_TOOL_ID) {
        const deviceId = normalizeDeviceId(args.deviceId ?? "desk_lamp");
        if (!deviceId) {
          return {
            ok: false,
            statusCode: 400,
            name,
            error: "deviceId is required and must reference a supported simulated device.",
          };
        }

        return {
          ok: true,
          statusCode: 200,
          name,
          value: getDeviceSnapshot(deviceId),
        };
      }

      if (name !== SET_POWER_TOOL_ID) {
        return {
          ok: false,
          statusCode: 404,
          name,
          error: `unknown tool: ${name}`,
        };
      }

      const deviceId = normalizeDeviceId(args.deviceId);
      const targetState = normalizeTargetState(args.targetState);
      if (!deviceId) {
        return {
          ok: false,
          statusCode: 400,
          name,
          error: "deviceId is required and must reference a supported simulated device.",
        };
      }
      if (!targetState) {
        return {
          ok: false,
          statusCode: 400,
          name,
          error: "targetState must be one of on, off, or toggle.",
        };
      }

      const { previousState, powerState } = applyDevicePower(deviceId, targetState);
      const device = DEVICE_DEFINITIONS[deviceId];

      return {
        ok: true,
        statusCode: 200,
        name,
        value: {
          deviceId: device.id,
          deviceLabel: device.label,
          targetState,
          previousState,
          powerState,
          simulated: true,
        },
      };
    },
    async transportProbe() {
      return {
        ok: true,
        statusCode: 200,
        connected: true,
        value: {
          transport: "local_in_memory",
          devices: getAllDeviceSnapshots(),
        },
      };
    },
    async getHealthDetails() {
      return {
        providerType: "simulated_devices",
        configured: true,
        discoverable: true,
        devices: getAllDeviceSnapshots(),
      };
    },
  };
}
