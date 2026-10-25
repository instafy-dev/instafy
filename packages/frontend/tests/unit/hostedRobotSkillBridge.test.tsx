// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listForProject: vi.fn() }));
vi.mock("@instafy/frontend/feature-api/controller", () => ({
  controllerClient: {
    integrations: { listForProject: mocks.listForProject },
    providerRequests: { list: async () => [] },
  },
  getProjectIntegrationByProvider: () => null,
  getProjectProviderSelectedDevice: () => null,
}));
vi.mock("@instafy/frontend/feature-api/runtime-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@instafy/frontend/feature-api/runtime-bridge")>()),
  useActiveProjectId: () => "11111111-2222-4333-8444-555555555555",
}));

import { ROBOT_FRONTEND_FEATURE_MODULE } from "../../hosted/robot";

type DesktopWindow = Window & { instafyDesktop?: { invokeDesktopExtension?: unknown } };

let root: Root;
let container: HTMLDivElement;

function renderBridges() {
  const bridges = ROBOT_FRONTEND_FEATURE_MODULE.studioRuntimeBridges ?? [];
  expect(bridges.length).toBeGreaterThan(0);
  return act(async () => root.render(bridges.map((bridge) => createElement(bridge.component, { key: bridge.id }))));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  mocks.listForProject.mockReset();
  mocks.listForProject.mockResolvedValue({ success: true, integrations: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete (window as DesktopWindow).instafyDesktop;
  vi.useRealTimers();
});

describe("hosted robot skill request bridge", () => {
  // Measurements A and B: a plain web tab read the space's integrations every
  // 10.5 s, visible or hidden, for a claim loop that can never claim there.
  it("does not poll on a web client without a robot runtime", async () => {
    await renderBridges();
    await act(async () => { await vi.advanceTimersByTimeAsync(64_000); });
    expect(mocks.listForProject).not.toHaveBeenCalled();
  });

  it("keeps its claim loop where a robot runtime is available", async () => {
    (window as DesktopWindow).instafyDesktop = { invokeDesktopExtension: async () => ({}) };
    await renderBridges();
    await act(async () => { await vi.advanceTimersByTimeAsync(64_000); });
    expect(mocks.listForProject.mock.calls.length).toBeGreaterThanOrEqual(6);
  });
});
