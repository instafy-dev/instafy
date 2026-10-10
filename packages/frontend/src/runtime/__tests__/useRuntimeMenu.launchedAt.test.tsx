// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { ControllerRuntimeStatusEntry } from "../../sdk/instafy";
import { useRuntimeMenuOptions, type RuntimeMenuOption } from "../useRuntimeMenu";

const runtimeStatuses: ControllerRuntimeStatusEntry[] = [];

vi.mock("../useRuntime", () => ({
  useRuntime: () => ({
    runtimeStatuses,
    localWorkspace: null,
    tunnelGrants: {},
    sessionRuntimeId: null,
    effectiveRuntimeId: null,
    effectiveRuntimeSource: null,
    preferredRuntimeId: null,
    hostedRuntimeStopAtMs: null,
    runtime: { controllerProjectMissing: false, controllerUnavailable: false },
  }),
}));

function renderOption(runtimeId: string): RuntimeMenuOption | undefined {
  let option: RuntimeMenuOption | undefined;
  function Probe() {
    option = useRuntimeMenuOptions().runtimeOptionsById.get(runtimeId);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => {
    root.render(<Probe />);
  });
  act(() => {
    root.unmount();
  });
  return option;
}

describe("useRuntimeMenuOptions launch time", () => {
  it("counts a hosted machine's uptime from its current launch", () => {
    const runtimeId = "11111111-1111-4111-8111-111111111111";
    runtimeStatuses.splice(0, runtimeStatuses.length, {
      runtimeId,
      status: "ready",
      provider: "instafy-cloud",
      idleTtlSeconds: 300,
      // The space's hosted runtime row, created days before this machine.
      createdAt: "2026-10-07T12:40:54.000Z",
      launchRequestedAt: "2026-10-10T16:22:07.000Z",
      lastSeenAt: "2026-10-10T16:22:25.000Z",
      isLocal: false,
      isPreferred: false,
      health: "online",
    });
    expect(renderOption(runtimeId)?.launchedAt).toBe("2026-10-10T16:22:07.000Z");
  });
});
