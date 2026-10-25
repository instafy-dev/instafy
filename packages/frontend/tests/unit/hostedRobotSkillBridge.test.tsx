// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listForProject: vi.fn(),
  listRequests: vi.fn(),
  integration: null as Record<string, unknown> | null,
  platform: "web",
  nativeStatus: null as Record<string, unknown> | null,
}));
vi.mock("@instafy/frontend/feature-api/controller", () => ({
  controllerClient: {
    integrations: { listForProject: mocks.listForProject },
    providerRequests: { list: mocks.listRequests },
  },
  getProjectIntegrationByProvider: () => mocks.integration,
  getProjectProviderSelectedDevice: () => null,
}));
vi.mock("@instafy/frontend/feature-api/runtime-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@instafy/frontend/feature-api/runtime-bridge")>()),
  useActiveProjectId: () => "11111111-2222-4333-8444-555555555555",
}));
// The web build unless a test plays the phone app, whose native BLE plugin
// then answers every call with `mocks.nativeStatus`.
vi.mock("@capacitor/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@capacitor/core")>();
  const nativePlugin = new Proxy({}, {
    get: (_target, key) => (key === "then" ? undefined : async () => mocks.nativeStatus),
  });
  return {
    ...actual,
    Capacitor: { ...actual.Capacitor, getPlatform: () => mocks.platform, isNativePlatform: () => mocks.platform !== "web" },
    registerPlugin: ((name: string, implementations?: object) =>
      mocks.platform === "web" ? actual.registerPlugin(name, implementations) : nativePlugin) as typeof actual.registerPlugin,
  };
});

import { ROBOT_FRONTEND_FEATURE_MODULE } from "../../hosted/robot";

// Only the member the robot runtime adapter looks for.
type DesktopWindow = { instafyDesktop?: { invokeDesktopExtension?: unknown } };

let root: Root;
let container: HTMLDivElement;

function renderBridges() {
  const bridges = ROBOT_FRONTEND_FEATURE_MODULE.studioRuntimeBridges ?? [];
  expect(bridges.length).toBeGreaterThan(0);
  return act(async () => root.render(bridges.map((bridge) => createElement(bridge.component, { key: bridge.id }))));
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

// Desktop Chrome, Edge and Electron: Web Bluetooth in a secure context.
function useChromiumWebBluetooth() {
  Object.defineProperty(navigator, "bluetooth", { configurable: true, value: {} });
  Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: true });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  setVisibility("visible");
  window.dispatchEvent(new Event("pointerdown"));
  mocks.listForProject.mockReset();
  mocks.listForProject.mockResolvedValue({ success: true, integrations: [] });
  mocks.listRequests.mockReset();
  mocks.listRequests.mockResolvedValue([]);
  mocks.integration = null;
  mocks.platform = "web";
  mocks.nativeStatus = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete (window as unknown as DesktopWindow).instafyDesktop;
  delete (navigator as { bluetooth?: unknown }).bluetooth;
  delete (globalThis as { isSecureContext?: unknown }).isSecureContext;
  setVisibility("visible");
  vi.useRealTimers();
});

describe("hosted robot skill request bridge", () => {
  // Measurements A and B: a plain web tab read the space's integrations every
  // 10.5 s, visible or hidden, for a claim loop that can never claim there.
  it("does not poll on a web client without a robot runtime", async () => {
    await renderBridges();
    await advance(64_000);
    expect(mocks.listForProject).not.toHaveBeenCalled();
  });

  it("with nothing attached on Chromium, looks again every 30 s while active and never while hidden", async () => {
    useChromiumWebBluetooth();
    await renderBridges();
    await advance(64_000);
    // 0, 30 and 60 s.
    expect(mocks.listForProject).toHaveBeenCalledTimes(3);
    await act(async () => setVisibility("hidden"));
    await advance(64_000);
    expect(mocks.listForProject).toHaveBeenCalledTimes(3);
    // The last look is over 30 s old: the return looks at once.
    await act(async () => setVisibility("visible"));
    await advance(0);
    expect(mocks.listForProject).toHaveBeenCalledTimes(4);
  });

  it("with nothing attached on Desktop, backs off to every 5 min once idle and ignores quick flips", async () => {
    (window as unknown as DesktopWindow).instafyDesktop = { invokeDesktopExtension: async () => ({}) };
    await advance(1_000);
    await renderBridges();
    await advance(200_000);
    // At 1, 31, ..., 151 s; idle from 180 s moves the next to 5 min after 151 s.
    const settled = mocks.listForProject.mock.calls.length;
    expect(settled).toBe(6);
    await advance(249_000);
    expect(mocks.listForProject).toHaveBeenCalledTimes(settled);
    await advance(1_000);
    expect(mocks.listForProject).toHaveBeenCalledTimes(settled + 1);
    window.dispatchEvent(new Event("pointerdown"));
    for (let flip = 0; flip < 6; flip += 1) {
      await act(async () => setVisibility("hidden"));
      await advance(2_300);
      await act(async () => setVisibility("visible"));
      await advance(2_300);
    }
    expect(mocks.listForProject).toHaveBeenCalledTimes(settled + 1);
  });

  it("keeps its 2.5 s claim loop where an attached device resolves (the phone's BLE bridge)", async () => {
    mocks.integration = { provider: "robot-arm", status: "attached", metadata: {} };
    mocks.platform = "android";
    mocks.nativeStatus = { supported: true, platform: "android", bleSupported: true, connection: { ready: true, deviceAddress: "AA:BB:CC:DD:EE:FF" } };
    await renderBridges();
    await advance(64_000);
    expect(mocks.listRequests.mock.calls.length).toBeGreaterThanOrEqual(20);
    expect(mocks.listForProject.mock.calls.length).toBeGreaterThanOrEqual(20);
  });
});
