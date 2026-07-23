import type { ElementType, ReactNode } from "react";
import { Text } from "./Text";

export interface DrawerHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  titleAs?: ElementType;
  icon?: ReactNode;
  actions?: ReactNode;
  density?: "compact" | "touch";
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
  className,
  contentClassName,
  titleClassName,
  subtitleClassName,
  actionsClassName,
}: DrawerHeaderProps) {
  const touchDensity = density === "touch";
  return (
    <div className={["flex items-center justify-between gap-3", className].filter(Boolean).join(" ")}>
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
            className={["min-w-0 truncate", titleClassName].filter(Boolean).join(" ")}
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
