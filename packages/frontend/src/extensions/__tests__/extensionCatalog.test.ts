import { describe, expect, it } from "vitest";
import {
  formatExtensionKindLabel,
  getRegisteredNativeRuntimeProvider,
  resolveExtensionDefinition,
  summarizeExtensionDescription,
} from "../extensionCatalog";

describe("extensionCatalog", () => {
  it("resolves Camera from provider type and capability ids", () => {
    const definition = resolveExtensionDefinition({
      provider: {
        id: "camera-local",
        title: "Phone Camera Backend",
        providerType: "phone_camera",
        capabilityIds: ["camera_observation"],
      },
    });

    expect(definition.familyId).toBe("camera");
    expect(definition.title).toBe("Camera");
    expect(definition.listDescription).toBe("Take photos.");
    expect(definition.kind).toBe("sensor");
  });

  it("resolves Camera from an instance-based integration id", () => {
    const definition = resolveExtensionDefinition({
      integrationProviderId: "camera:pixel-test",
    });

    expect(definition.familyId).toBe("camera");
    expect(definition.title).toBe("Camera");
    expect(definition.listDescription).toBe("Take photos.");
  });

  it("falls back to compact generic provider copy", () => {
    const definition = resolveExtensionDefinition({
      provider: {
        id: "usb_webcam",
        description:
          "Use an attached USB webcam to provide live still captures for this space. This provider also exposes internal transport details.",
        kind: "sensor",
      },
    });

    expect(definition.title).toBe("Usb Webcam");
    expect(definition.listDescription).toBe(
      "Use an attached USB webcam to provide live still captures for this space.",
    );
    expect(definition.kind).toBe("sensor");
  });

  it("derives an extension tile from provider manifest metadata without hardcoded frontend registration", () => {
    const definition = resolveExtensionDefinition({
      provider: {
        id: "screen-share",
        title: "Screen Share",
        providerType: "desktop_capture",
        manifest: {
          familyId: "screen-share",
          hostSurfaces: [
            {
              surface: "extension_tile",
              title: "Screen Share",
              description: "Share a desktop capture stream with this space.",
              metadata: {
                kind: "capture",
              },
            },
          ],
        },
      },
    });

    expect(definition.familyId).toBe("screen-share");
    expect(definition.title).toBe("Screen Share");
    expect(definition.listDescription).toBe("Share a desktop capture stream with this space.");
    expect(definition.kind).toBe("capture");
    expect(definition.providerType).toBe("desktop_capture");
  });

  it("normalizes generic descriptions and kind labels", () => {
    expect(summarizeExtensionDescription("", "Camera")).toBe("Camera extension.");
    expect(formatExtensionKindLabel("sensor")).toBe("Sensor");
    expect(formatExtensionKindLabel(null)).toBeNull();
  });

  it("registers native runtime fallback providers for built-in extensions", () => {
    expect(getRegisteredNativeRuntimeProvider("camera")).toMatchObject({
      id: "camera",
      providerType: "phone_camera",
      capabilityIds: ["camera_observation"],
      toolAliases: {
        capturePhoto: "instafy.camera.capture_photo",
        capturePhotoSeries: "instafy.camera.capture_photo_series",
      },
    });
    expect(getRegisteredNativeRuntimeProvider("camera:pixel-test")).toMatchObject({
      id: "camera:pixel-test",
      providerType: "phone_camera",
      capabilityIds: ["camera_observation"],
    });
  });
});
