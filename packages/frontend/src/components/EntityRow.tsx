import { forwardRef, type ReactNode } from "react";
import { Button, type ButtonProps } from "./Button";
import { Text } from "./Text";
import { listRowSurfaceToneClassName, LIST_ROW_FOCUS_RING } from "./listRowStyles";

type EntityRowSurface = "plain" | "interactive" | "selected" | "outlined";
type EntityRowDensity = "dense" | "compact" | "comfortable" | "rich";

const ENTITY_ROW_BASE =
  "flex min-w-0 max-w-full w-full flex-1 items-center gap-3 overflow-hidden rounded-xl border text-left transition-colors";

const ENTITY_ROW_DENSITY_CLASSES: Record<EntityRowDensity, string> = {
  dense: "px-2.5 py-1.5",
  compact: "px-3 py-2",
  comfortable: "px-3.5 py-2.5",
  rich: "px-4 py-3",
};

const ENTITY_ROW_SURFACE_CLASSES: Record<EntityRowSurface, string> = {
  plain: "border-transparent bg-transparent",
  interactive: `border-transparent bg-transparent ${listRowSurfaceToneClassName(false)}`,
  selected: listRowSurfaceToneClassName(true),
  outlined:
    "border-slate-200/70 bg-transparent hover:border-slate-300 hover:bg-slate-50 dark:border-[color:var(--color-studio-dark-raised-control-border)] dark:hover:border-[color:var(--color-studio-dark-active-border)] dark:hover:bg-[var(--color-studio-dark-control-hover)]",
};

const ENTITY_ROW_TITLE_CLASSES: Record<EntityRowDensity, string> = {
  dense: "text-sm leading-5",
  compact: "text-sm leading-5",
  comfortable: "text-sm leading-5",
  rich: "text-sm leading-5",
};

const ENTITY_ROW_SUBTITLE_CLASSES: Record<EntityRowDensity, string> = {
  dense: "mt-0.5 text-xxs leading-4",
  compact: "mt-0.5 text-xs leading-4",
  comfortable: "mt-0.5 text-xs leading-4",
  rich: "mt-1 text-xs leading-4",
};

const ENTITY_ROW_DETAIL_CLASSES: Record<EntityRowDensity, string> = {
  dense: "mt-1",
  compact: "mt-1",
  comfortable: "mt-1.5",
  rich: "mt-1.5",
};

export interface EntityRowProps {
  title: ReactNode;
  titleEnd?: ReactNode;
  subtitle?: ReactNode;
  detail?: ReactNode;
  leadingAccessory?: ReactNode;
  start?: ReactNode;
  end?: ReactNode;
  // Renders outside the row surface. Use `end` for controls that should visually belong to the row.
  trailingAction?: ReactNode;
  reserveTrailingAction?: boolean;
  surface?: EntityRowSurface;
  density?: EntityRowDensity;
  selected?: boolean;
  pressable?: boolean;
  onPress?: ButtonProps["onPress"];
  isDisabled?: boolean;
  containerClassName?: string;
  className?: string;
  titleClassName?: string;
  titleEndClassName?: string;
  subtitleClassName?: string;
  detailClassName?: string;
  contentClassName?: string;
  startClassName?: string;
  endClassName?: string;
  trailingActionClassName?: string;
  "data-testid"?: string;
  "aria-label"?: string;
  "aria-current"?: "page" | "step" | "location" | "date" | "time" | boolean;
}

function EntityRowContent({
  title,
  titleEnd,
  subtitle,
  detail,
  start,
  end,
  density = "comfortable",
  titleClassName,
  titleEndClassName,
  subtitleClassName,
  detailClassName,
  contentClassName,
  startClassName,
  endClassName,
}: Pick<
  EntityRowProps,
  | "title"
  | "titleEnd"
  | "subtitle"
  | "detail"
  | "start"
  | "end"
  | "density"
  | "titleClassName"
  | "titleEndClassName"
  | "subtitleClassName"
  | "detailClassName"
  | "contentClassName"
  | "startClassName"
  | "endClassName"
>) {
  return (
    <>
      {start ? (
        <span className={["shrink-0", startClassName].filter(Boolean).join(" ")}>{start}</span>
      ) : null}
      <div className={["min-w-0 max-w-full flex-1", contentClassName].filter(Boolean).join(" ")}>
        <div className="flex min-w-0 max-w-full items-start justify-between gap-2">
          <Text
            as="span"
            variant="bodyStrong"
            tone="primary"
            className={[
              "block min-w-0 max-w-full flex-1 truncate",
              ENTITY_ROW_TITLE_CLASSES[density],
              titleClassName,
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {title}
          </Text>
          {titleEnd ? (
            <span className={["min-w-0 max-w-[40%] shrink text-right", titleEndClassName].filter(Boolean).join(" ")}>
              {titleEnd}
            </span>
          ) : null}
        </div>
        {subtitle ? (
          <Text
            as="span"
            variant="caption"
            tone="muted"
            className={[
              "block min-w-0 max-w-full truncate",
              ENTITY_ROW_SUBTITLE_CLASSES[density],
              subtitleClassName,
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {subtitle}
          </Text>
        ) : null}
        {detail ? (
          <div
            className={[
              "min-w-0 max-w-full",
              ENTITY_ROW_DETAIL_CLASSES[density],
              detailClassName,
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {detail}
          </div>
        ) : null}
      </div>
      {end ? <span className={["shrink-0", endClassName].filter(Boolean).join(" ")}>{end}</span> : null}
    </>
  );
}

export const EntityRow = forwardRef<HTMLButtonElement, EntityRowProps>(function EntityRow(
  {
    title,
    titleEnd,
    subtitle,
    detail,
    leadingAccessory,
    start,
    end,
    trailingAction,
    reserveTrailingAction = false,
    surface,
    density = "comfortable",
    selected = false,
    pressable = false,
    onPress,
    isDisabled = false,
    containerClassName,
    className,
    titleClassName,
    titleEndClassName,
    subtitleClassName,
    detailClassName,
    contentClassName,
    startClassName,
    endClassName,
    trailingActionClassName,
    ...props
  },
  ref,
) {
  const isPressable = pressable || Boolean(onPress);
  const resolvedSurface: EntityRowSurface = surface ?? (selected ? "selected" : isPressable ? "interactive" : "plain");
  const rowClassName = [
    ENTITY_ROW_BASE,
    ENTITY_ROW_DENSITY_CLASSES[density],
    ENTITY_ROW_SURFACE_CLASSES[resolvedSurface],
    isPressable ? LIST_ROW_FOCUS_RING : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={[
        "flex min-w-0 w-full max-w-full items-stretch gap-2",
        containerClassName,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {leadingAccessory ? <div className="flex shrink-0 items-center">{leadingAccessory}</div> : null}
      {isPressable ? (
        <Button
          {...props}
          ref={ref}
          type="button"
          fullWidth
          variant="ghost"
          size="sm"
          radius="xl"
          onPress={onPress}
          isDisabled={isDisabled}
          className={[
            rowClassName,
            "min-w-0 max-w-full justify-start shadow-none data-[pressed]:translate-y-0 data-[pressed]:scale-100",
          ].join(" ")}
        >
          <EntityRowContent
            title={title}
            titleEnd={titleEnd}
            subtitle={subtitle}
            detail={detail}
            start={start}
            end={end}
            density={density}
            titleClassName={titleClassName}
            titleEndClassName={titleEndClassName}
            subtitleClassName={subtitleClassName}
            detailClassName={detailClassName}
            contentClassName={contentClassName}
            startClassName={startClassName}
            endClassName={endClassName}
          />
        </Button>
      ) : (
        <div className={rowClassName} {...props}>
          <EntityRowContent
            title={title}
            titleEnd={titleEnd}
            subtitle={subtitle}
            detail={detail}
            start={start}
            end={end}
            density={density}
            titleClassName={titleClassName}
            titleEndClassName={titleEndClassName}
            subtitleClassName={subtitleClassName}
            detailClassName={detailClassName}
            contentClassName={contentClassName}
            startClassName={startClassName}
            endClassName={endClassName}
          />
        </div>
      )}
      {trailingAction || reserveTrailingAction ? (
        <div className={["flex shrink-0 items-center", trailingActionClassName].filter(Boolean).join(" ")}>
          {trailingAction ?? <span aria-hidden="true" className="block h-8 w-8" />}
        </div>
      ) : null}
    </div>
  );
});
