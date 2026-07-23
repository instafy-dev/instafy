import { useEffect, useId, useRef, type ReactNode } from "react";
import { Check } from "iconoir-react";

type CheckboxSize = "sm" | "md";

const WRAPPER_BASE =
  "group flex items-start gap-2 text-slate-700 dark:text-slate-200";
const BOX_BASE = "relative mt-0.5 shrink-0";
const INPUT_BASE =
  "peer flex items-center justify-center rounded border transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400/40 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-950";
const LABEL_BASE = "font-medium";

const SIZE_CLASSES: Record<CheckboxSize, { box: string; text: string; description: string }> = {
  sm: { box: "h-4 w-4", text: "text-sm", description: "text-xs" },
  md: { box: "h-5 w-5", text: "text-base", description: "text-sm" }
};

export type CheckboxProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "checked" | "defaultChecked" | "onChange" | "disabled" | "children" | "className" | "size"
> & {
  isSelected?: boolean;
  defaultSelected?: boolean;
  isDisabled?: boolean;
  isIndeterminate?: boolean;
  isInvalid?: boolean;
  onChange?: (isSelected: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  size?: CheckboxSize;
  className?: string;
  children?: ReactNode;
};

export function Checkbox({
  id,
  isSelected,
  defaultSelected,
  isDisabled,
  isIndeterminate,
  isInvalid,
  onChange,
  label,
  description,
  size = "sm",
  className,
  children,
  ...props
}: CheckboxProps) {
  const labelNode = label ?? children;
  const fallbackId = useId();
  const resolvedId = id ?? fallbackId;
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }
    input.indeterminate = Boolean(isIndeterminate);
  }, [isIndeterminate]);

  const checked =
    typeof isSelected === "boolean" ? isSelected : undefined;
  const defaultChecked =
    typeof checked === "boolean" ? undefined : typeof defaultSelected === "boolean" ? defaultSelected : undefined;

  const tone = isInvalid
    ? "border-rose-400"
    : "border-slate-300 bg-white text-slate-600 checked:border-primary-500 checked:bg-primary-500 checked:text-white dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200";
  const disabledTone = isDisabled
    ? "border-slate-200 bg-slate-100 text-slate-400 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-500"
    : "";

  return (
    <label
      className={[
        WRAPPER_BASE,
        isDisabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
        className
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span className={BOX_BASE}>
        <input
          {...props}
          id={resolvedId}
          ref={inputRef}
          type="checkbox"
          className={[
            INPUT_BASE,
            SIZE_CLASSES[size].box,
            "appearance-none",
            tone,
            disabledTone,
          ]
            .filter(Boolean)
            .join(" ")}
          disabled={isDisabled}
          checked={checked}
          defaultChecked={defaultChecked}
          onChange={(event) => onChange?.(event.currentTarget.checked)}
        />
        {isIndeterminate ? (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="h-0.5 w-2 rounded-full bg-white" aria-hidden="true" />
          </span>
        ) : (
          <Check
            className="pointer-events-none absolute inset-0 m-auto h-3.5 w-3.5 text-white opacity-0 transition-opacity peer-checked:opacity-100"
            aria-hidden="true"
          />
        )}
      </span>
      {labelNode || description ? (
        <span className="flex flex-col gap-0.5">
          {labelNode ? (
            <span className={`${LABEL_BASE} ${SIZE_CLASSES[size].text}`}>{labelNode}</span>
          ) : null}
          {description ? (
            <span className={`${SIZE_CLASSES[size].description} text-slate-500 dark:text-slate-400`}>
              {description}
            </span>
          ) : null}
        </span>
      ) : null}
    </label>
  );
}
