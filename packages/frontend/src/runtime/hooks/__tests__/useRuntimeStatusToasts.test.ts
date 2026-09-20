// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type {
  ControllerRuntimeStatusEntry,
  LocalWorkspacePresence,
} from "../../../sdk/instafy";
import type { ShowStatusFn } from "../types";
import {
  formatLocalRuntimeOfflineMessage,
  LOCAL_RUNTIME_OFFLINE_TOAST_DEBOUNCE_MS,
  shouldTrackLocalWorkspaceStatus,
  useRuntimeStatusToasts,
} from "../useRuntimeStatusToasts";

function createWorkspace(
  overrides: Partial<LocalWorkspacePresence> = {},
): LocalWorkspacePresence {
  return {
    deviceId: "desktop-device",
    status: "online",
    ...overrides,
  };
}

function createRuntimeEntry(
  overrides: Partial<ControllerRuntimeStatusEntry> = {},
): ControllerRuntimeStatusEntry {
  return {
    runtimeId: "runtime-local-1",
    status: "ready",
    provider: "self-hosted",
    idleTtlSeconds: 300,
    isLocal: true,
    isPreferred: false,
    health: "online",
    ...overrides,
  };
}

type HarnessProps = {
  enabled?: boolean;
  workspace?: LocalWorkspacePresence | null;
  runtimeEntry?: ControllerRuntimeStatusEntry | null;
  selectedLocalRuntimeId?: string | null;
  showStatus: ShowStatusFn;
  onShowSelfHostHelp?: () => void;
};

function RuntimeStatusToastHarness(props: HarnessProps) {
  useRuntimeStatusToasts({
    enabled: props.enabled ?? true,
    workspace: props.workspace ?? null,
    runtimeEntry: props.runtimeEntry ?? null,
    selectedLocalRuntimeId: props.selectedLocalRuntimeId,
    tunnel: null,
    showStatus: props.showStatus,
    onShowSelfHostHelp: props.onShowSelfHostHelp,
  });
  return null;
}

describe("shouldTrackLocalWorkspaceStatus", () => {
  it("returns false when workspace is missing", () => {
    expect(shouldTrackLocalWorkspaceStatus(null, createRuntimeEntry())).toBe(false);
  });

  it("returns false when runtime entry is missing", () => {
    expect(shouldTrackLocalWorkspaceStatus(createWorkspace(), null)).toBe(false);
  });

  it("returns false when runtime entry is not local", () => {
    expect(
      shouldTrackLocalWorkspaceStatus(
        createWorkspace(),
        createRuntimeEntry({ isLocal: false }),
      ),
    ).toBe(false);
  });

  it("returns false when workspace runtime id points to another runtime", () => {
    expect(
      shouldTrackLocalWorkspaceStatus(
        createWorkspace({ runtimeId: "runtime-local-2" }),
        createRuntimeEntry({ runtimeId: "runtime-local-1" }),
      ),
    ).toBe(false);
  });

  it("returns false when workspace runtime id is absent and no local runtime is selected", () => {
    expect(
      shouldTrackLocalWorkspaceStatus(
        createWorkspace({ runtimeId: null }),
        createRuntimeEntry(),
      ),
    ).toBe(false);
  });

  it("returns true when workspace runtime id is absent but selected local runtime matches", () => {
    expect(
      shouldTrackLocalWorkspaceStatus(
        createWorkspace({ runtimeId: null }),
        createRuntimeEntry(),
        "runtime-local-1",
      ),
    ).toBe(true);
  });

  it("returns false when selected local runtime points to another runtime", () => {
    expect(
      shouldTrackLocalWorkspaceStatus(
        createWorkspace({ runtimeId: null }),
        createRuntimeEntry(),
        "runtime-local-2",
      ),
    ).toBe(false);
  });

  it("returns true when workspace runtime id matches the local runtime entry", () => {
    expect(
      shouldTrackLocalWorkspaceStatus(
        createWorkspace({ runtimeId: "runtime-local-1" }),
        createRuntimeEntry({ runtimeId: "runtime-local-1" }),
      ),
    ).toBe(true);
  });
});

describe("local runtime status toasts", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latestProps: HarnessProps;
  let showStatus: Mock;

  const renderHarness = async (overrides: Partial<HarnessProps> = {}) => {
    latestProps = {
      ...latestProps,
      ...overrides,
    };
    await act(async () => {
      root.render(createElement(RuntimeStatusToastHarness, latestProps));
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    showStatus = vi.fn();
    latestProps = {
      workspace: createWorkspace({ runtimeId: "runtime-local-1" }),
      runtimeEntry: createRuntimeEntry({ displayName: "CLI Runtime Dogfood" }),
      showStatus,
    };
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    vi.useRealTimers();
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("uses local-runtime wording instead of claiming a cloud fallback", () => {
    const message = formatLocalRuntimeOfflineMessage("CLI Runtime Dogfood");

    expect(message).toContain("CLI Runtime Dogfood");
    expect(message).toContain("appears offline");
    expect(message).not.toContain("Instafy Cloud");
    expect(message).not.toContain("Falling back");
  });

  it("does not show offline or back-online toasts for a transient workspace status blip", async () => {
    await renderHarness();

    await renderHarness({
      workspace: createWorkspace({
        runtimeId: "runtime-local-1",
        status: "offline",
      }),
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        LOCAL_RUNTIME_OFFLINE_TOAST_DEBOUNCE_MS - 1,
      );
    });
    expect(showStatus).not.toHaveBeenCalled();

    await renderHarness({
      workspace: createWorkspace({
        runtimeId: "runtime-local-1",
        status: "online",
      }),
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        LOCAL_RUNTIME_OFFLINE_TOAST_DEBOUNCE_MS + 10,
      );
    });
    expect(showStatus).not.toHaveBeenCalled();
  });

  it("hands the offline toast a way to bring the machine back", async () => {
    // A self-hosted machine cannot be started from the browser, so the toast's
    // "Reconnect it" resolves to the self-host instructions rather than a start.
    const onShowSelfHostHelp = vi.fn();
    await renderHarness({ onShowSelfHostHelp });
    await renderHarness({
      onShowSelfHostHelp,
      workspace: createWorkspace({ runtimeId: "runtime-local-1", status: "offline" }),
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOCAL_RUNTIME_OFFLINE_TOAST_DEBOUNCE_MS);
    });

    const call = showStatus.mock.calls.find(
      ([message]) => typeof message === "string" && message.includes("appears offline"),
    );
    expect(call).toBeDefined();
    const options = call?.[3] as { actionLabel?: string; onAction?: () => void } | undefined;
    expect(options?.actionLabel).toBe("How to reconnect");
    options?.onAction?.();
    expect(onShowSelfHostHelp).toHaveBeenCalledTimes(1);
  });

  it("shows an offline toast only after the workspace status remains offline", async () => {
    await renderHarness();

    await renderHarness({
      workspace: createWorkspace({
        runtimeId: "runtime-local-1",
        status: "offline",
      }),
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOCAL_RUNTIME_OFFLINE_TOAST_DEBOUNCE_MS);
    });

    expect(showStatus).toHaveBeenCalledWith(
      "CLI Runtime Dogfood appears offline. Reconnect it or select another runtime if work stalls.",
      "warning",
      6000,
      { actionLabel: "How to reconnect", onAction: undefined },
    );

    await renderHarness({
      workspace: createWorkspace({
        runtimeId: "runtime-local-1",
        status: "online",
      }),
    });

    expect(showStatus).toHaveBeenLastCalledWith(
      "CLI Runtime Dogfood is back online.",
      "success",
      4000,
    );
  });
});
