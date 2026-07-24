// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clearForProjectMock = vi.hoisted(() => vi.fn());

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    browserProfiles: {
      clearForProject: clearForProjectMock,
    },
  },
}));

import {
  CLEAR_SHARED_BROWSER_DATA_CONFIRMATION,
  SharedBrowserDataClearAction,
} from "../SharedBrowserDataClearAction";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("SharedBrowserDataClearAction", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    clearForProjectMock.mockReset();
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT;
  });

  it("is writer-only and remains available while the viewer is disconnected", async () => {
    await act(async () => {
      root.render(
        <SharedBrowserDataClearAction
          canClear={false}
          onClearSettled={vi.fn()}
          onClearStart={vi.fn()}
          projectId="project-1"
        />,
      );
    });
    expect(container.querySelector("button")).toBeNull();

    await act(async () => {
      root.render(
        <SharedBrowserDataClearAction
          canClear
          onClearSettled={vi.fn()}
          onClearStart={vi.fn()}
          projectId="project-1"
        />,
      );
    });
    expect(
      container.querySelector('[aria-label="Clear shared browser data"]'),
    ).toBeTruthy();
  });

  it("does nothing when confirmation is cancelled", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    const onClearStart = vi.fn();
    const onClearSettled = vi.fn();
    await act(async () => {
      root.render(
        <SharedBrowserDataClearAction
          canClear
          onClearSettled={onClearSettled}
          onClearStart={onClearStart}
          projectId="project-1"
        />,
      );
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")?.click();
    });

    expect(window.confirm).toHaveBeenCalledWith(
      CLEAR_SHARED_BROWSER_DATA_CONFIRMATION,
    );
    expect(clearForProjectMock).not.toHaveBeenCalled();
    expect(onClearStart).not.toHaveBeenCalled();
    expect(onClearSettled).not.toHaveBeenCalled();
  });

  it("locks duplicate requests, announces success, and reconnects after settlement", async () => {
    const request = deferred<{ success: true }>();
    clearForProjectMock.mockReturnValue(request.promise);
    const onClearStart = vi.fn();
    const onClearSettled = vi.fn();
    const showStatus = vi.fn();
    await act(async () => {
      root.render(
        <SharedBrowserDataClearAction
          canClear
          onClearSettled={onClearSettled}
          onClearStart={onClearStart}
          projectId="project-1"
          showStatus={showStatus}
        />,
      );
    });

    const button = container.querySelector<HTMLButtonElement>("button")!;
    await act(async () => {
      button.click();
      button.click();
      await Promise.resolve();
    });
    expect(clearForProjectMock).toHaveBeenCalledTimes(1);
    expect(clearForProjectMock).toHaveBeenCalledWith("project-1");
    expect(onClearStart).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Clearing shared browser data"]',
      )?.disabled,
    ).toBe(true);

    await act(async () => {
      request.resolve({ success: true });
      await request.promise;
    });
    expect(showStatus).toHaveBeenCalledWith(
      "Shared Browser data cleared. Starting a fresh browser…",
      "success",
      3500,
    );
    expect(onClearSettled).toHaveBeenCalledWith(true);
    expect(
      container.querySelector('[aria-label="Clear shared browser data"]'),
    ).toBeTruthy();
  });

  it("shows the controller failure and still restores the connection once", async () => {
    clearForProjectMock.mockResolvedValue({
      success: false,
      error: "Reset could not stop the runtime.",
    });
    const onClearSettled = vi.fn();
    const showStatus = vi.fn();
    await act(async () => {
      root.render(
        <SharedBrowserDataClearAction
          canClear
          onClearSettled={onClearSettled}
          onClearStart={vi.fn()}
          projectId="project-1"
          showStatus={showStatus}
        />,
      );
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(showStatus).toHaveBeenCalledWith(
      "Reset could not stop the runtime.",
      "error",
      4500,
    );
    expect(onClearSettled).toHaveBeenCalledWith(false);
  });
});
