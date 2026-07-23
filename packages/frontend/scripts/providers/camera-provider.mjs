import { createProviderSummary } from "@instafy/provider-contract";
import {
  CAMERA_CAPTURE_PHOTO_SERIES_TOOL_ID,
  CAMERA_CAPTURE_PHOTO_TOOL_ID,
  CAMERA_LATEST_CAPTURE_RESOURCE_URI,
  CAMERA_LENSES_RESOURCE_URI,
  CAMERA_OBSERVATION_CAPABILITY_ID,
  CAMERA_PROVIDER_DESCRIPTION,
  CAMERA_PROVIDER_FAMILY,
  CAMERA_PROVIDER_ID,
  CAMERA_PROVIDER_KIND,
  CAMERA_PROVIDER_TITLE,
  CAMERA_PROVIDER_TYPE,
  CAMERA_STATUS_RESOURCE_URI,
} from "@instafy/provider-contract/builtins";

function buildStatusValue() {
  return {
    supported: true,
    platform: "local_provider_host",
    backend: CAMERA_PROVIDER_TYPE,
    permission: "prompt",
    permissionGranted: false,
    canCapture: false,
    availableLenses: [],
    selectedLens: null,
    lastCapture: null,
    error:
      "Fresh camera capture requires a native device runtime. Use the Instafy mobile app or Instafy Desktop.",
  };
}

function buildSummary(overrides = {}) {
  return createProviderSummary({
    id: CAMERA_PROVIDER_ID,
    title: CAMERA_PROVIDER_TITLE,
    description: CAMERA_PROVIDER_DESCRIPTION,
    kind: CAMERA_PROVIDER_KIND,
    providerType: CAMERA_PROVIDER_TYPE,
    configured: true,
    discoverable: true,
    rootUri: CAMERA_PROVIDER_FAMILY.rootUri,
    transportProbeSupported: CAMERA_PROVIDER_FAMILY.transportProbeSupported,
    capabilityIds: CAMERA_PROVIDER_FAMILY.capabilityIds,
    toolIds: [CAMERA_CAPTURE_PHOTO_TOOL_ID, CAMERA_CAPTURE_PHOTO_SERIES_TOOL_ID],
    resourceUris: [
      CAMERA_STATUS_RESOURCE_URI,
      CAMERA_LENSES_RESOURCE_URI,
      CAMERA_LATEST_CAPTURE_RESOURCE_URI,
    ],
    toolAliases: CAMERA_PROVIDER_FAMILY.toolAliases,
    resourceAliases: CAMERA_PROVIDER_FAMILY.resourceAliases,
    manifest: CAMERA_PROVIDER_FAMILY.manifest,
    ...overrides,
  });
}

function buildDiscoveryProvider(id, title, description) {
  return {
    id,
    title,
    description,
    provider_kind: CAMERA_PROVIDER_KIND,
    provider_type: CAMERA_PROVIDER_TYPE,
    root_uri: CAMERA_PROVIDER_FAMILY.rootUri,
    capability_ids: CAMERA_PROVIDER_FAMILY.capabilityIds,
    transport_probe_supported: CAMERA_PROVIDER_FAMILY.transportProbeSupported,
    backend_options: ["phone_camera", "usb_webcam", "virtual_camera"],
    tool_surfaces: [
      {
        id: CAMERA_CAPTURE_PHOTO_TOOL_ID,
        title: "Capture photo",
        description: "Capture a single photo from the selected camera lens.",
      },
      {
        id: CAMERA_CAPTURE_PHOTO_SERIES_TOOL_ID,
        title: "Capture photo series",
        description: "Capture a short multi-photo series from the selected lens.",
      },
    ],
    resources: [
      {
        uri: CAMERA_STATUS_RESOURCE_URI,
        title: "Camera status",
      },
      {
        uri: CAMERA_LENSES_RESOURCE_URI,
        title: "Available camera lenses",
      },
      {
        uri: CAMERA_LATEST_CAPTURE_RESOURCE_URI,
        title: "Latest capture metadata",
      },
    ],
    status: buildStatusValue(),
  };
}

function buildToolUnavailableResult(name) {
  return {
    ok: false,
    statusCode: 503,
    name,
    error:
      "This Camera provider can report status from the local host, but fresh photo capture requires a native Instafy mobile or desktop camera runtime.",
  };
}

export function createCameraProviderRegistration(overrides = {}) {
  const id =
    typeof overrides.id === "string" && overrides.id.trim().length > 0
      ? overrides.id.trim()
      : CAMERA_PROVIDER_ID;
  const title =
    typeof overrides.title === "string" && overrides.title.trim().length > 0
      ? overrides.title.trim()
      : CAMERA_PROVIDER_TITLE;
  const description =
    typeof overrides.description === "string" && overrides.description.trim().length > 0
      ? overrides.description.trim()
      : CAMERA_PROVIDER_DESCRIPTION;

  return {
    id,
    summary: buildSummary({
      id,
      title,
      description,
    }),
    async getSummary() {
      return buildSummary({
        id,
        title,
        description,
      });
    },
    async discover() {
      return {
        ok: true,
        statusCode: 200,
        providerId: id,
        provider: buildDiscoveryProvider(id, title, description),
      };
    },
    async readResource(uri) {
      if (uri === CAMERA_STATUS_RESOURCE_URI) {
        return {
          ok: true,
          statusCode: 200,
          providerId: id,
          uri,
          exists: true,
          value: buildStatusValue(),
        };
      }

      if (uri === CAMERA_LENSES_RESOURCE_URI) {
        return {
          ok: true,
          statusCode: 200,
          providerId: id,
          uri,
          exists: true,
          value: {
            availableLenses: [],
          },
        };
      }

      if (uri === CAMERA_LATEST_CAPTURE_RESOURCE_URI) {
        return {
          ok: true,
          statusCode: 200,
          providerId: id,
          uri,
          exists: true,
          value: {
            lastCapture: null,
          },
        };
      }

      return {
        ok: false,
        statusCode: 404,
        providerId: id,
        uri,
        error: `unknown resource uri: ${uri}`,
      };
    },
    async callTool(name) {
      if (name === CAMERA_CAPTURE_PHOTO_TOOL_ID || name === CAMERA_CAPTURE_PHOTO_SERIES_TOOL_ID) {
        return buildToolUnavailableResult(name);
      }

      return {
        ok: false,
        statusCode: 404,
        providerId: id,
        name,
        error: `unknown tool: ${name}`,
      };
    },
    async getHealthDetails() {
      return {
        backend: CAMERA_PROVIDER_TYPE,
        status: buildStatusValue(),
      };
    },
  };
}
