// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevDiagnosticsMenu } from "../DevDiagnosticsMenu";
import type { RuntimeMenuOption } from "../../../../runtime/useRuntimeMenu";

const showStatus = vi.fn();
vi.mock("../../../../status/useStatus", () => ({
  useStatus: () => ({ showStatus }),
}));

// Keep the runtime card hermetic: the state indicator and tunnel label helpers
// pull in the full runtime-menu module graph, which this modal's tests don't
// exercise.
vi.mock("../../../../runtime/runtimeMenuShared", () => ({
  RuntimeStateIndicator: () => null,
  RUNTIME_BADGE_CLASSES: { neutral: "", warning: "", danger: "" },
  formatTunnelLabel: () => "tunnel.example.dev",
}));
vi.mock("../../../../runtime/runtimeLabels", () => ({
  extractTunnelEntitlementDetails: () => null,
  formatTunnelEntitlementDetail: () => null,
  resolveTunnelStatusBadge: () => null,
}));

function makeRuntimeOption(overrides: Partial<RuntimeMenuOption> = {}): RuntimeMenuOption {
  return {
    id: "rt-1",
    label: "Desktop runtime",
    detail: "localhost:4823",
    state: "online" as RuntimeMenuOption["state"],
    badge: null,
    isSessionOverride: false,
    tunnel: { id: "tun-1" } as unknown as RuntimeMenuOption["tunnel"],
    needsActivation: false,
    isLikelyLocal: true,
    ...overrides,
  };
}

describe("DevDiagnosticsMenu", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("matchMedia", () => ({
      addEventListener: vi.fn(),
      matches: false,
      removeEventListener: vi.fn(),
    }));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    showStatus.mockClear();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    vi.unstubAllGlobals();
    container.remove();
  });

  const baseProps = {
    onClose: vi.fn(),
    runtimeOptions: [] as RuntimeMenuOption[],
    onCopyTunnel: vi.fn(),
  };

  it("renders the house dialog header and the build label", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(<DevDiagnosticsMenu {...baseProps} onClose={onClose} />);
    });

    expect(container.textContent).toContain("Diagnostics");
    // Frontend build label always resolves in a web (non-desktop) environment.
    const version = container.querySelector('[data-testid="app-version-label"]');
    expect(version?.textContent).toMatch(/^v/);

    const close = container.querySelector(
      '[aria-label="Close diagnostics"]',
    ) as HTMLButtonElement | null;
    expect(close).not.toBeNull();
    await act(async () => {
      close?.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps quiet defaults: no Empty labels, no runtimes section, no migration note", async () => {
    await act(async () => {
      root.render(
        <DevDiagnosticsMenu {...baseProps} onShowAppLogs={() => {}} hasAppLogs={false} />,
      );
    });

    expect(container.textContent).not.toContain("Empty");
    expect(container.textContent).not.toContain("Runtimes");
    expect(container.textContent).not.toContain("No runtimes detected");
    expect(container.textContent).not.toContain("now live in");
    expect(container.textContent).not.toContain("Supabase URL");
  });

  it("copies build info with a confirmation ack", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    await act(async () => {
      root.render(<DevDiagnosticsMenu {...baseProps} />);
    });

    const copy = container.querySelector(
      '[data-testid="diagnostics-copy-build-info"]',
    ) as HTMLButtonElement | null;
    expect(copy).not.toBeNull();
    await act(async () => {
      copy?.click();
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain("packageVersion");
    // StatusProvider suppresses plain success toasts; copy acks must request
    // the confirmation presentation to actually show.
    expect(showStatus).toHaveBeenCalledWith(
      "Build info copied.",
      "success",
      2500,
      { presentation: "confirmation" },
    );
  });

  it("renders runtime cards with a working tunnel copy control", async () => {
    const onCopyTunnel = vi.fn();
    await act(async () => {
      root.render(
        <DevDiagnosticsMenu
          {...baseProps}
          runtimeOptions={[makeRuntimeOption()]}
          onCopyTunnel={onCopyTunnel}
        />,
      );
    });

    expect(container.textContent).toContain("Runtimes");
    expect(container.textContent).toContain("Desktop runtime");
    // No permanent placeholder for missing tunnel metadata.
    expect(container.textContent).not.toContain("Tunnel metadata unavailable");

    const copy = container.querySelector(
      '[data-testid="diagnostics-copy-tunnel"]',
    ) as HTMLButtonElement | null;
    expect(copy).not.toBeNull();
    await act(async () => {
      copy?.click();
    });
    expect(onCopyTunnel).toHaveBeenCalledWith("url", "rt-1");
  });

  it("shows the touch override row with its reset control", async () => {
    await act(async () => {
      root.render(<DevDiagnosticsMenu {...baseProps} />);
    });

    expect(
      container.querySelector('[data-testid="diagnostics-touch-mode-toggle"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="diagnostics-touch-mode-reset"]'),
    ).not.toBeNull();
  });
});
