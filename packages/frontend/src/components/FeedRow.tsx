import type { ReactNode } from "react";
import type { ButtonProps } from "./Button";
import { EntityRow, type EntityRowProps } from "./EntityRow";
import { Text } from "./Text";

interface FeedRowProps {
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  metaPlacement?: "inline" | "end";
  preview?: ReactNode;
  icon?: ReactNode;
  iconClassName?: string;
  startClassName?: EntityRowProps["startClassName"];
  end?: ReactNode;
  density?: EntityRowProps["density"];
  verticalAlign?: "start" | "center";
  surface?: EntityRowProps["surface"];
  selected?: boolean;
  onPress?: ButtonProps["onPress"];
  trailingAction?: ReactNode;
  reserveTrailingAction?: boolean;
  className?: string;
  titleClassName?: string;
  titleEndClassName?: string;
  subtitleClassName?: string;
  previewClassName?: string;
  endClassName?: EntityRowProps["endClassName"];
  trailingActionClassName?: EntityRowProps["trailingActionClassName"];
  "data-testid"?: string;
}

function renderTitleWithInlineMeta(title: ReactNode, meta: ReactNode) {
  if (!meta) {
    return title;
  }
  return (
    <span className="flex min-w-0 max-w-full items-baseline gap-1.5">
      <span className="min-w-0 truncate">{title}</span>
      <span className="shrink-0 text-xxs font-normal text-slate-400 dark:text-slate-500">·</span>
      <Text as="span" variant="caption" tone="muted" className="shrink-0 text-xxs font-normal">
        {meta}
      </Text>
    </span>
  );
}

export function FeedRow({
  title,
  subtitle,
  meta,
  metaPlacement = "inline",
  preview,
  icon,
  iconClassName,
  startClassName,
  end,
  density = "comfortable",
  verticalAlign = "start",
  surface,
  selected = false,
  onPress,
  trailingAction,
  reserveTrailingAction = false,
  className,
  titleClassName,
  titleEndClassName,
  subtitleClassName,
  previewClassName,
  endClassName,
  trailingActionClassName,
  "data-testid": dataTestId,
}: FeedRowProps) {
  return (
    <EntityRow
      title={metaPlacement === "inline" ? renderTitleWithInlineMeta(title, meta) : title}
      titleEnd={
        meta && metaPlacement === "end" ? (
          <Text as="span" variant="caption" tone="muted">
            {meta}
          </Text>
        ) : null
      }
      subtitle={subtitle}
      detail={
        preview ? (
          <Text
            as="span"
            variant="caption"
            tone="muted"
            className={[
              "line-clamp-2 block min-w-0 max-w-full overflow-hidden break-words text-left [overflow-wrap:anywhere]",
              previewClassName,
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {preview}
          </Text>
        ) : null
      }
      start={
        icon ? (
          // iconClassName replaces the shell's size and radius (a later
          // same-property utility does not reliably win in the build).
          <span
            className={[
              "inline-flex shrink-0 items-center justify-center",
              iconClassName ?? "h-9 w-9 rounded-2xl",
            ].join(" ")}
            aria-hidden="true"
          >
            {icon}
          </span>
        ) : null
      }
      end={end}
      pressable={Boolean(onPress)}
      onPress={onPress}
      selected={selected}
      density={density}
      surface={surface}
      className={[
        "w-full max-w-full",
        verticalAlign === "center" ? "items-center" : "items-start",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      titleClassName={["font-medium text-slate-800 dark:text-slate-200", titleClassName].filter(Boolean).join(" ")}
      titleEndClassName={titleEndClassName}
      subtitleClassName={subtitleClassName}
      detailClassName="min-w-0"
      startClassName={[
        verticalAlign === "center" ? "self-center" : "pt-0.5",
        startClassName,
      ]
        .filter(Boolean)
        .join(" ")}
      endClassName={endClassName}
      trailingAction={trailingAction}
      reserveTrailingAction={reserveTrailingAction}
      trailingActionClassName={trailingActionClassName}
      data-testid={dataTestId}
    />
  );
}
