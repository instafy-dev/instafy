// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearIdlePaused, isIdlePaused } from "../../idlePauseRegistry";
import { useRuntimeStopNotice } from "../useRuntimeStopNotice";

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUNTIME_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const showStatus = vi.fn();
const openPanelTab = vi.fn();

function Studio({ hostedRuntimeReady }: { hostedRuntimeReady: boolean }) {
  useRuntimeStopNotice({
    activeProjectId: PROJECT_ID,
    hostedRuntimeReady,
    showStatus,
    openPanelTab,
  });
  return null;
}

describe("useRuntimeStopNotice", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function render(hostedRuntimeReady: boolean) {
    await act(async () => {
      root.render(<Studio hostedRuntimeReady={hostedRuntimeReady} />);
    });
  }

  /** The controller event as useRuntimeControllerSync forwards it. */
  async function publishStop(data: Record<string, unknown>) {
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("instafy:runtime-lifecycle-event", {
          detail: {
            projectId: PROJECT_ID,
            kind: "runtime.stopped",
            data: { runtimeId: RUNTIME_ID, status: "stopped", ...data },
          },
        }),
      );
    });
  }

  const notices = (id: string) =>
    showStatus.mock.calls.filter((call) => (call[3] as { id?: string } | undefined)?.id === id);

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    showStatus.mockClear();
    openPanelTab.mockClear();
    clearIdlePaused(PROJECT_ID);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    clearIdlePaused(PROJECT_ID);
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("explains an idle stop and holds the space", async () => {
    await render(true);
    await publishStop({ reason: "idle" });

    expect(isIdlePaused(PROJECT_ID)).toBe(true);
    expect(notices("runtime-paused-idle")).toHaveLength(1);
  });

  it("holds the space again on a repeat of the same idle stop, without a second notice", async () => {
    await render(true);
    await publishStop({ reason: "idle" });
    await render(false);
    // A person's request lifts the hold; this tab never sees the machine
    // come up before the same stop reaches it again.
    await act(async () => {
      clearIdlePaused(PROJECT_ID);
    });
    await publishStop({ reason: "idle" });

    expect(isIdlePaused(PROJECT_ID)).toBe(true);
    expect(notices("runtime-paused-idle")).toHaveLength(1);
  });

  it("explains every idle stop of the same machine once it came up again", async () => {
    await render(true);
    for (let stop = 1; stop <= 3; stop += 1) {
      await publishStop({ reason: "idle" });
      // The status refresh after the event shows the machine stopped.
      await render(false);
      expect(isIdlePaused(PROJECT_ID)).toBe(true);
      expect(notices("runtime-paused-idle")).toHaveLength(stop);
      // The person writes in the chat and the machine comes back.
      await act(async () => {
        clearIdlePaused(PROJECT_ID);
      });
      await render(true);
    }
  });

  it("shows one notice for one stop while the status still reads ready", async () => {
    await render(true);
    await publishStop({ reason: "idle" });
    await publishStop({ reason: "idle" });
    await render(true);
    await publishStop({ reason: "idle" });

    expect(notices("runtime-paused-idle")).toHaveLength(1);
  });
});
