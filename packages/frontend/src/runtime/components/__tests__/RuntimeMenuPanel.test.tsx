// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeMenuPanel } from "../RuntimeMenuPanel";
import type { RuntimeMenuOption } from "../../useRuntimeMenu";

function runtimeOption(
  overrides: Partial<RuntimeMenuOption> = {},
): RuntimeMenuOption {
  return {
    id: "cloud-runtime-1",
    label: "Instafy Cloud runtime",
    detail: null,
    state: "offline",
    badge: null,
    isSessionOverride: false,
    tunnel: null,
    needsActivation: false,
    isLikelyLocal: false,
    ...overrides,
  };
}

describe("RuntimeMenuPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

  async function renderPanel({
    runtimeEnsureError = null,
    onRetryHosted,
    runtimeOptions = [],
    selectedRuntimeId = null,
    onStartRuntime,
  }: {
    runtimeEnsureError?: string | null;
    onRetryHosted: () => void | Promise<boolean>;
    runtimeOptions?: RuntimeMenuOption[];
    selectedRuntimeId?: string | null;
    onStartRuntime?: (runtimeId: string | null) => void;
  }) {
    await act(async () => {
      root.render(
        <RuntimeMenuPanel
          runtimeEnsureError={runtimeEnsureError}
          connectionWarning={null}
          onRetryHosted={onRetryHosted}
          runtimeOptions={runtimeOptions}
          selectedRuntimeId={selectedRuntimeId}
          onSelectOption={vi.fn()}
          onStartRuntime={onStartRuntime}
          emptyStateMessage="No runtime is connected to this space yet."
        />,
      );
    });
  }

  it("offers a clear Instafy Cloud start action when no runtime exists", async () => {
    const onRetryHosted = vi.fn(async () => true);
    await renderPanel({ onRetryHosted });

    const startButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="runtime-start-cloud"]',
    );
    expect(startButton).not.toBeNull();
    expect(startButton?.textContent).toContain("Start Instafy Cloud");
    expect(container.querySelector('[data-testid="runtime-reconnect-cloud"]')).toBeNull();

    await act(async () => {
      startButton?.click();
    });

    expect(onRetryHosted).toHaveBeenCalledTimes(1);
  });

  it("promotes reconnect over the empty action after a hosted runtime failure", async () => {
    const onRetryHosted = vi.fn(async () => true);
    await renderPanel({
      runtimeEnsureError: "provider offline",
      onRetryHosted,
      onStartRuntime: vi.fn(),
      runtimeOptions: [runtimeOption()],
    });

    const reconnectButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="runtime-reconnect-cloud"]',
    );
    expect(reconnectButton).not.toBeNull();
    expect(reconnectButton?.textContent).toContain("Reconnect Instafy Cloud");
    expect(container.querySelector('[data-testid="runtime-start-cloud"]')).toBeNull();
    expect(container.querySelector('[data-testid="runtime-start-existing"]')).toBeNull();

    await act(async () => {
      reconnectButton?.click();
    });

    expect(onRetryHosted).toHaveBeenCalledTimes(1);
  });

  it("promotes a restartable offline runtime when no runtime is usable", async () => {
    const onRetryHosted = vi.fn(async () => true);
    const onStartRuntime = vi.fn();
    await renderPanel({
      onRetryHosted,
      onStartRuntime,
      runtimeOptions: [runtimeOption()],
    });

    const startButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="runtime-start-existing"]',
    );
    expect(startButton).not.toBeNull();
    expect(startButton?.textContent).toContain("Start Instafy Cloud runtime");
    expect(container.querySelector('[data-testid="runtime-start-cloud"]')).toBeNull();

    await act(async () => {
      startButton?.click();
    });

    expect(onStartRuntime).toHaveBeenCalledTimes(1);
    expect(onStartRuntime).toHaveBeenCalledWith("cloud-runtime-1");
    expect(onRetryHosted).not.toHaveBeenCalled();
  });

  it("does not promote an offline runtime while another runtime is usable", async () => {
    await renderPanel({
      onRetryHosted: vi.fn(async () => true),
      onStartRuntime: vi.fn(),
      runtimeOptions: [
        runtimeOption(),
        runtimeOption({ id: "ready-runtime", label: "Ready runtime", state: "online" }),
      ],
    });

    expect(container.querySelector('[data-testid="runtime-start-existing"]')).toBeNull();
  });
});
