import type { ReactNode } from "react";
import { Button } from "./Button";
import { Text } from "./Text";
import {
  DARK_ACTIVE_BG_CLASS,
  DARK_ACTIVE_RING_CLASS,
  DARK_CONTROL_HOVER_CLASS,
  DARK_RAISED_CONTROL_CLASS,
} from "../theme/darkSurfaces";

export interface SegmentedControlOption<T extends string> {
  value: T;
  label: ReactNode;
  ariaLabel?: string;
  testId?: string;
}

export interface SegmentedControlProps<T extends string> {
  label?: ReactNode;
  value: T;
  options: Array<SegmentedControlOption<T>>;
  onChange: (value: T) => void;
  className?: string;
  size?: "xs" | "sm";
  tone?: "default" | "inverse";
  width?: "fill" | "fit";
}

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
  size = "xs",
  tone = "default",
  width = "fill",
}: SegmentedControlProps<T>) {
  return (
    <div
      className={[
        "space-y-1.5",
        width === "fit" ? "inline-block shrink-0" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {label ? (
        <Text variant="caption" tone="muted">
          {label}
        </Text>
      ) : null}
      <div
        className={[
          width === "fit" ? "inline-flex shrink-0" : "flex",
          "items-center gap-1 rounded-full border p-1",
          tone === "inverse"
            ? "border-[rgba(255,255,255,0.12)] bg-[rgba(15,23,42,0.72)]"
            : `border-slate-200 bg-slate-50/70 ${DARK_RAISED_CONTROL_CLASS}`,
        ].join(" ")}
      >
        {options.map((option) => {
          const isSelected = option.value === value;
          return (
            <Button
              key={option.value}
              type="button"
              onPress={() => onChange(option.value)}
              variant="ghost"
              size={size}
              radius="full"
              fullWidth={width === "fill"}
              aria-pressed={isSelected}
              aria-label={option.ariaLabel}
              data-testid={option.testId}
              className={[
                "min-w-0 flex-1 justify-center gap-1 px-3",
                isSelected
                  ? tone === "inverse"
                    ? "bg-[rgba(255,255,255,0.12)] text-slate-50 shadow-sm ring-1 ring-[rgba(255,255,255,0.12)]"
                    : `bg-white text-slate-900 shadow-sm ring-1 ring-slate-200 ${DARK_ACTIVE_BG_CLASS} dark:text-slate-50 ${DARK_ACTIVE_RING_CLASS}`
                  : tone === "inverse"
                    ? "text-slate-300 hover:bg-[rgba(255,255,255,0.08)] data-[hovered]:bg-[rgba(255,255,255,0.08)]"
                    : `text-slate-600 hover:bg-white/70 data-[hovered]:bg-white/70 dark:text-slate-300 ${DARK_CONTROL_HOVER_CLASS}`,
              ].join(" ")}
            >
              {option.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
