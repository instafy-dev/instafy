import type { ReactNode } from "react";
import { Button as AriaButton } from "react-aria-components";
import { Text } from "./Text";
import {
  SEGMENTED_CONTROL_LABEL_CLASS,
  segmentedControlGroupClassName,
  segmentedControlOptionClassName,
} from "./segmentedControlStyles";

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
        className={segmentedControlGroupClassName(tone)}
      >
        {options.map((option) => {
          const isSelected = option.value === value;
          return (
            <AriaButton
              key={option.value}
              type="button"
              onPress={() => onChange(option.value)}
              aria-pressed={isSelected}
              aria-label={option.ariaLabel}
              data-testid={option.testId}
              className={[
                segmentedControlOptionClassName(isSelected, tone),
                width === "fill" ? "flex-1" : "flex-auto",
                size === "xs" ? "min-h-7 text-xs" : "min-h-9 text-sm",
                "pointer-coarse:min-h-11",
              ].join(" ")}
            >
              <span className={SEGMENTED_CONTROL_LABEL_CLASS}>{option.label}</span>
            </AriaButton>
          );
        })}
      </div>
    </div>
  );
}
