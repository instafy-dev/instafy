// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useExtensionPanelViewState } from "../useExtensionPanelViewState";

type HookValue = ReturnType<typeof useExtensionPanelViewState>;

function Harness(props: {
  activeProjectId: string | null;
  onValue: (value: HookValue) => void;
  refreshLocalProviders?: () => Promise<void>;
}) {
  const value = useExtensionPanelViewState({
    activeProjectId: props.activeProjectId,
    activeProjectName: props.activeProjectId ? `Project ${props.activeProjectId}` : null,
    projectExtensions: [],
    projectIntegrations: [],
    refreshLocalProviders: props.refreshLocalProviders ?? (async () => {}),
    refreshProjectIntegrations: async () => {},
    showStatus: vi.fn(),
    updateNativeRuntimeStatus: vi.fn(),
    updateNativeAuxiliaryStatus: vi.fn(),
    updateNativeCameraStatus: vi.fn(),
  });
  props.onValue(value);
  return null;
}

describe("useExtensionPanelViewState", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latestValue: HookValue | null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latestValue = null;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("resets expanded provider rows when the active project changes", async () => {
    await act(async () => {
      root.render(
        <Harness
          activeProjectId="project-a"
          onValue={(value) => {
            latestValue = value;
          }}
        />,
      );
    });

    await act(async () => {
      latestValue?.sectionActions.rowController.onToggleDetails("provider-1");
    });

    expect(latestValue?.uiState.expandedProviderDetails).toEqual({ "provider-1": true });

    await act(async () => {
      root.render(
        <Harness
          activeProjectId="project-b"
          onValue={(value) => {
            latestValue = value;
          }}
        />,
      );
    });

    expect(latestValue?.uiState.expandedProviderDetails).toEqual({});
  });

  it("keeps developer-details toggle state local until explicitly changed", async () => {
    await act(async () => {
      root.render(
        <Harness
          activeProjectId="project-a"
          onValue={(value) => {
            latestValue = value;
          }}
        />,
      );
    });

    expect(latestValue?.developerDetailsToggleProps.isSelected).toBe(false);

    await act(async () => {
      latestValue?.developerDetailsToggleProps.onChange(true);
    });

    expect(latestValue?.developerDetailsToggleProps.isSelected).toBe(true);

    await act(async () => {
      latestValue?.developerDetailsToggleProps.onChange(false);
    });

    expect(latestValue?.developerDetailsToggleProps.isSelected).toBe(false);
  });

  it("exposes section actions without panel-side rebinding", async () => {
    const refreshLocalProviders = vi.fn(async () => {});

    await act(async () => {
      root.render(
        <Harness
          activeProjectId="project-a"
          refreshLocalProviders={refreshLocalProviders}
          onValue={(value) => {
            latestValue = value;
          }}
        />,
      );
    });

    await act(async () => {
      await latestValue?.sectionActions.rowController.refreshLocalProviders();
    });

    expect(refreshLocalProviders).toHaveBeenCalledTimes(1);
  });
});
