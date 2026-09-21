// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import { RuntimeMenuPanel, blockerSpaceMachinesDestination } from "../RuntimeMenuPanel";
import type { RuntimeMenuOption } from "../../useRuntimeMenu";
import { HostedRuntimeBlockerSpaceError } from "../../hostedRuntimeLimitError";

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

  it("points at the blocking space when the blocker cannot be stopped from here", async () => {
    const blockerProjectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const limitError =
      'Instafy Cloud runtime limit reached for this organization (1 active; max 1). Active runtime "Hosted Runtime" is attached to project "Acme" (project bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb, runtime aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa). Stop/remove that runtime, then retry.';
    const onTakeOver = vi.fn(async () => {
      throw new HostedRuntimeBlockerSpaceError({
        blockerProjectId,
        blockerProjectLabel: "Acme",
      });
    });
    let currentSearch = "";
    function LocationProbe() {
      currentSearch = useLocation().search;
      return null;
    }
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/studio?projectId=current-project"]}>
          <LocationProbe />
          <RuntimeMenuPanel
            runtimeEnsureError={limitError}
            connectionWarning={null}
            onRetryHosted={vi.fn(async () => false)}
            onTakeOverHostedRuntimeLimit={onTakeOver}
            runtimeOptions={[runtimeOption()]}
            selectedRuntimeId={null}
            onSelectOption={vi.fn()}
          />
        </MemoryRouter>,
      );
    });

    const takeOverButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Stop blocker and retry"),
    );
    expect(takeOverButton).toBeDefined();
    await act(async () => {
      takeOverButton?.click();
    });

    expect(onTakeOver).toHaveBeenCalledTimes(1);
    const notice = container.querySelector('[data-testid="runtime-blocker-space-notice"]');
    expect(notice?.textContent).toContain(
      'The blocking machine in "Acme" can\'t be stopped from here. Open that space and stop it there.',
    );
    expect(container.querySelector('[data-testid="runtime-action-error"]')).toBeNull();

    const openSpace = container.querySelector<HTMLButtonElement>(
      '[data-testid="runtime-open-blocker-space"]',
    );
    expect(openSpace?.textContent).toContain("Open space");
    await act(async () => {
      openSpace?.click();
    });

    const params = new URLSearchParams(currentSearch);
    expect(params.get("projectId")).toBe(blockerProjectId);
    expect(params.get("panel")).toBe("machines");
    expect(blockerSpaceMachinesDestination(blockerProjectId)).toEqual({
      kind: "route",
      search: `?projectId=${blockerProjectId}&panel=machines`,
    });
  });

  it("hides the blocking-space notice once the limit no longer holds", async () => {
    const limitError =
      'Instafy Cloud runtime limit reached for this organization (1 active; max 1). Active runtime "Hosted Runtime" is attached to project "Acme" (project bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb, runtime aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa). Stop/remove that runtime, then retry.';
    const onTakeOver = vi.fn(async () => {
      throw new HostedRuntimeBlockerSpaceError({
        blockerProjectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        blockerProjectLabel: "Acme",
      });
    });
    const renderWithError = async (runtimeEnsureError: string) => {
      await act(async () => {
        root.render(
          <MemoryRouter initialEntries={["/studio?projectId=current-project"]}>
            <RuntimeMenuPanel
              runtimeEnsureError={runtimeEnsureError}
              connectionWarning={null}
              onRetryHosted={vi.fn(async () => false)}
              onTakeOverHostedRuntimeLimit={onTakeOver}
              runtimeOptions={[runtimeOption()]}
              selectedRuntimeId={null}
              onSelectOption={vi.fn()}
            />
          </MemoryRouter>,
        );
      });
    };
    await renderWithError(limitError);

    const takeOverButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Stop blocker and retry"),
    );
    await act(async () => {
      takeOverButton?.click();
    });
    expect(container.querySelector('[data-testid="runtime-blocker-space-notice"]')).not.toBeNull();

    // The ensure behind the takeover can end in a different refusal; the
    // notice about the blocking space must not be shown next to it.
    await renderWithError("This team is out of credits for today.");

    expect(container.querySelector('[data-testid="runtime-blocker-space-notice"]')).toBeNull();
    expect(container.querySelector('[data-testid="runtime-open-blocker-space"]')).toBeNull();
    expect(container.textContent).toContain("Instafy Cloud could not start the hosted runtime");
  });
});
