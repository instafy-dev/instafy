import { describe, expect, it } from "vitest";
import {
  resolveExtensionAttachActionLabel,
  resolveExtensionDetailsActionLabel,
  resolveExtensionDetachActionLabel,
  resolveExtensionDisplayState,
  resolveExtensionFallbackSummary,
  resolveExtensionStatusPresentation,
} from "../extensionPresentation";

describe("extensionPresentation", () => {
  it("standardizes display states and status tones", () => {
    expect(
      resolveExtensionDisplayState({
        attached: false,
        discoverable: true,
        hasDiscoveryError: false,
        isPending: true,
        activeRequestState: null,
        needsSetup: false,
        attachedRemote: false,
        source: "native_runtime",
      }),
    ).toBe("updating");

    expect(
      resolveExtensionDisplayState({
        attached: false,
        discoverable: false,
        hasDiscoveryError: true,
        isPending: false,
        activeRequestState: null,
        needsSetup: false,
        attachedRemote: false,
        source: "host",
      }),
    ).toBe("unavailable");

    expect(
      resolveExtensionDisplayState({
        attached: false,
        discoverable: true,
        hasDiscoveryError: false,
        isPending: false,
        activeRequestState: null,
        needsSetup: true,
        attachedRemote: false,
        source: "native_runtime",
      }),
    ).toBe("needs_setup");

    expect(
      resolveExtensionDisplayState({
        attached: false,
        discoverable: true,
        hasDiscoveryError: false,
        isPending: false,
        activeRequestState: null,
        needsSetup: false,
        attachedRemote: false,
        source: "project_integration",
      }),
    ).toBe("saved");

    expect(
      resolveExtensionStatusPresentation("attached"),
    ).toEqual({
      label: "Attached",
      tone: "ready",
    });

    expect(
      resolveExtensionDisplayState({
        attached: true,
        discoverable: false,
        hasDiscoveryError: false,
        isPending: false,
        activeRequestState: null,
        needsSetup: false,
        attachedRemote: true,
        source: "project_integration",
      }),
    ).toBe("attached_remote");

    expect(resolveExtensionStatusPresentation("attached_remote")).toEqual({
      label: "Other device",
      tone: "attention",
    });
  });

  it("maps remote camera readiness and phone attention states", () => {
    expect(
      resolveExtensionDisplayState({
        attached: true,
        discoverable: false,
        hasDiscoveryError: false,
        isPending: false,
        activeRequestState: null,
        needsSetup: false,
        attachedRemote: true,
        remoteStatus: "ready",
        source: "project_integration",
      }),
    ).toBe("attached_remote_ready");

    expect(resolveExtensionStatusPresentation("attached_remote_ready")).toEqual({
      label: "Ready",
      tone: "ready",
    });

    expect(
      resolveExtensionDisplayState({
        attached: true,
        discoverable: false,
        hasDiscoveryError: false,
        isPending: false,
        activeRequestState: null,
        needsSetup: false,
        attachedRemote: true,
        remoteStatus: "permission",
        source: "project_integration",
      }),
    ).toBe("attached_remote_permission");

    expect(resolveExtensionStatusPresentation("attached_remote_permission")).toEqual({
      label: "Needs permission",
      tone: "attention",
    });

    expect(
      resolveExtensionDisplayState({
        attached: true,
        discoverable: false,
        hasDiscoveryError: false,
        isPending: false,
        activeRequestState: null,
        needsSetup: false,
        attachedRemote: true,
        remoteStatus: "issue",
        source: "project_integration",
      }),
    ).toBe("attached_remote_issue");

    expect(resolveExtensionFallbackSummary({
      scopeLabel: "Untitled Space",
      source: "project_integration",
      state: "attached_remote_offline",
    })).toBe("Open Instafy on the selected device to use this extension.");
  });

  it("keeps attached providers in setup state until they are usable", () => {
    const state = resolveExtensionDisplayState({
      attached: true,
      discoverable: true,
      hasDiscoveryError: false,
      isPending: false,
      activeRequestState: null,
      needsSetup: true,
      attachedRemote: false,
      source: "native_runtime",
    });

    expect(state).toBe("needs_setup");
    expect(resolveExtensionStatusPresentation(state).tone).toBe("attention");
  });

  it("uses distinct loading states while an attached extension is waiting or busy", () => {
    const pendingState = resolveExtensionDisplayState({
      attached: true,
      discoverable: true,
      hasDiscoveryError: false,
      isPending: false,
      activeRequestState: "pending",
      needsSetup: false,
      attachedRemote: true,
      source: "project_integration",
    });

    expect(pendingState).toBe("request_pending");
    expect(resolveExtensionStatusPresentation(pendingState)).toEqual({
      label: "Waiting",
      tone: "loading",
    });

    const inProgressState = resolveExtensionDisplayState({
      attached: true,
      discoverable: true,
      hasDiscoveryError: false,
      isPending: false,
      activeRequestState: "in_progress",
      needsSetup: false,
      attachedRemote: true,
      source: "project_integration",
    });

    expect(inProgressState).toBe("request_in_progress");
    expect(resolveExtensionStatusPresentation(inProgressState)).toEqual({
      label: "Capturing",
      tone: "loading",
    });
  });

  it("uses standardized fallback summaries", () => {
    expect(
      resolveExtensionFallbackSummary({
        scopeLabel: "Untitled Space",
        source: "host",
        state: "not_attached",
      }),
    ).toBe("Available locally.");

    expect(
      resolveExtensionFallbackSummary({
        scopeLabel: "Untitled Space",
        source: "project_integration",
        state: "saved",
      }),
    ).toBe("Saved.");

    expect(
      resolveExtensionFallbackSummary({
        scopeLabel: "Untitled Space",
        source: "native_runtime",
        state: "needs_setup",
      }),
    ).toBe("Finish setup before use.");

    expect(
      resolveExtensionFallbackSummary({
        scopeLabel: "Untitled Space",
        source: "project_integration",
        state: "attached_remote",
      }),
    ).toBe("Runs on another device while Instafy stays open there.");
  });

  it("standardizes primary and details action labels", () => {
    expect(
      resolveExtensionAttachActionLabel({
        isPending: false,
        useDeviceLanguage: true,
      }),
    ).toBe("Use This Device");

    expect(
      resolveExtensionDetachActionLabel({
        isPending: false,
        useDeviceLanguage: false,
      }),
    ).toBe("Detach");

    expect(
      resolveExtensionDetailsActionLabel({
        attached: true,
        expanded: false,
        hasManageSurface: true,
      }),
    ).toBe("Manage");

    expect(
      resolveExtensionDetailsActionLabel({
        attached: false,
        expanded: false,
        hasManageSurface: true,
      }),
    ).toBe("Setup");

    expect(
      resolveExtensionDetailsActionLabel({
        attached: false,
        expanded: true,
        hasManageSurface: false,
      }),
    ).toBe("Close");
  });
});
