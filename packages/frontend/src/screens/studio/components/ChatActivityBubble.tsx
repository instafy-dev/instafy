import type { ComponentProps, ReactNode } from "react";
import { Surface } from "../../../components/Surface";

type ChatActivityDotSize = "sm" | "md";
type ChatActivityDensity = "compact" | "comfortable";
type ChatActivityWidth = "assistant" | "peer";

const DOT_SIZE_CLASS_NAMES: Record<ChatActivityDotSize, string> = {
  sm: "h-1.5 w-1.5 rounded-full bg-slate-400/80 animate-pulse dark:bg-slate-500/80",
  md: "h-2 w-2 rounded-full bg-slate-400/80 animate-pulse",
};

const DENSITY_CLASS_NAMES: Record<ChatActivityDensity, string> = {
  compact: "min-h-9 px-3 py-2",
  comfortable: "px-3 py-2.5",
};

const WIDTH_CLASS_NAMES: Record<ChatActivityWidth, string> = {
  assistant: "w-fit max-w-full sm:max-w-[26rem]",
  peer: "w-fit max-w-[60%]",
};

export function ChatActivityDots({ size = "sm" }: { size?: ChatActivityDotSize }) {
  const dotClassName = DOT_SIZE_CLASS_NAMES[size];

  return (
    <span className="flex shrink-0 items-center gap-1">
      <span className={dotClassName} style={{ animationDelay: "0ms" }} />
      <span className={dotClassName} style={{ animationDelay: "150ms" }} />
      <span className={dotClassName} style={{ animationDelay: "300ms" }} />
    </span>
  );
}

export function ChatActivityBubble({
  ariaLabel,
  className,
  contentGapClassName = "gap-2.5",
  density = "compact",
  dotSize = "sm",
  indicator,
  label,
  labelClassName = "truncate",
  labelTitle,
  showActivityDots = true,
  surfaceTone = "subtle",
  testId,
  width = "assistant",
  ...props
}: {
  ariaLabel?: string;
  className?: string;
  contentGapClassName?: string;
  density?: ChatActivityDensity;
  dotSize?: ChatActivityDotSize;
  indicator?: ReactNode;
  label: string;
  labelClassName?: string;
  labelTitle?: string;
  showActivityDots?: boolean;
  surfaceTone?: ComponentProps<typeof Surface>["tone"];
  testId: string;
  width?: ChatActivityWidth;
} & Omit<ComponentProps<typeof Surface>, "children" | "className" | "tone">) {
  const renderedIndicator = indicator ?? (showActivityDots ? <ChatActivityDots size={dotSize} /> : null);

  return (
    <Surface
      tone={surfaceTone}
      radius="2xl"
      shadow="sm"
      data-testid={testId}
      className={[
        WIDTH_CLASS_NAMES[width],
        DENSITY_CLASS_NAMES[density],
        "min-w-0 overflow-hidden text-sm",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      aria-live="polite"
      {...props}
    >
      <span className="sr-only">{ariaLabel ?? label}</span>
      <div className={["flex min-w-0 max-w-full items-center", contentGapClassName].join(" ")} aria-hidden="true">
        {renderedIndicator}
        <span
          className={["instafy-status-sweep min-w-0 max-w-full text-xs", labelClassName].join(" ")}
          data-sweep-text={label}
          title={labelTitle}
        >
          {label}
        </span>
      </div>
    </Surface>
  );
}
