import type { ExtensionRowPresentation } from "../../../extensions/extensionRowPresentation";
import type { ExtensionListRowAction } from "./ExtensionListRow";

type BuildExtensionsPanelRowActionsInput = {
  attached: boolean;
  capabilityCount: number;
  isPending: boolean;
  providerId: string;
  providerLabel: string;
  rowPresentation: ExtensionRowPresentation;
  buildActionAriaLabel: (label: string, providerLabel: string) => string;
  onAttach: () => void;
  onToggleDetails: () => void;
  onDetach: () => void;
};

export function buildExtensionsPanelRowActions(
  input: BuildExtensionsPanelRowActionsInput,
) {
  const rowActions: ExtensionListRowAction[] = [];
  const needsSetupBeforeAttach = input.rowPresentation.extensionState === "needs_setup";

  if (!input.attached && !needsSetupBeforeAttach) {
    rowActions.push({
      id: "attach",
      label: input.rowPresentation.attachLabel,
      ariaLabel: input.buildActionAriaLabel(
        input.rowPresentation.attachLabel,
        input.providerLabel,
      ),
      variant: input.rowPresentation.attachVariant,
      testId: `project-provider-attach-${input.providerId}`,
      isDisabled: input.isPending || input.capabilityCount === 0,
      onPress: input.onAttach,
    });
  }

  if (input.rowPresentation.hasExpandableDetails) {
    rowActions.push({
      id: "details",
      label: input.rowPresentation.detailsButtonLabel,
      ariaLabel: input.buildActionAriaLabel(
        input.rowPresentation.detailsButtonLabel,
        input.providerLabel,
      ),
      variant: input.rowPresentation.detailsExpanded
        ? "secondary"
        : needsSetupBeforeAttach
          ? "primary"
          : "outline",
      testId: `project-provider-details-toggle-${input.providerId}`,
      onPress: input.onToggleDetails,
    });
  } else if (input.attached) {
    rowActions.push({
      id: "detach",
      label: input.rowPresentation.detachLabel,
      ariaLabel: input.buildActionAriaLabel(
        input.rowPresentation.detachLabel,
        input.providerLabel,
      ),
      variant: "outline",
      testId: `project-provider-detach-${input.providerId}`,
      isDisabled: input.isPending,
      onPress: input.onDetach,
    });
  }

  const footerActions: ExtensionListRowAction[] =
    input.attached && input.rowPresentation.hasExpandableDetails
      ? [
          {
            id: "detach",
            label: input.rowPresentation.detachLabel,
            ariaLabel: input.buildActionAriaLabel(
              input.rowPresentation.detachLabel,
              input.providerLabel,
            ),
            variant: "outline",
            testId: `project-provider-detach-${input.providerId}`,
            isDisabled: input.isPending,
            onPress: input.onDetach,
          },
        ]
      : [];

  return {
    rowActions,
    footerActions,
  };
}
