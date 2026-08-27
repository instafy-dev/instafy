// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeMenuOptionsList } from "../RuntimeMenuOptionsList";
import {
  recordRuntimeResourceSample,
  resetRuntimeResourceHistory,
} from "../../runtimeResourceHistory";
import type { RuntimeMenuOption } from "../../useRuntimeMenu";

vi.mock("../../../projects/useProjects", () => ({
  useProjects: () => ({ activeProjectId: "project-1" }),
}));

const showStatusMock = vi.fn();
vi.mock("../../../status/useStatus", () => ({
  useStatus: () => ({ queue: null, showStatus: showStatusMock, hideStatus: vi.fn() }),
}));

function hostedOption(overrides: Partial<RuntimeMenuOption> = {}): RuntimeMenuOption {
  return {
    id: "cloud-runtime-1",
    label: "Instafy Cloud runtime",
    detail: null,
    state: "online",
    badge: null,
    isSessionOverride: false,
    tunnel: null,
    needsActivation: false,
    isLikelyLocal: false,
    provider: "instafy-cloud",
    launchedAt: "2026-08-24T08:08:00.000Z",
    resources: {
      cpuPct: 12.5,
      memoryUsedBytes: 512 * 1024 * 1024,
      memoryLimitBytes: 2 * 1024 * 1024 * 1024,
      updatedAt: "2026-08-24T08:09:00.000Z",
    },
    ...overrides,
  };
}

describe("RuntimeMenuOptionsList", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetRuntimeResourceHistory();
    showStatusMock.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  function buttonWithText(label: string): HTMLButtonElement | null {
    return (
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.trim() === label,
      ) ?? null
    );
  }

  async function renderList({
    onSelectOption = vi.fn(),
    onTerminateRuntime = vi.fn(),
    onRemoveRuntime = vi.fn(),
    options = [hostedOption()],
  }: {
    onSelectOption?: (runtimeId: string | null) => void;
    onTerminateRuntime?: (runtimeId: string | null) => void;
    onRemoveRuntime?: (runtimeId: string | null) => void;
    options?: RuntimeMenuOption[];
  } = {}) {
    await act(async () => {
      root.render(
        <RuntimeMenuOptionsList
          options={options}
          selectedRuntimeId={null}
          onSelectOption={onSelectOption}
          onTerminateRuntime={onTerminateRuntime}
          onRemoveRuntime={onRemoveRuntime}
        />,
      );
    });
  }

  async function expandDetails() {
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show runtime details"]',
    );
    expect(toggle).not.toBeNull();
    // The disclosure toggle must not nest inside the header's role="button".
    expect(toggle?.closest('[role="button"]')).toBeNull();
    await act(async () => {
      toggle?.click();
    });
  }

  it("selects the runtime from the header row", async () => {
    const onSelectOption = vi.fn();
    await renderList({ onSelectOption });

    const header = container.querySelector<HTMLElement>('[role="button"]');
    expect(header).not.toBeNull();
    await act(async () => {
      header?.click();
    });

    expect(onSelectOption).toHaveBeenCalledTimes(1);
    expect(onSelectOption).toHaveBeenCalledWith("cloud-runtime-1");
  });

  it("keeps detail actions out of the selection surface", async () => {
    const onSelectOption = vi.fn();
    const onTerminateRuntime = vi.fn();
    await renderList({ onSelectOption, onTerminateRuntime });
    await expandDetails();

    // The expanded details render outside the row's role="button", so presses
    // inside them must not bubble into runtime selection.
    const stopButton = buttonWithText("Stop");
    expect(stopButton).not.toBeNull();
    expect(stopButton?.closest('[role="button"]')).toBeNull();

    await act(async () => {
      stopButton?.click();
    });

    expect(onTerminateRuntime).toHaveBeenCalledTimes(1);
    expect(onTerminateRuntime).toHaveBeenCalledWith("cloud-runtime-1");
    expect(onSelectOption).not.toHaveBeenCalled();
  });

  it("requires a separate confirm press before removing", async () => {
    const onSelectOption = vi.fn();
    const onRemoveRuntime = vi.fn();
    await renderList({ onSelectOption, onRemoveRuntime });
    await expandDetails();

    const removeButton = buttonWithText("Remove");
    expect(removeButton).not.toBeNull();
    await act(async () => {
      removeButton?.click();
    });

    expect(onRemoveRuntime).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Remove “Instafy Cloud runtime”?");

    await act(async () => {
      buttonWithText("Cancel")?.click();
    });
    expect(onRemoveRuntime).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Remove “Instafy Cloud runtime”?");

    await act(async () => {
      buttonWithText("Remove")?.click();
    });
    await act(async () => {
      buttonWithText("Remove")?.click();
    });

    expect(onRemoveRuntime).toHaveBeenCalledTimes(1);
    expect(onRemoveRuntime).toHaveBeenCalledWith("cloud-runtime-1");
    expect(onSelectOption).not.toHaveBeenCalled();
  });

  it("acknowledges a copied id with a visible confirmation toast", async () => {
    // Plain "success" toasts are gated off by StatusProvider; the copy ack
    // must request the confirmation presentation or it never renders.
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    await renderList();
    await expandDetails();

    const copyButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="runtime-copy-id-cloud-runtime-1"]',
    );
    expect(copyButton).not.toBeNull();
    await act(async () => {
      copyButton?.click();
    });

    expect(showStatusMock).toHaveBeenCalledWith(
      "Runtime id copied",
      "success",
      expect.any(Number),
      expect.objectContaining({ presentation: "confirmation" }),
    );
  });

  it("disarms a pending remove confirmation when details collapse", async () => {
    const onRemoveRuntime = vi.fn();
    await renderList({ onRemoveRuntime });
    await expandDetails();

    await act(async () => {
      buttonWithText("Remove")?.click();
    });
    expect(container.textContent).toContain("Remove “Instafy Cloud runtime”?");

    const collapse = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Hide runtime details"]',
    );
    await act(async () => {
      collapse?.click();
    });
    await expandDetails();

    expect(container.textContent).not.toContain("Remove “Instafy Cloud runtime”?");
    expect(onRemoveRuntime).not.toHaveBeenCalled();
  });

  it("shows machine size and resource trend in the expanded details", async () => {
    const longId = "24f91e92-888c-48ac-a619-20c6df5cedc3";
    recordRuntimeResourceSample(longId, hostedOption().resources);
    await renderList({ options: [hostedOption({ id: longId })] });
    await expandDetails();

    expect(
      container.querySelector('[data-testid="runtime-size-picker"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="runtime-size-standard"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="runtime-size-boost"]')).not.toBeNull();

    const sparklines = container.querySelector('[data-testid="runtime-resource-sparklines"]');
    expect(sparklines).not.toBeNull();
    expect(sparklines?.textContent).toContain("CPU");
    expect(sparklines?.textContent).toContain("13%");
    expect(sparklines?.textContent).toContain("RAM");
    expect(sparklines?.textContent).toContain("512 MB / 2 GB");

    // The full id is progressive disclosure: compact in the grid, complete in
    // the value's title attribute for hover/copy.
    expect(container.textContent).toContain("24f91e92…edc3");
    expect(container.textContent).not.toContain(longId);
    expect(container.querySelector(`[title="${longId}"]`)).not.toBeNull();
  });
});
