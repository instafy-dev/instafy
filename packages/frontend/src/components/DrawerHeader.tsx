import type { ElementType, ReactNode } from "react";
import { Text } from "./Text";
import { usePageTitleInNavigation } from "./PageTitleContext";

export interface DrawerHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  titleAs?: ElementType;
  /** Opt in only when this drawer is the named page in the enclosing navigation. */
  pageTitle?: boolean;
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
  pageTitle = false,
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
  const titleInNavigation = usePageTitleInNavigation(title);
  const hideTitle = pageTitle && titleInNavigation;
  const railFrame = frame === "rail";
  const touchDensity = !railFrame && density === "touch";
  if (hideTitle && !subtitle && !actions) return null;
  return (
    <div className={["flex min-w-0 items-center gap-3", hideTitle && !subtitle ? "justify-end" : "justify-between", railFrame && "h-12 shrink-0 px-4", className].filter(Boolean).join(" ")}>
      {!hideTitle || subtitle ? <div
        className={[
          "flex min-w-0 items-center",
          touchDensity ? "gap-3" : "gap-2",
          contentClassName,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {icon && !hideTitle ? <div className="shrink-0">{icon}</div> : null}
        <div className="min-w-0">
          {!hideTitle ? <Text
            as={titleAs}
            variant={touchDensity ? "title" : "bodyStrong"}
            tone="primary"
            className={["min-w-0 truncate", railFrame && "max-[899px]:!text-base max-[899px]:!font-semibold", titleClassName].filter(Boolean).join(" ")}
          >
            {title}
          </Text> : null}
          {subtitle ? (
            <Text
              as="p"
              variant={touchDensity ? "body" : "caption"}
              tone="muted"
              className={[!hideTitle && "mt-0.5", "min-w-0 truncate", subtitleClassName].filter(Boolean).join(" ")}
            >
              {subtitle}
            </Text>
          ) : null}
        </div>
      </div> : null}
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
