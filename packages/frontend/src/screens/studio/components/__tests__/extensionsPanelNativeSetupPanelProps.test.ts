import { describe, expect, it, vi } from "vitest";
import { buildExtensionsPanelNativeSetupPanelProps } from "../extensionsPanelNativeSetupPanelProps";

describe("extensionsPanelNativeSetupPanelProps", () => {
  it("wires attached setup callbacks through the current provider context", async () => {
    const provider = {
      id: "camera:pixel-test",
      title: "Pixel camera",
      capabilityIds: ["camera_observation"],
    };
    const integration = { id: "integration-1" };
    const remember = vi.fn().mockResolvedValue(undefined);
    const forget = vi.fn().mockResolvedValue(undefined);
    const runtimeProbe = vi.fn().mockResolvedValue(undefined);
    const persistCameraState = vi.fn().mockResolvedValue(undefined);
    const onRuntimeStatusChange = vi.fn();
    const onAuxiliaryStatusChange = vi.fn();
    const onCameraStatusChange = vi.fn();

    const result = buildExtensionsPanelNativeSetupPanelProps({
      provider,
      mutationProviderId: "camera:pixel-test",
      capabilityIds: ["camera_observation"],
      integration: integration as never,
      connectionType: "native_runtime",
      attached: true,
      developerDetailsDefault: true,
      surfaceCoverage: {
        setupGuidance: true,
        attachmentStatus: true,
        runtimeStatus: true,
        savedState: true,
        availabilityIssue: false,
      },
      selectedDevice: {
        identifier: "device-1",
        name: "Pixel 9",
        transport: "lan",
      },
      cameraState: {
        selectedLens: "rear",
        lastCapture: null,
        updatedAt: null,
      },
      savePending: false,
      onRememberProviderDevice: remember,
      onForgetProviderDevice: forget,
      onRunRuntimeProbe: runtimeProbe,
      onRuntimeStatusChange,
      onAuxiliaryStatusChange,
      onPersistCameraState: persistCameraState,
      onCameraStatusChange,
    });

    await result.onSaveConnectedDevice?.({
      transport: "ble",
      identifier: "device-2",
      address: "AA:BB",
      name: "Phone",
      nativePlatform: "android",
      connectedAt: "2026-04-16T10:00:00.000Z",
    });
    await result.onForgetSavedDevice?.();
    await result.onRunRuntimeProbe?.();
    await result.onPersistCameraState?.({
      selectedLens: "front",
      lastCapture: null,
    });

    expect(remember).toHaveBeenCalledWith(
      provider,
      "camera:pixel-test",
      ["camera_observation"],
      integration,
      "native_runtime",
      expect.objectContaining({
        identifier: "device-2",
        transport: "ble",
        lastConnectedAt: "2026-04-16T10:00:00.000Z",
      }),
    );
    expect(forget).toHaveBeenCalledWith(
      provider,
      "camera:pixel-test",
      ["camera_observation"],
      integration,
      "native_runtime",
    );
    expect(runtimeProbe).toHaveBeenCalledWith(provider);
    expect(persistCameraState).toHaveBeenCalledWith(
      provider,
      "camera:pixel-test",
      ["camera_observation"],
      integration,
      "native_runtime",
      {
        selectedLens: "front",
        lastCapture: null,
      },
    );
    expect(result.onRuntimeStatusChange).toBe(onRuntimeStatusChange);
    expect(result.onAuxiliaryStatusChange).toBe(onAuxiliaryStatusChange);
    expect(result.onCameraStatusChange).toBe(onCameraStatusChange);
    expect(result.allowDeveloperToggle).toBe(false);
    expect(result.surfaceCoverage).toEqual({
      setupGuidance: true,
      attachmentStatus: true,
      runtimeStatus: true,
      savedState: true,
      availabilityIssue: false,
    });
  });

  it("omits mutating callbacks when the row is not attached", () => {
    const result = buildExtensionsPanelNativeSetupPanelProps({
      provider: {
        id: "demo",
        title: "Demo",
        capabilityIds: ["robot_embodiment"],
      },
      mutationProviderId: "demo",
      capabilityIds: ["robot_embodiment"],
      integration: null,
      connectionType: "local_provider",
      attached: false,
      developerDetailsDefault: false,
      surfaceCoverage: {
        setupGuidance: false,
        attachmentStatus: false,
        runtimeStatus: false,
        savedState: false,
        availabilityIssue: false,
      },
      selectedDevice: null,
      cameraState: {
        selectedLens: null,
        lastCapture: null,
        updatedAt: null,
      },
      savePending: false,
      onRememberProviderDevice: vi.fn(),
      onForgetProviderDevice: vi.fn(),
      onRunRuntimeProbe: vi.fn(),
      onRuntimeStatusChange: vi.fn(),
      onAuxiliaryStatusChange: vi.fn(),
      onPersistCameraState: vi.fn(),
      onCameraStatusChange: vi.fn(),
    });

    expect(result.onSaveConnectedDevice).toBeUndefined();
    expect(result.onForgetSavedDevice).toBeUndefined();
    expect(result.onRunRuntimeProbe).toBeUndefined();
    expect(result.onPersistCameraState).toBeUndefined();
    expect(result.allowDeveloperToggle).toBe(false);
    expect(result.surfaceCoverage).toEqual({
      setupGuidance: false,
      attachmentStatus: false,
      runtimeStatus: false,
      savedState: false,
      availabilityIssue: false,
    });
  });
});
