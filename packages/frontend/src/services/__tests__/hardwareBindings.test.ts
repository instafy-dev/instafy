import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readMock = vi.hoisted(() => vi.fn());
const writeMock = vi.hoisted(() => vi.fn());

vi.mock("../../sdk/instafy", () => ({
  controllerClient: {
    workspace: {
      files: {
        read: readMock,
        write: writeMock,
      },
    },
  },
}));

import {
  createSerialHardwareResourceGrant,
  HARDWARE_BINDINGS_PATH,
  readProjectHardwareBindingStore,
  revokeProjectHardwareBinding,
  upsertProjectHardwareBinding,
} from "../runtimeController/hardwareBindings";

describe("hardware bindings runtime controller helpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-09T12:00:00.000Z"));
    readMock.mockReset();
    writeMock.mockReset();
    writeMock.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("returns an empty store when the bindings file does not exist", async () => {
    readMock.mockResolvedValue(null);

    await expect(
      readProjectHardwareBindingStore({
        projectId: "project-1",
      }),
    ).resolves.toEqual({
      version: 1,
      bindings: {},
    });

    expect(readMock).toHaveBeenCalledWith({
      projectId: "project-1",
      path: HARDWARE_BINDINGS_PATH,
      accessToken: null,
      runtimeId: null,
    });
  });

  it("upserts a serial binding and records a scoped device grant", async () => {
    readMock.mockResolvedValue(null);

    const binding = await upsertProjectHardwareBinding({
      projectId: "project-1",
      providerId: "hardware.serial",
      purpose: "Probe the attached ESP32 board.",
      grantedCapabilities: ["hardware_serial_list", "hardware_serial_probe"],
      grantedResources: [createSerialHardwareResourceGrant("/dev/cu.usbserial-130")!],
    });

    expect(binding).toMatchObject({
      providerId: "hardware.serial",
      projectId: "project-1",
      grantedCapabilities: ["hardware_serial_list", "hardware_serial_probe"],
      grantedResources: [
        {
          kind: "serial_device",
          id: "/dev/cu.usbserial-130",
          path: "/dev/cu.usbserial-130",
          displayName: "cu.usbserial-130",
        },
      ],
      purpose: "Probe the attached ESP32 board.",
      status: "bound",
      createdAt: "2026-05-09T12:00:00.000Z",
      updatedAt: "2026-05-09T12:00:00.000Z",
    });

    const writeParams = writeMock.mock.calls[0]?.[0];
    expect(writeParams.path).toBe(HARDWARE_BINDINGS_PATH);
    const written = JSON.parse(writeParams.content) as {
      bindings: Record<string, { grantedResources: Array<{ path: string }> }>;
    };
    expect(written.bindings["hardware.serial"].grantedResources[0]?.path).toBe(
      "/dev/cu.usbserial-130",
    );
  });

  it("recovers from malformed JSON when mutating the store", async () => {
    readMock.mockResolvedValue({
      isText: true,
      contentText: "{not-json",
    });

    await expect(
      upsertProjectHardwareBinding({
        projectId: "project-1",
        providerId: "hardware.serial",
        grantedCapabilities: ["hardware_serial_probe"],
      }),
    ).resolves.toMatchObject({
      providerId: "hardware.serial",
      grantedCapabilities: ["hardware_serial_probe"],
    });

    expect(writeMock).toHaveBeenCalledTimes(1);
  });

  it("revokes an existing binding and persists the updated store", async () => {
    readMock.mockResolvedValue({
      isText: true,
      contentText: JSON.stringify({
        version: 1,
        bindings: {
          "hardware.serial": {
            providerId: "hardware.serial",
            projectId: "project-1",
            grantedCapabilities: ["hardware_serial_list", "hardware_serial_probe"],
            grantedResources: [],
            purpose: "Probe the attached ESP32 board.",
            status: "bound",
            createdAt: "2026-05-08T12:00:00.000Z",
            updatedAt: "2026-05-08T12:00:00.000Z",
          },
        },
      }),
    });

    await expect(
      revokeProjectHardwareBinding({
        projectId: "project-1",
        providerId: "hardware.serial",
      }),
    ).resolves.toBe(true);

    const writeParams = writeMock.mock.calls[0]?.[0];
    const written = JSON.parse(writeParams.content) as {
      bindings: Record<string, unknown>;
    };
    expect(written.bindings).toEqual({});
  });
});
