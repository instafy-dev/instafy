/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalHardwareBindingStore } from "@instafy/sdk/hardware-provider";
import type { ProviderProjectBindingStore } from "@instafy/sdk/provider-project-binding";

const readProjectHardwareBindingStoreMock = vi.hoisted(() => vi.fn());
const revokeProjectHardwareBindingMock = vi.hoisted(() => vi.fn());
const upsertProjectHardwareBindingMock = vi.hoisted(() => vi.fn());
const readProjectProviderBindingStoreMock = vi.hoisted(() => vi.fn());
const revokeProjectProviderBindingMock = vi.hoisted(() => vi.fn());
const showStatusMock = vi.hoisted(() => vi.fn());
const runtimeStateMock = vi.hoisted(() => ({
  localWorkspace: null as Record<string, unknown> | null,
}));

vi.mock("../../../../runtime/useRuntime", () => ({
  useRuntime: () => ({
    localWorkspace: runtimeStateMock.localWorkspace,
  }),
}));

vi.mock("../../../../services/runtimeController/hardwareBindings", async () => {
  const actual = await vi.importActual<
    typeof import("../../../../services/runtimeController/hardwareBindings")
  >("../../../../services/runtimeController/hardwareBindings");
  return {
    ...actual,
    readProjectHardwareBindingStore: readProjectHardwareBindingStoreMock,
    revokeProjectHardwareBinding: revokeProjectHardwareBindingMock,
    upsertProjectHardwareBinding: upsertProjectHardwareBindingMock,
  };
});

vi.mock("../../../../services/runtimeController/providerBindings", () => ({
  readProjectProviderBindingStore: readProjectProviderBindingStoreMock,
  revokeProjectProviderBinding: revokeProjectProviderBindingMock,
}));

vi.mock("../../../../status/useStatus", () => ({
  useStatus: () => ({
    queue: null,
    showStatus: showStatusMock,
    hideStatus: vi.fn(),
  }),
}));

import { ProjectProviderBindingsCard } from "../ProjectProviderBindingsCard";

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function createProviderBindingStore(): ProviderProjectBindingStore {
  return {
    version: 1,
    bindings: {
      demo: {
        providerId: "demo",
        projectId: "project-1",
        rootUri: "file:///home/example/git/demo",
        grantedCapabilities: ["project_content_read", "project_content_write"],
        grantedPrefix: ".instafy/providers/demo/",
        purpose: "Store learned robot state.",
        status: "bound_read_write",
        createdAt: "2026-04-22T12:00:00.000Z",
        updatedAt: "2026-04-22T12:00:00.000Z",
      },
    },
  };
}

function createHardwareBindingStore(): LocalHardwareBindingStore {
  return {
    version: 1,
    bindings: {
      "hardware.serial@runtime-local": {
        bindingId: "hardware.serial@runtime-local",
        providerId: "hardware.serial",
        projectId: "project-1",
        runtimeHostId: "runtime-local",
        runtimeHostLabel: "Taylor MacBook",
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
      },
    },
  };
}

function createMultiHostHardwareBindingStore(): LocalHardwareBindingStore {
  const store = createHardwareBindingStore();
  return {
    version: 1,
    bindings: {
      ...store.bindings,
      "hardware.serial@runtime-workshop": {
        bindingId: "hardware.serial@runtime-workshop",
        providerId: "hardware.serial",
        projectId: "project-1",
        runtimeHostId: "runtime-workshop",
        runtimeHostLabel: "Workshop mini PC",
        grantedCapabilities: ["hardware_serial_probe"],
        grantedResources: [
          {
            kind: "serial_device",
            id: "COM4",
            path: "COM4",
            displayName: "COM4",
          },
        ],
        purpose: "Probe the attached ESP32 board.",
        status: "bound",
        createdAt: "2026-05-09T12:00:00.000Z",
        updatedAt: "2026-05-09T12:00:00.000Z",
      },
    },
  };
}

describe("ProjectProviderBindingsCard", () => {
  let container: HTMLDivElement;
  let root: Root;
  let confirmSpy: { mockRestore: () => void };
  let matchMediaMock: {
    mockImplementation: (implementation: (query: string) => MediaQueryList) => unknown;
    mockRestore: () => void;
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    readProjectHardwareBindingStoreMock.mockReset();
    revokeProjectHardwareBindingMock.mockReset();
    upsertProjectHardwareBindingMock.mockReset();
    readProjectProviderBindingStoreMock.mockReset();
    revokeProjectProviderBindingMock.mockReset();
    showStatusMock.mockReset();
    readProjectHardwareBindingStoreMock.mockResolvedValue({ version: 1, bindings: {} });
    runtimeStateMock.localWorkspace = {
      deviceId: "device-local",
      hostname: "Taylor MacBook",
      path: "/home/example/.instafy/workspace/project-1",
      runtimeId: "runtime-local",
      status: "online",
    };
    window.__INSTAFY_RUNTIME__ = {
      getSnapshot: () => ({
        runtime: {
          buildLogs: [],
          activeConversationId: null,
          controllerReady: true,
          controllerProjectMissing: false,
          controllerUnavailable: false,
          controllerStreamDisconnected: false,
          controllerStreamDisconnectMessage: null,
        },
        runs: {},
        latestRunIds: {},
        leasedRunIds: {},
        pendingConversationMessages: [],
        localWorkspace: {
          deviceId: "device-local",
          hostname: "Taylor MacBook",
          path: "/home/example/.instafy/workspace/project-1",
          runtimeId: "runtime-local",
          status: "online",
        },
        runtimeStatuses: [
          {
            runtimeId: "runtime-local",
            status: "ready",
            provider: "desktop",
            idleTtlSeconds: 0,
            isLocal: true,
            isPreferred: true,
            health: "online",
            displayName: "Taylor MacBook",
          },
        ],
        preferredRuntimeId: "runtime-local",
        sessionRuntimeId: null,
        runtimeReady: true,
        runtimeEnsureError: null,
        runtimeEnsureLimit: null,
        tunnelGrants: {},
      }),
      refreshRuntimeStatuses: vi.fn(),
    };
    confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    matchMediaMock = vi
      .spyOn(window, "matchMedia")
      .mockImplementation(
        (query) =>
          ({
            matches: false,
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
          }) as MediaQueryList,
      );
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    confirmSpy.mockRestore();
    matchMediaMock.mockRestore();
    container.remove();
    delete window.__INSTAFY_RUNTIME__;
    delete window.instafyDesktop;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    vi.clearAllMocks();
  });

  it("revokes an existing binding and reloads the empty state", async () => {
    readProjectProviderBindingStoreMock
      .mockResolvedValueOnce(createProviderBindingStore())
      .mockResolvedValueOnce({
        version: 1,
        bindings: {},
      });
    revokeProjectProviderBindingMock.mockResolvedValue(true);

    await act(async () => {
      root.render(<ProjectProviderBindingsCard projectId="project-1" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="project-provider-binding-demo"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("1 provider");

    const revokeButton = container.querySelector(
      '[data-testid="project-provider-binding-revoke-demo"]',
    );
    expect(revokeButton).not.toBeNull();

    await act(async () => {
      revokeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(window.confirm).toHaveBeenCalledWith("Revoke project access for demo?");
    expect(revokeProjectProviderBindingMock).toHaveBeenCalledWith({
      projectId: "project-1",
      providerId: "demo",
    });
    expect(showStatusMock).toHaveBeenCalledWith(
      "Revoked provider access for demo.",
      "success",
      2500,
    );
    expect(
      container.querySelector('[data-testid="project-provider-binding-demo"]'),
    ).toBeNull();
    expect(container.textContent).toContain("No access");
  });

  it("grants host-local IO access from the local runtime card", async () => {
    readProjectProviderBindingStoreMock.mockResolvedValue({ version: 1, bindings: {} });
    readProjectHardwareBindingStoreMock.mockResolvedValue({ version: 1, bindings: {} });
    upsertProjectHardwareBindingMock.mockResolvedValue(
      createHardwareBindingStore().bindings["hardware.serial@runtime-local"],
    );

    await act(async () => {
      root.render(<ProjectProviderBindingsCard projectId="project-1" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Connections");
    expect(container.textContent).toContain("Project files");
    expect(container.textContent).toContain(
      "Stored in Instafy. Desktop and runtimes work on synced copies.",
    );
    expect(container.textContent).toContain("Copy on Taylor MacBook");
    expect(container.textContent).toContain("/home/example/.instafy/workspace/project-1");
    expect(container.textContent).toContain("Project providers");
    expect(container.textContent).toContain("Local hardware");
    expect(container.textContent).toContain("Current host");
    expect(container.textContent).toContain("Taylor MacBook");
    expect(container.textContent).toContain("Grants apply to Taylor MacBook.");
    const openDesktopLink = container.querySelector<HTMLAnchorElement>(
      '[data-testid="project-hardware-open-desktop"]',
    );
    expect(openDesktopLink?.textContent).toBe("Open in Desktop");
    expect(openDesktopLink?.getAttribute("href")).toBe("instafy://studio?projectId=project-1");
    const installDesktopLink = container.querySelector<HTMLAnchorElement>(
      '[data-testid="project-hardware-install-desktop"]',
    );
    expect(installDesktopLink?.textContent).toBe("Install Desktop");
    expect(installDesktopLink?.getAttribute("href")).toBe("/install");
    expect(installDesktopLink?.target).toBe("_blank");
    expect(container.querySelector('[data-testid="project-access-subnav"]')).toBeNull();
    expect(container.querySelector('[data-testid="project-access-subnav-files"]')).toBeNull();
    expect(container.querySelector('[data-testid="project-access-subnav-devices"]')).toBeNull();
    expect(container.querySelector('[data-testid="project-provider-bindings-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="project-hardware-bindings-panel"]')).not.toBeNull();

    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="project-hardware-serial-device"]',
    );
    expect(input).not.toBeNull();
    expect(input?.labels?.[0]?.textContent).toBe("Device path to grant");

    await act(async () => {
      setInputValue(input!, "/dev/cu.usbserial-130");
    });

    await act(async () => {
      container
        .querySelector('[data-testid="project-hardware-grant"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(upsertProjectHardwareBindingMock).toHaveBeenCalledWith({
      projectId: "project-1",
      providerId: "hardware.serial",
      runtimeHostId: "runtime-local",
      runtimeHostLabel: "Taylor MacBook",
      purpose:
        "Allow a local Instafy runtime to discover and probe host USB serial devices.",
      grantedCapabilities: ["hardware_serial_list", "hardware_serial_probe"],
      grantedResources: [
        {
          kind: "serial_device",
          id: "/dev/cu.usbserial-130",
          path: "/dev/cu.usbserial-130",
          displayName: "cu.usbserial-130",
        },
      ],
    });
    expect(showStatusMock).toHaveBeenCalledWith(
      "Granted serial access for Taylor MacBook.",
      "success",
      2500,
    );
  });

  it("shows provider and local device sections together", async () => {
    matchMediaMock.mockImplementation(
      (query: string) =>
        ({
          matches: true,
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as MediaQueryList,
    );
    readProjectProviderBindingStoreMock.mockResolvedValue(createProviderBindingStore());
    readProjectHardwareBindingStoreMock.mockResolvedValue(createHardwareBindingStore());

    await act(async () => {
      root.render(<ProjectProviderBindingsCard projectId="project-1" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="project-access-subnav"]')).toBeNull();
    expect(container.querySelector('[data-testid="project-workspace-source-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="project-provider-bindings-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="project-hardware-bindings-panel"]')).not.toBeNull();
    expect(container.textContent).toContain("Project providers");
    expect(container.textContent).toContain("Local hardware");
    expect(container.textContent).toContain("Taylor MacBook");
    expect(container.textContent).not.toContain("Storage: .instafy/providers/demo/");
  });

  it("groups saved local device grants by runtime host", async () => {
    readProjectProviderBindingStoreMock.mockResolvedValue(createProviderBindingStore());
    readProjectHardwareBindingStoreMock.mockResolvedValue(createMultiHostHardwareBindingStore());

    await act(async () => {
      root.render(<ProjectProviderBindingsCard projectId="project-1" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("1 provider · 2 runtime hosts");
    expect(container.textContent).toContain("Saved on this host");
    expect(
      container.querySelector('[data-testid="project-hardware-host-group-runtime-local"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="project-hardware-other-hosts"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="project-hardware-host-group-runtime-workshop"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("Taylor MacBook");
    expect(container.textContent).toContain("cu.usbserial-130");
    expect(container.textContent).toContain("Workshop mini PC");
    expect(container.textContent).toContain("COM4");
  });

  it("waits for a runtime host before showing IO grant controls", async () => {
    delete window.__INSTAFY_RUNTIME__;
    delete window.instafyDesktop;
    runtimeStateMock.localWorkspace = null;
    readProjectProviderBindingStoreMock.mockResolvedValue({ version: 1, bindings: {} });
    readProjectHardwareBindingStoreMock.mockResolvedValue({ version: 1, bindings: {} });

    await act(async () => {
      root.render(<ProjectProviderBindingsCard projectId="project-1" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("No local runtime connected");
    expect(container.textContent).toContain("No local copy connected");
    expect(container.textContent).toContain("Open Desktop or connect the CLI to grant hardware.");
    expect(
      container.querySelector('[data-testid="project-hardware-serial-device"]'),
    ).toBeNull();
    expect(container.querySelector('[data-testid="project-hardware-grant"]')).toBeNull();
    expect(container.querySelector('[data-testid="project-hardware-open-desktop"]')).not.toBeNull();
  });

  it("offers a local folder binding when the Desktop bridge supports it", async () => {
    const selectProjectWorkspaceFolder = vi.fn().mockResolvedValue({
      ok: true,
      path: "/home/example/Projects/demo",
      state: "empty",
      runtimeRestartRequired: false,
    });
    const getProjectWorkspaceBinding = vi.fn().mockResolvedValue({
      path: null,
      defaultPath: "/home/example/.instafy/workspace/project-1",
    });
    window.instafyDesktop = {
      notify: vi.fn(),
      selectProjectWorkspaceFolder,
      getProjectWorkspaceBinding,
      clearProjectWorkspaceBinding: vi.fn().mockResolvedValue({ ok: true }),
    };
    readProjectProviderBindingStoreMock.mockResolvedValue({ version: 1, bindings: {} });
    readProjectHardwareBindingStoreMock.mockResolvedValue({ version: 1, bindings: {} });

    await act(async () => {
      root.render(<ProjectProviderBindingsCard projectId="project-1" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getProjectWorkspaceBinding).toHaveBeenCalledWith({ projectId: "project-1" });
    expect(
      container.querySelector('[data-testid="project-workspace-folder-binding"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("Managed folder on this computer");
    expect(container.textContent).toContain("/home/example/.instafy/workspace/project-1");

    await act(async () => {
      container
        .querySelector('[data-testid="project-workspace-folder-choose"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(selectProjectWorkspaceFolder).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1" }),
    );
    expect(container.textContent).toContain("Linked folder");
    expect(container.textContent).toContain("/home/example/Projects/demo");
    expect(showStatusMock).toHaveBeenCalledWith(
      "Folder linked. The local runtime will use it for this space's files.",
      "success",
      4000,
    );
  });

  it("surfaces folder conflicts from the Desktop bridge as warnings", async () => {
    window.instafyDesktop = {
      notify: vi.fn(),
      selectProjectWorkspaceFolder: vi.fn().mockResolvedValue({
        ok: false,
        path: "/home/example/Documents/full-folder",
        reason: "This folder already has files in it.",
      }),
      getProjectWorkspaceBinding: vi.fn().mockResolvedValue({
        path: null,
        defaultPath: "/home/example/.instafy/workspace/project-1",
      }),
      clearProjectWorkspaceBinding: vi.fn().mockResolvedValue({ ok: true }),
    };
    readProjectProviderBindingStoreMock.mockResolvedValue({ version: 1, bindings: {} });
    readProjectHardwareBindingStoreMock.mockResolvedValue({ version: 1, bindings: {} });

    await act(async () => {
      root.render(<ProjectProviderBindingsCard projectId="project-1" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      container
        .querySelector('[data-testid="project-workspace-folder-choose"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(showStatusMock).toHaveBeenCalledWith(
      "This folder already has files in it.",
      "warning",
      6000,
    );
    expect(container.textContent).toContain("Managed folder on this computer");
    expect(container.textContent).toContain("/home/example/.instafy/workspace/project-1");
  });

  it("hides the local copy path when the workspace presence has expired", async () => {
    runtimeStateMock.localWorkspace = {
      deviceId: "device-local",
      hostname: "Taylor MacBook",
      path: "/home/example/.instafy/workspace/project-1",
      runtimeId: "runtime-local",
      status: "expired",
    };
    readProjectProviderBindingStoreMock.mockResolvedValue({ version: 1, bindings: {} });
    readProjectHardwareBindingStoreMock.mockResolvedValue({ version: 1, bindings: {} });

    await act(async () => {
      root.render(<ProjectProviderBindingsCard projectId="project-1" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("No local copy connected");
    expect(container.textContent).not.toContain("Copy on Taylor MacBook");
    expect(
      container.querySelector('[data-testid="project-workspace-local-path"]'),
    ).toBeNull();
  });

  it("uses the desktop app as a local hardware host when no runtime snapshot exists", async () => {
    delete window.__INSTAFY_RUNTIME__;
    window.instafyDesktop = {
      notify: vi.fn(),
      localHardwareHostStatus: vi.fn().mockResolvedValue({
        runtimeHostId: "desktop-host-1",
        runtimeHostLabel: "Desktop on Taylor MacBook",
        platform: "darwin",
        providerIds: ["hardware.serial"],
        supportedCapabilities: ["hardware_serial_list", "hardware_serial_probe"],
      }),
      localHardwareIoOpportunities: vi.fn().mockResolvedValue({
        providerId: "hardware.serial",
        platform: "darwin",
        opportunities: [
          {
            id: "serial:/dev/cu.usbserial-130",
            providerId: "hardware.serial",
            kind: "usb_serial_device",
            title: "USB serial device: cu.usbserial-130",
            available: true,
            resource: {
              kind: "serial_device",
              id: "/dev/cu.usbserial-130",
              path: "/dev/cu.usbserial-130",
              displayName: "cu.usbserial-130",
            },
            actions: [
              {
                id: "serial.probe",
                label: "Probe",
                status: "available",
                source: "runtime",
              },
            ],
          },
        ],
      }),
      localHardwareIoRunAction: vi.fn().mockResolvedValue({
        providerId: "hardware.serial",
        actionId: "serial.probe",
        ok: true,
        message: "Serial probe succeeded for /dev/cu.usbserial-130.",
        startedAt: "2026-05-11T12:00:00.000Z",
        finishedAt: "2026-05-11T12:00:00.010Z",
        serialProbe: {
          providerId: "hardware.serial",
          path: "/dev/cu.usbserial-130",
          exists: true,
          readable: true,
          writable: true,
          isCharacterDevice: true,
          available: true,
          error: null,
        },
        process: null,
        error: null,
      }),
    };
    readProjectProviderBindingStoreMock.mockResolvedValue(createProviderBindingStore());
    readProjectHardwareBindingStoreMock.mockResolvedValue({ version: 1, bindings: {} });
    upsertProjectHardwareBindingMock.mockResolvedValue({
      ...createHardwareBindingStore().bindings["hardware.serial@runtime-local"],
      bindingId: "hardware.serial@desktop-host-1",
      runtimeHostId: "desktop-host-1",
      runtimeHostLabel: "Desktop on Taylor MacBook",
    });

    await act(async () => {
      root.render(<ProjectProviderBindingsCard projectId="project-1" />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Desktop on Taylor MacBook");
    expect(container.textContent).toContain("Grants apply to this Desktop app.");
    expect(container.textContent).not.toContain("This runtime");
    expect(container.textContent).not.toContain("Check BLE status");
    expect(container.textContent).toContain("USB serial device");
    expect(container.textContent).toContain("cu.usbserial-130");
    expect(container.textContent).toContain("Now: Probe");
    expect(container.textContent).not.toContain("Check boot advertising");
    expect(container.textContent).not.toContain("Flash BLE server");
    expect(window.instafyDesktop?.localHardwareIoOpportunities).toHaveBeenCalledWith();
    expect(container.querySelector('[data-testid="project-hardware-open-desktop"]')).toBeNull();
    expect(container.querySelector('[data-testid="project-hardware-serial-device"]')).not.toBeNull();

    await act(async () => {
      container
        .querySelector('[data-testid="project-hardware-io-probe-cu.usbserial-130"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(window.instafyDesktop?.localHardwareIoRunAction).toHaveBeenCalledWith({
      actionId: "serial.probe",
      resource: {
        kind: "serial_device",
        id: "/dev/cu.usbserial-130",
        path: "/dev/cu.usbserial-130",
        displayName: "cu.usbserial-130",
      },
    });
    expect(container.textContent).toContain(
      "Serial probe succeeded for /dev/cu.usbserial-130.",
    );
    expect(container.textContent).toContain("readable: yes");

    await act(async () => {
      container
        .querySelector('[data-testid="project-hardware-io-opportunity-cu.usbserial-130"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await act(async () => {
      container
        .querySelector('[data-testid="project-hardware-grant"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(upsertProjectHardwareBindingMock).toHaveBeenCalledWith({
      projectId: "project-1",
      providerId: "hardware.serial",
      runtimeHostId: "desktop-host-1",
      runtimeHostLabel: "Desktop on Taylor MacBook",
      purpose:
        "Allow a local Instafy runtime to discover and probe host USB serial devices.",
      grantedCapabilities: ["hardware_serial_list", "hardware_serial_probe"],
      grantedResources: [
        {
          kind: "serial_device",
          id: "/dev/cu.usbserial-130",
          path: "/dev/cu.usbserial-130",
          displayName: "cu.usbserial-130",
        },
      ],
    });
  });

  it("revokes serial device access without affecting provider file access", async () => {
    readProjectProviderBindingStoreMock.mockResolvedValue(createProviderBindingStore());
    readProjectHardwareBindingStoreMock
      .mockResolvedValueOnce(createHardwareBindingStore())
      .mockResolvedValueOnce({
        version: 1,
        bindings: {},
      });
    revokeProjectHardwareBindingMock.mockResolvedValue(true);

    await act(async () => {
      root.render(<ProjectProviderBindingsCard projectId="project-1" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="project-provider-binding-demo"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="project-hardware-binding-hardware.serial-runtime-local"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="project-access-subnav"]')).toBeNull();
    expect(container.textContent).toContain("1 provider · 1 runtime host");

    await act(async () => {
      container
        .querySelector('[data-testid="project-hardware-binding-revoke-hardware.serial-runtime-local"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(window.confirm).toHaveBeenCalledWith(
      "Revoke local device access for Taylor MacBook?",
    );
    expect(revokeProjectHardwareBindingMock).toHaveBeenCalledWith({
      projectId: "project-1",
      providerId: "hardware.serial",
      bindingId: "hardware.serial@runtime-local",
      runtimeHostId: "runtime-local",
    });
    expect(showStatusMock).toHaveBeenCalledWith(
      "Revoked local device access for Taylor MacBook.",
      "success",
      2500,
    );
    expect(container.textContent).toContain("1 provider");
    expect(
      container.querySelector('[data-testid="project-hardware-binding-hardware.serial-runtime-local"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="project-provider-binding-demo"]'),
    ).not.toBeNull();
  });
});
