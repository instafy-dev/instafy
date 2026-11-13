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

function desktopEntry(runtimeId: string, claudeCode?: ControllerRuntimeStatusEntry["claudeCode"]): ControllerRuntimeStatusEntry {
  return {
    runtimeId,
    status: "ready",
    provider: "self-hosted",
    idleTtlSeconds: 300,
    lastSeenAt: new Date().toISOString(),
    isLocal: true,
    isPreferred: false,
    health: "online",
    ...(claudeCode === undefined ? {} : { claudeCode }),
  };
}

describe("useRuntimeMenuOptions Claude Code capability", () => {
  it("carries the status entry's claudeCode to the composer, and null without one", () => {
    const ready = { ready: true, reason: null, cli: "2.1.314", verified: true, planSignIn: true };
    runtimeStatuses.splice(
      0,
      runtimeStatuses.length,
      desktopEntry("11111111-1111-4111-8111-111111111111", ready),
      desktopEntry("22222222-2222-4222-8222-222222222222"),
    );
    expect(renderOption("11111111-1111-4111-8111-111111111111")?.claudeCode).toEqual(ready);
    expect(renderOption("22222222-2222-4222-8222-222222222222")?.claudeCode).toBeNull();
  });
});
