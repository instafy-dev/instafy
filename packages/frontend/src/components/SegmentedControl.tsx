import type { ReactNode } from "react";
import { Label, Radio, RadioGroup } from "react-aria-components";
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
  isDisabled?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
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
  isDisabled = false,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: SegmentedControlProps<T>) {
  return (
    <RadioGroup
      value={value}
      onChange={(next) => onChange(next as T)}
      orientation="horizontal"
      isDisabled={isDisabled}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      className={[
        "space-y-1.5",
        width === "fit" ? "inline-block shrink-0" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {label ? (
        <Text as={Label} variant="caption" tone="muted" className="block">{label}</Text>
      ) : null}
      <div
        className={segmentedControlGroupClassName(tone)}
      >
        {options.map((option) => {
          const isSelected = option.value === value;
          return (
            <Radio
              key={option.value}
              value={option.value}
              aria-label={option.ariaLabel}
              data-testid={option.testId}
              className={[
                segmentedControlOptionClassName(isSelected, tone),
                width === "fill" ? "flex-1" : "flex-auto",
                size === "xs" ? "min-h-11 text-xs sm:pointer-fine:min-h-7" : "min-h-11 text-sm sm:pointer-fine:min-h-9",
                "min-w-11 sm:pointer-fine:min-w-0",
                "cursor-pointer",
              ].join(" ")}
            >
              <span className={SEGMENTED_CONTROL_LABEL_CLASS}>{option.label}</span>
            </Radio>
          );
        })}
      </div>
    </RadioGroup>
  );
}
