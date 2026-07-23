import { useEffect, useRef, type ReactNode } from "react";
import { Button, type ButtonProps } from "../../../components/Button";
import type { ExtensionStatusTone } from "../../../extensions/providerStatusPresentation";
import {
  formatProviderCollapseLabel,
  ProviderDisclosureButton,
  ProviderStatusIndicator,
} from "../../../extensions/providerRowControls";
import { EntityRow } from "../../../components/EntityRow";

export type ExtensionListRowAction = {
  id: string;
  label: string;
  ariaLabel?: string;
  testId?: string;
} & Pick<ButtonProps, "isDisabled" | "onPress" | "radius" | "size" | "variant">;

export type ExtensionListRowStatusTone = ExtensionStatusTone;

type ExtensionListRowProps = {
  providerId: string;
  title: string;
  description: string;
  statusLabel: string;
  statusTone?: ExtensionListRowStatusTone;
  summary: ReactNode;
  actions?: ExtensionListRowAction[];
  details?: ReactNode;
  footerActions?: ExtensionListRowAction[];
  detailsExpanded?: boolean;
};

export function ExtensionListRow({
  providerId,
  title,
  description,
  statusLabel,
  statusTone = "idle",
  summary,
  actions = [],
  details,
  footerActions = [],
  detailsExpanded = false,
}: ExtensionListRowProps) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const detailsAction = actions.find((action) => action.id === "details") ?? null;
  const visibleActions = detailsExpanded
    ? actions.filter((action) => action.id !== "details")
    : actions;
  const collapseDetailsAriaLabel = detailsAction
    ? formatProviderCollapseLabel(detailsAction.ariaLabel ?? detailsAction.label, title)
    : undefined;

  useEffect(() => {
    if (!detailsExpanded || typeof window === "undefined") {
      return;
    }
    const viewportIsCompact =
      window.matchMedia?.("(max-width: 767px)").matches ||
      window.matchMedia?.("(pointer: coarse)").matches;
    if (!viewportIsCompact) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      rowRef.current?.scrollIntoView({
        block: "start",
        inline: "nearest",
      });
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [detailsExpanded]);

  return (
    <div ref={rowRef} data-testid={`project-provider-row-${providerId}`}>
      <EntityRow
        density="rich"
        surface="plain"
        className="rounded-none border-0 px-4 py-4"
        title={title}
        titleEndClassName="max-w-[70%]"
        titleEnd={
          <span className="inline-flex min-w-0 items-center justify-end gap-1">
            <ProviderStatusIndicator providerId={providerId} label={statusLabel} tone={statusTone} />
            {detailsExpanded && detailsAction && collapseDetailsAriaLabel ? (
              <ProviderDisclosureButton
                ariaLabel={collapseDetailsAriaLabel}
                testId={detailsAction.testId}
                onPress={detailsAction.onPress}
              />
            ) : null}
          </span>
        }
        subtitle={description}
        detail={
          <div className="space-y-3">
            {summary}
            {visibleActions.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                {visibleActions.map((action) => (
                  <Button
                    key={action.id}
                    variant={action.variant ?? "outline"}
                    size={action.size ?? "sm"}
                    radius={action.radius ?? "full"}
                    isDisabled={action.isDisabled}
                    aria-label={action.ariaLabel}
                    data-testid={action.testId}
                    onPress={action.onPress}
                  >
                    {action.label}
                  </Button>
                ))}
              </div>
            ) : null}
            {detailsExpanded && (details || footerActions.length > 0) ? (
              <div
                className="space-y-3 border-t border-slate-200/70 pt-3 dark:border-slate-800"
                data-testid={`project-provider-details-${providerId}`}
              >
                {details}
                {footerActions.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-2 border-t border-slate-200/70 pt-3 dark:border-slate-800">
                    {footerActions.map((action) => (
                      <Button
                        key={action.id}
                        variant={action.variant ?? "outline"}
                        size={action.size ?? "sm"}
                        radius={action.radius ?? "full"}
                        isDisabled={action.isDisabled}
                        aria-label={action.ariaLabel}
                        data-testid={action.testId}
                        onPress={action.onPress}
                      >
                        {action.label}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        }
      />
    </div>
  );
}
