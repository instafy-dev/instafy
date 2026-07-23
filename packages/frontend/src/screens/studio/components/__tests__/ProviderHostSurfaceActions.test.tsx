// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProviderHostSurfaceActions,
  type SurfaceAction,
} from "../ProviderHostSurfaceActions";

describe("ProviderHostSurfaceActions", () => {
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

  it("renders host-bound actions and invokes the bound callback", async () => {
    const onPress = vi.fn().mockResolvedValue(undefined);
    const actions: SurfaceAction[] = [
      {
        label: "Desktop host",
        description: "Turn this Mac into a shared speech host.",
        variant: "primary",
        binding: {
          hostBindingId: "desktop_voice_host_toggle",
        },
      },
    ];

    await act(async () => {
      root.render(
        <ProviderHostSurfaceActions
          actions={actions}
          hostBindings={{
            desktop_voice_host_toggle: {
              label: "Enable on this Mac",
              description: "Desktop voice hosting is currently off on this Mac.",
              onPress,
            },
          }}
        />,
      );
      await Promise.resolve();
    });

    const button = container.querySelector(
      '[data-testid="provider-host-surface-action-desktop-host"]',
    ) as HTMLButtonElement | null;

    expect(button?.textContent).toContain("Enable on this Mac");
    expect(container.textContent).toContain("Desktop voice hosting is currently off on this Mac.");

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
