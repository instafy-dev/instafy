// @vitest-environment jsdom

import { act, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const showStatusMock = vi.hoisted(() => vi.fn());

vi.mock("../../status/useStatus", () => ({
  useStatus: () => ({ showStatus: showStatusMock }),
}));

import { useTelemetry } from "../useTelemetry";

type HookResult = ReturnType<typeof useTelemetry>;

function Harness({ resultRef }: { resultRef: MutableRefObject<HookResult | null> }) {
  resultRef.current = useTelemetry();
  return null;
}

describe("useTelemetry", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    showStatusMock.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderTelemetry() {
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => {
      root.render(<Harness resultRef={resultRef} />);
    });
    return resultRef.current!;
  }

  it("names the space's machine when the controller sends no message of its own", async () => {
    const { handleRuntimeTelemetryEvent } = await renderTelemetry();

    handleRuntimeTelemetryEvent({
      kind: "runtime.unavailable",
      data: { reason: "no_runtime_connected" },
    });
    expect(showStatusMock).toHaveBeenLastCalledWith(
      "No machine is connected to this space, so queued requests can't run yet.",
      "error",
      9000,
      expect.objectContaining({ actionLabel: "Open Machines" }),
    );

    handleRuntimeTelemetryEvent({
      kind: "runtime.unavailable",
      data: { reason: "runtime_unavailable", message: "status=offline lastSeen=never" },
    });
    expect(showStatusMock).toHaveBeenLastCalledWith(
      "Instafy couldn't check whether this space's machine is available. Check the controller logs and make sure the runtime agent is running.",
      "warning",
      6000,
      undefined,
    );
  });

  it("shows the controller's own message when it sends one", async () => {
    const { handleRuntimeTelemetryEvent } = await renderTelemetry();

    handleRuntimeTelemetryEvent({
      kind: "runtime.unavailable",
      data: {
        reason: "runtime_unavailable",
        message: "The controller's own sentence.",
      },
    });
    expect(showStatusMock).toHaveBeenLastCalledWith(
      "The controller's own sentence.",
      "warning",
      6000,
      undefined,
    );
  });
});
