// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProviderSummary } from "@instafy/provider-contract";
import {
  ProviderHostSurfaceControls,
  readSurfaceControlBindings,
  type SurfaceControl,
} from "../ProviderHostSurfaceControls";

const {
  readLocalProviderResourceMock,
  callLocalProviderToolMock,
} = vi.hoisted(() => ({
  readLocalProviderResourceMock: vi.fn(),
  callLocalProviderToolMock: vi.fn(),
}));

vi.mock("../../../../capabilities/localProviderHostClient", () => ({
  readLocalProviderResource: readLocalProviderResourceMock,
  callLocalProviderTool: callLocalProviderToolMock,
}));

describe("ProviderHostSurfaceControls", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    readLocalProviderResourceMock.mockReset();
    callLocalProviderToolMock.mockReset();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("resolves binding aliases against provider summaries", () => {
    const provider = createProviderSummary({
      id: "demo",
      title: "Demo",
      resourceAliases: {
        speechStatus: "instafy://demo/status",
      },
      toolAliases: {
        bootstrapHostDependencies: "instafy.demo.set_route",
      },
    });

    const bindings = readSurfaceControlBindings(provider, [
      {
        kind: "select",
        label: "Speech route",
        options: [],
        disabled: false,
        binding: {
          readResourceAlias: "speechStatus",
          writeToolAlias: "bootstrapHostDependencies",
        },
      },
    ]);

    expect(bindings["select:Speech route"]).toEqual({
      readResourceUri: "instafy://demo/status",
      writeToolName: "instafy.demo.set_route",
    });
  });

  it("loads a bound value from a provider resource and writes updates through a provider tool", async () => {
    readLocalProviderResourceMock.mockResolvedValue({
      ok: true,
      value: {
        route: "provider",
      },
    });
    callLocalProviderToolMock.mockResolvedValue({
      ok: true,
      value: {
        route: "device",
      },
    });

    const provider = createProviderSummary({
      id: "demo",
      title: "Demo",
      resourceAliases: {
        speechStatus: "instafy://demo/status",
      },
    });

    const controls: SurfaceControl[] = [
      {
        kind: "select",
        label: "Speech route",
        description: "Resolve route through the generic provider surface.",
        placeholder: "Auto",
        disabled: false,
        options: [
          { label: "Provider", value: "provider" },
          { label: "Device", value: "device" },
        ],
        binding: {
          readResourceAlias: "speechStatus",
          valuePath: "route",
          writeToolName: "instafy.demo.set_route",
          writeValueArgument: "route",
        },
      },
    ];

    await act(async () => {
      root.render(<ProviderHostSurfaceControls provider={provider} controls={controls} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const select = container.querySelector(
      '[data-testid="provider-host-surface-control-demo-speech-route"]',
    ) as HTMLSelectElement | null;

    expect(readLocalProviderResourceMock).toHaveBeenCalledWith("demo", "instafy://demo/status");
    expect(select?.value).toBe("provider");
    expect(select?.labels?.[0]?.textContent).toBe("Speech route");

    await act(async () => {
      select!.value = "device";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(callLocalProviderToolMock).toHaveBeenCalledWith("demo", "instafy.demo.set_route", {
      route: "device",
    });
  });

  it("reads and writes host-managed bindings without calling provider resources", async () => {
    const hostBindingOnChange = vi.fn().mockResolvedValue(undefined);
    const provider = createProviderSummary({
      id: "demo",
      title: "Demo",
    });

    const controls: SurfaceControl[] = [
      {
        kind: "select",
        label: "Speech route",
        description: "Resolve route through the generic provider surface.",
        placeholder: "Auto",
        disabled: false,
        options: [
          { label: "Auto", value: "auto" },
          { label: "Provider", value: "provider" },
          { label: "Device", value: "device" },
        ],
        binding: {
          hostBindingId: "speech_route_mode",
        },
      },
    ];

    await act(async () => {
      root.render(
        <ProviderHostSurfaceControls
          provider={provider}
          controls={controls}
          hostBindings={{
            speech_route_mode: {
              value: "provider",
              onChange: hostBindingOnChange,
            },
          }}
        />,
      );
      await Promise.resolve();
    });

    const select = container.querySelector(
      '[data-testid="provider-host-surface-control-demo-speech-route"]',
    ) as HTMLSelectElement | null;

    expect(select?.value).toBe("provider");
    expect(readLocalProviderResourceMock).not.toHaveBeenCalled();

    await act(async () => {
      select!.value = "device";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    expect(hostBindingOnChange).toHaveBeenCalledWith("device");
    expect(callLocalProviderToolMock).not.toHaveBeenCalled();
  });

  it("uses host-managed options and descriptions for bound select controls", async () => {
    const provider = createProviderSummary({
      id: "demo",
      title: "Demo",
    });

    const controls: SurfaceControl[] = [
      {
        kind: "select",
        label: "Provider voice",
        description: "Static description should be overridden.",
        placeholder: "Automatic provider voice",
        disabled: false,
        options: [],
        binding: {
          hostBindingId: "speech_provider_voice",
        },
      },
    ];

    await act(async () => {
      root.render(
        <ProviderHostSurfaceControls
          provider={provider}
          controls={controls}
          hostBindings={{
            speech_provider_voice: {
              value: "alloy",
              description: "Provider reply voice: Alloy.",
              placeholder: "Automatic (nova)",
              onChange: vi.fn(),
              options: [
                { label: "Alloy", value: "alloy" },
                { label: "Nova", value: "nova" },
              ],
            },
          }}
        />,
      );
      await Promise.resolve();
    });

    const select = container.querySelector(
      '[data-testid="provider-host-surface-control-demo-provider-voice"]',
    ) as HTMLSelectElement | null;

    expect(select).toBeTruthy();
    expect(Array.from(select?.options ?? []).map((option) => option.textContent)).toEqual([
      "Automatic (nova)",
      "Alloy",
      "Nova",
    ]);
    expect(container.textContent).toContain("Provider reply voice: Alloy.");
    expect(container.textContent).not.toContain("Static description should be overridden.");
    expect(readLocalProviderResourceMock).not.toHaveBeenCalled();
  });

  it("hides controls through host bindings", async () => {
    const provider = createProviderSummary({
      id: "demo",
      title: "Demo",
    });

    const controls: SurfaceControl[] = [
      {
        kind: "select",
        label: "Provider voice",
        description: "No provider voice list is exposed yet.",
        placeholder: "Automatic provider voice",
        disabled: false,
        options: [],
        binding: {
          hostBindingId: "speech_provider_voice",
        },
      },
    ];

    await act(async () => {
      root.render(
        <ProviderHostSurfaceControls
          provider={provider}
          controls={controls}
          hostBindings={{
            speech_provider_voice: {
              hidden: true,
            },
          }}
        />,
      );
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("Provider voice");
    expect(container.querySelector(
      '[data-testid="provider-host-surface-control-demo-provider-voice"]',
    )).toBeNull();
  });

  it("does not show a host-managed badge for readonly bindings", async () => {
    const provider = createProviderSummary({
      id: "demo",
      title: "Demo",
    });

    const controls: SurfaceControl[] = [
      {
        kind: "readonly",
        label: "Preference source",
        description: "Shared or local.",
        disabled: false,
        options: [],
        binding: {
          hostBindingId: "speech_preference_source",
        },
      },
    ];

    await act(async () => {
      root.render(
        <ProviderHostSurfaceControls
          provider={provider}
          controls={controls}
          hostBindings={{
            speech_preference_source: {
              value: "Using defaults",
              description: "No voice override is saved yet.",
              disabled: true,
            },
          }}
        />,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Using defaults");
    expect(container.textContent).not.toContain("Host-managed");
  });
});
