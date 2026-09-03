// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerRuntimeStatusEntry } from "../../../sdk/instafy";
import type { ShowStatusFn } from "../types";

// vi.mock is hoisted above module-level consts, so the spy has to be too.
const { requestDesktop } = vi.hoisted(() => ({ requestDesktop: vi.fn() }));

vi.mock("../../../sdk/instafy", async () => {
  const actual = await vi.importActual<typeof import("../../../sdk/instafy")>("../../../sdk/instafy");
  return {
    ...actual,
    controllerClient: {
      ...actual.controllerClient,
      core: { ...actual.controllerClient.core, runtimeIdleTtlSecondsDefault: 900 },
      runtimes: { ...actual.controllerClient.runtimes, requestDesktop },
    },
  };
});

import { useDesktopRuntimeEnsure } from "../useDesktopRuntimeEnsure";

function localRuntime(
  overrides: Partial<ControllerRuntimeStatusEntry> = {},
): ControllerRuntimeStatusEntry {
  return {
    runtimeId: "runtime-local-1",
    status: "ready",
    provider: "self-hosted",
    idleTtlSeconds: 900,
    isLocal: true,
    isPreferred: false,
    health: "online",
    ...overrides,
  };
}

describe("useDesktopRuntimeEnsure", () => {
  let container: HTMLDivElement;
  let root: Root;
  let showStatus: ShowStatusFn & ReturnType<typeof vi.fn>;
  let ensure: (() => Promise<boolean>) | null = null;

  function Harness(props: {
    runtimeStatuses: ControllerRuntimeStatusEntry[];
    onShowSelfHostHelp?: () => void;
  }) {
    const result = useDesktopRuntimeEnsure({
      enabled: true,
      projectId: "project-1",
      runtimeStatuses: props.runtimeStatuses,
      dispatch: vi.fn(),
      refreshRuntimeStatuses: async () => {},
      showStatus,
      onShowSelfHostHelp: props.onShowSelfHostHelp,
    });
    ensure = result.ensureDesktopRuntime;
    return null;
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    showStatus = vi.fn() as ShowStatusFn & ReturnType<typeof vi.fn>;
    requestDesktop.mockReset();
    requestDesktop.mockResolvedValue({ runtime: {}, tunnel: null });
    ensure = null;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("names the registered machine, which is what the controller requires", async () => {
    // Without runtimeId the controller answers 400 "self-hosted runtimes must
    // first register from their owner device", so this call could never work.
    await act(async () => {
      root.render(createElement(Harness, { runtimeStatuses: [localRuntime()] }));
    });
    await act(async () => {
      await ensure?.();
    });

    expect(requestDesktop).toHaveBeenCalledTimes(1);
    expect(requestDesktop.mock.calls[0]?.[0]).toMatchObject({
      projectId: "project-1",
      runtimeId: "runtime-local-1",
    });
  });

  it("does not fire a request that cannot succeed when no machine is registered", async () => {
    const onShowSelfHostHelp = vi.fn();
    await act(async () => {
      root.render(createElement(Harness, { runtimeStatuses: [], onShowSelfHostHelp }));
    });

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await ensure?.();
    });

    expect(outcome).toBe(false);
    expect(requestDesktop).not.toHaveBeenCalled();
    const [message, intent, , options] = showStatus.mock.calls[0] ?? [];
    expect(message).toContain("No self-hosted machine is registered");
    expect(intent).toBe("warning");
    (options as { onAction?: () => void } | undefined)?.onAction?.();
    expect(onShowSelfHostHelp).toHaveBeenCalledTimes(1);
  });

  it("ignores cloud runtimes when looking for the local machine", async () => {
    await act(async () => {
      root.render(
        createElement(Harness, {
          runtimeStatuses: [
            localRuntime({ runtimeId: "runtime-cloud", provider: "instafy-cloud", isLocal: false }),
          ],
        }),
      );
    });
    await act(async () => {
      await ensure?.();
    });

    expect(requestDesktop).not.toHaveBeenCalled();
  });
});
