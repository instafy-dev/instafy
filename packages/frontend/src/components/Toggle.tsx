import type { ReactNode } from "react";
import {
  Switch,
  composeRenderProps,
  type SwitchProps
} from "react-aria-components";

type ToggleSize = "sm" | "md";

const WRAPPER_BASE =
  "group flex items-center gap-3 text-slate-700 pointer-coarse:min-h-11 dark:text-slate-200 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-60";
const LABEL_BASE = "font-medium";
const TRACK_BASE = "relative inline-flex shrink-0 items-center rounded-full border transition";

const SIZE_CLASSES: Record<
  ToggleSize,
  { track: string; thumb: string; label: string; description: string; translate: string }
> = {
  sm: {
    track: "h-5 w-9",
    thumb: "h-4 w-4",
    label: "text-sm",
    description: "text-xs",
    translate: "translate-x-4"
  },
  md: {
    track: "h-6 w-11",
    thumb: "h-5 w-5",
    label: "text-base",
    description: "text-sm",
    translate: "translate-x-5"
  }
};

export type ToggleProps = Omit<SwitchProps, "children" | "className"> & {
  label?: ReactNode;
  description?: ReactNode;
  size?: ToggleSize;
  className?: SwitchProps["className"];
  children?: ReactNode;
};

export function Toggle({
  label,
  description,
  size = "sm",
  className,
  children,
  ...props
}: ToggleProps) {
  const labelNode = label ?? children;
  return (
    <Switch
      {...props}
      className={composeRenderProps(className, (value) =>
        [WRAPPER_BASE, value].filter(Boolean).join(" ")
      )}
    >
      {({ isSelected, isDisabled }) => {
        const trackTone = isSelected
          ? "bg-primary-500 border-primary-500"
          : "bg-slate-200 border-slate-200 dark:bg-[var(--color-studio-dark-raised-control)] dark:border-[color:var(--color-studio-dark-raised-control-border)]";
        const disabledState = isDisabled
          ? "bg-slate-100 border-slate-200 dark:bg-[var(--color-studio-dark-active)] dark:border-[color:var(--color-studio-dark-active-border)]"
          : "";
        const thumbTone = isDisabled ? "bg-slate-400 dark:bg-slate-600" : "bg-white dark:bg-slate-50";

        return (
          <>
            {labelNode || description ? (
              <span className="min-w-0 flex flex-col gap-0.5">
                {labelNode ? (
                  <span className={`${LABEL_BASE} ${SIZE_CLASSES[size].label}`}>{labelNode}</span>
                ) : null}
                {description ? (
                  <span
                    className={`${SIZE_CLASSES[size].description} break-words text-slate-500 dark:text-slate-400`}
                  >
                    {description}
                  </span>
                ) : null}
              </span>
            ) : null}
            <span
              aria-hidden="true"
              className={[
                TRACK_BASE,
                SIZE_CLASSES[size].track,
                trackTone,
                disabledState,
                "px-0.5",
                "group-data-[focus-visible]:ring-2 group-data-[focus-visible]:ring-primary-400/40 group-data-[focus-visible]:ring-offset-2 group-data-[focus-visible]:ring-offset-white dark:group-data-[focus-visible]:ring-offset-[var(--color-studio-dark-floating)]"
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <span
                className={[
                  "inline-block transform rounded-full shadow-sm transition-transform",
                  SIZE_CLASSES[size].thumb,
                  thumbTone,
                  isSelected ? SIZE_CLASSES[size].translate : "translate-x-0"
                ]
                  .filter(Boolean)
                  .join(" ")}
              />
            </span>
          </>
        );
      }}
    </Switch>
  );
}
