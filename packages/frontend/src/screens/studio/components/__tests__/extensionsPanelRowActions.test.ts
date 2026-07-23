import { describe, expect, it, vi } from "vitest";
import { buildExtensionsPanelRowActions } from "../extensionsPanelRowActions";

describe("extensionsPanelRowActions", () => {
  it("prioritizes setup before attach for rows that are not usable yet", () => {
    const onAttach = vi.fn();
    const onToggleDetails = vi.fn();
    const onDetach = vi.fn();

    const result = buildExtensionsPanelRowActions({
      attached: false,
      capabilityCount: 1,
      isPending: false,
      providerId: "camera:pixel-test",
      providerLabel: "Camera",
      rowPresentation: {
        hasSummaryLine: true,
        hasExpandableDetails: true,
        detailsExpanded: false,
        providerTitle: "Camera · Pixel Test",
        extensionState: "needs_setup",
        statusLabel: "Needs setup",
        statusTone: "attention",
        detailsButtonLabel: "Open setup",
        fallbackSummary: "Finish setup on this device before attaching.",
        attachLabel: "Use this phone",
        attachVariant: "primary",
        detachLabel: "Stop using this phone",
      },
      buildActionAriaLabel: (label, providerLabel) => `${label} ${providerLabel}`,
      onAttach,
      onToggleDetails,
      onDetach,
    });

    expect(result.rowActions.map((action) => action.id)).toEqual(["details"]);
    expect(result.rowActions[0]).toMatchObject({
      label: "Open setup",
      variant: "primary",
    });
    expect(result.footerActions).toEqual([]);
  });

  it("builds detach actions for attached rows", () => {
    const result = buildExtensionsPanelRowActions({
      attached: true,
      capabilityCount: 1,
      isPending: false,
      providerId: "demo",
      providerLabel: "Demo",
      rowPresentation: {
        hasSummaryLine: true,
        hasExpandableDetails: true,
        detailsExpanded: true,
        providerTitle: "Demo",
        extensionState: "attached",
        statusLabel: "Attached",
        statusTone: "ready",
        detailsButtonLabel: "Close",
        fallbackSummary: "Attached for Home.",
        attachLabel: "Attach",
        attachVariant: "outline",
        detachLabel: "Detach",
      },
      buildActionAriaLabel: (label, providerLabel) => `${label} ${providerLabel}`,
      onAttach: () => undefined,
      onToggleDetails: () => undefined,
      onDetach: () => undefined,
    });

    expect(result.rowActions.map((action) => action.id)).toEqual(["details"]);
    expect(result.footerActions.map((action) => action.id)).toEqual(["detach"]);
    expect(result.footerActions[0]).toMatchObject({
      label: "Detach",
      ariaLabel: "Detach Demo",
    });
  });
});
