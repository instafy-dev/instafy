import type { ElementType, ReactNode } from "react";
import { Text } from "./Text";

export interface DrawerHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  titleAs?: ElementType;
  icon?: ReactNode;
  actions?: ReactNode;
  density?: "compact" | "touch";
  /** Align with the 48px Studio tab rail. Put filters and path details below this frame. */
  frame?: "content" | "rail";
  className?: string;
  contentClassName?: string;
  titleClassName?: string;
  subtitleClassName?: string;
  actionsClassName?: string;
}

export function DrawerHeader({
  title,
  subtitle,
  titleAs = "p",
  icon,
  actions,
  density = "compact",
  frame = "content",
  className,
  contentClassName,
  titleClassName,
  subtitleClassName,
  actionsClassName,
}: DrawerHeaderProps) {
  const railFrame = frame === "rail";
  const touchDensity = !railFrame && density === "touch";
  return (
    <div className={["flex min-w-0 items-center justify-between gap-3", railFrame && "h-12 shrink-0 px-4", className].filter(Boolean).join(" ")}>
      <div
        className={[
          "flex min-w-0 items-center",
          touchDensity ? "gap-3" : "gap-2",
          contentClassName,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {icon ? <div className="shrink-0">{icon}</div> : null}
        <div className="min-w-0">
          <Text
            as={titleAs}
            variant={touchDensity ? "title" : "bodyStrong"}
            tone="primary"
            className={["min-w-0 truncate", railFrame && "!text-base !font-semibold", titleClassName].filter(Boolean).join(" ")}
          >
            {title}
          </Text>
          {subtitle ? (
            <Text
              as="p"
              variant={touchDensity ? "body" : "caption"}
              tone="muted"
              className={["mt-0.5 min-w-0 truncate", subtitleClassName].filter(Boolean).join(" ")}
            >
              {subtitle}
            </Text>
          ) : null}
        </div>
      </div>
      {actions ? (
        <div
          className={[
            "flex shrink-0 items-center",
            touchDensity ? "gap-2" : "gap-1",
            actionsClassName,
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
}
