import {
  Children,
  Fragment,
  forwardRef,
  isValidElement,
  useCallback,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  Button,
  Select as AriaSelect,
  SelectValue,
  composeRenderProps,
  type Key,
} from "react-aria-components";
import { ControlChevron } from "./ControlChevron";
import { StudioListBox, StudioListBoxItem } from "./aria/StudioListBox";
import { StudioPopover } from "./aria/StudioPopover";

// The one value picker. It keeps the shape every call site already uses, a
// native-looking element with <option> children and an onChange that hands
// back event.target.value, and draws its own menu instead of the operating
// system's. A census across the product found sixteen native-backed pickers
// against zero uses of the app-drawn ToolbarMenuSelect, and every one of the
// sixteen leaned on props that component lacked: disabled, sizes, test ids,
// per-option disabled, a placeholder option, an id for a Field label. So the
// unification happened here, inside the primitive, and the call sites did not
// move. Pass native for the one place the OS control is the right one, the
// phone-width twin in ProjectPickerPanel, where a touch device's own wheel
// picker beats anything we draw.

type ControlSize = "xs" | "sm" | "md" | "lg";
type ControlRadius = "md" | "lg" | "xl" | "2xl" | "full";
type ControlTone = "default" | "muted";

const BASE =
  "min-w-0 appearance-none border text-midnight outline-none transition pointer-coarse:min-h-11 focus-visible:ring-2 focus-visible:ring-primary-400/40 focus-visible:border-primary-400 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 dark:text-slate-100 dark:disabled:bg-[var(--color-studio-dark-active)] dark:disabled:text-slate-500";

// The trigger is a button, so the disabled styling reads react-aria's data
// attribute rather than the :disabled pseudo-class the native element gets.
const TRIGGER_BASE =
  "min-w-0 flex items-center border text-left text-midnight outline-none transition pointer-coarse:min-h-11 data-[focus-visible]:ring-2 data-[focus-visible]:ring-primary-400/40 data-[focus-visible]:border-primary-400 data-[disabled]:cursor-not-allowed data-[disabled]:bg-slate-100 data-[disabled]:text-slate-400 dark:text-slate-100 dark:data-[disabled]:bg-[var(--color-studio-dark-active)] dark:data-[disabled]:text-slate-500";

const SIZE_CLASSES: Record<ControlSize, string> = {
  xs: "px-2.5 py-1 text-base sm:text-xs",
  sm: "px-3 py-1.5 text-base sm:text-sm",
  md: "min-h-11 px-3 py-2 text-base sm:text-sm sm:pointer-fine:min-h-[38px]",
  lg: "px-4 py-2.5 text-base",
};

const ICON_PADDING: Record<ControlSize, string> = {
  xs: "pr-8",
  sm: "pr-9",
  md: "pr-10",
  lg: "pr-11",
};

const RADIUS_CLASSES: Record<ControlRadius, string> = {
  md: "rounded-md",
  lg: "rounded-lg",
  xl: "rounded-xl",
  "2xl": "rounded-2xl",
  full: "rounded-full",
};

const TONE_CLASSES: Record<ControlTone, string> = {
  default:
    "border-slate-200 bg-white dark:border-[color:var(--color-studio-dark-raised-control-border)] dark:bg-[var(--color-studio-dark-raised-control)]",
  muted:
    "border-slate-200 bg-slate-50 dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-panel-soft)]",
};

export type SelectProps = Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "size"> & {
  size?: ControlSize;
  radius?: ControlRadius;
  tone?: ControlTone;
  fullWidth?: boolean;
  selectClassName?: React.SelectHTMLAttributes<HTMLSelectElement>["className"];
  /** Render the operating system's own control. For touch surfaces only. */
  native?: boolean;
};

type OptionSpec = { value: string; label: string; disabled: boolean };

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join("");
  }
  if (isValidElement(node)) {
    return textOf((node.props as { children?: ReactNode }).children);
  }
  return "";
}

/**
 * The <option> children, flattened. Fragments and arrays are walked, because
 * call sites wrap conditional groups in <>...</>, and anything that is not an
 * option is ignored rather than rendered, which is what a native select does.
 */
function collectOptions(children: ReactNode): OptionSpec[] {
  const out: OptionSpec[] = [];
  const walk = (node: ReactNode) => {
    Children.forEach(node, (child) => {
      if (!isValidElement(child)) {
        return;
      }
      const element = child as ReactElement<{
        value?: unknown;
        disabled?: boolean;
        children?: ReactNode;
      }>;
      if (element.type === Fragment) {
        walk(element.props.children);
        return;
      }
      if (element.type === "option") {
        const raw = element.props.value;
        const value = raw === undefined || raw === null ? textOf(element.props.children) : String(raw);
        out.push({ value, label: textOf(element.props.children), disabled: Boolean(element.props.disabled) });
      }
    });
  };
  walk(children);
  return out;
}

function NativeSelect(
  {
    size = "md",
    radius = "xl",
    tone = "default",
    fullWidth = true,
    className,
    selectClassName,
    native,
    ...props
  }: SelectProps,
  ref: React.ForwardedRef<HTMLSelectElement>,
) {
  // Consumed by Select's branch above; pulled out here only so it never lands
  // on the element as an unknown attribute.
  void native;
  return (
    <div className={["relative min-w-0", fullWidth ? "w-full" : "w-fit", className].filter(Boolean).join(" ")}>
      <select
        ref={ref}
        className={[BASE, SIZE_CLASSES[size], ICON_PADDING[size], RADIUS_CLASSES[radius], TONE_CLASSES[tone], "w-full", selectClassName]
          .filter(Boolean)
          .join(" ")}
        {...props}
      />
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2" aria-hidden="true">
        <ControlChevron />
      </span>
    </div>
  );
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(props, ref) {
  if (props.native) {
    return NativeSelect(props, ref);
  }
  return <StyledSelect {...props} />;
});

function StyledSelect({
  size = "sm",
  radius = "xl",
  tone = "default",
  fullWidth = true,
  className,
  selectClassName,
  native,
  children,
  value,
  defaultValue,
  onChange,
  disabled,
  required,
  name,
  id,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  autoFocus,
  ...rest
}: SelectProps) {
  void native;
  // children is a fresh array on every render, so memoising on its identity
  // memoises nothing: react-aria would receive a new items array each time,
  // rebuild its collection, and in a live browser that can chase its own tail
  // when a parent re-renders in response. Key the memo on what the options
  // actually say instead, so the collection is stable until an option changes.
  const collected = collectOptions(children);
  const optionsKey = collected.map((o) => `${o.value}\u0000${o.label}\u0000${o.disabled ? 1 : 0}`).join("\u0001");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const options = useMemo(() => collected, [optionsKey]);
  const disabledKeys = useMemo(() => options.filter((o) => o.disabled).map((o) => o.value), [options]);

  // A value="" option is the placeholder a native select shows until something
  // is chosen. It stays a real, choosable item so a form can go back to it,
  // which is what value="" callers such as the space launcher rely on.
  const placeholder = options.find((o) => o.value === "")?.label;

  const controlled = value !== undefined;
  // Uncontrolled callers still expect the control to know what it holds, and
  // anything reading the trigger (a test, a form, a screen reader) needs the
  // value the way a native element exposes it. data-value is that mirror.
  const [internal, setInternal] = useState(() =>
    defaultValue === undefined || defaultValue === null ? "" : String(defaultValue),
  );
  const current = controlled ? (value === null ? "" : String(value)) : internal;

  const handleSelectionChange = useCallback(
    (key: Key | null) => {
      const next = key === null ? "" : String(key);
      setInternal(next);
      if (!onChange) {
        return;
      }
      // The one thing every caller reads is event.target.value. Handing them a
      // shape with exactly that keeps fifteen call sites untouched; nobody
      // reads anything else off it and nothing here pretends to be a DOM event
      // beyond that field.
      const target = { value: next, name } as unknown as EventTarget & HTMLSelectElement;
      onChange({ target, currentTarget: target } as React.ChangeEvent<HTMLSelectElement>);
    },
    [name, onChange],
  );

  const selectedKey = controlled ? (value === null ? null : String(value)) : undefined;
  const defaultSelectedKey = !controlled && defaultValue !== undefined ? String(defaultValue) : undefined;

  // Anything left in rest is a data-* or aria-* attribute meant for the
  // control a test or a screen reader will find, which is the trigger.
  const passthrough = rest as Record<string, unknown>;

  return (
    <AriaSelect
      selectedKey={selectedKey}
      defaultSelectedKey={defaultSelectedKey}
      onSelectionChange={handleSelectionChange}
      isDisabled={disabled}
      isRequired={required}
      name={name}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      autoFocus={autoFocus}
      placeholder={placeholder}
      className={["relative min-w-0", fullWidth ? "w-full" : "w-fit", className].filter(Boolean).join(" ")}
    >
      <Button
        id={id}
        data-value={current}
        {...passthrough}
        className={composeRenderProps(selectClassName, (extra) =>
          [TRIGGER_BASE, SIZE_CLASSES[size], ICON_PADDING[size], RADIUS_CLASSES[radius], TONE_CLASSES[tone], "w-full", extra]
            .filter(Boolean)
            .join(" "),
        )}
      >
        <SelectValue className="min-w-0 flex-1 truncate data-[placeholder]:text-slate-400 dark:data-[placeholder]:text-slate-500" />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2" aria-hidden="true">
          <ControlChevron />
        </span>
      </Button>
      <StudioPopover placement="bottom start" offset={4} className="min-w-[--trigger-width] p-1">
        <StudioListBox
          className="max-h-[inherit] overflow-y-auto"
          disabledKeys={disabledKeys}
          items={options}
        >
          {(option) => (
            <StudioListBoxItem
              id={option.value}
              textValue={option.label || option.value}
              data-value={option.value}
              className="data-[selected]:bg-slate-100 dark:data-[selected]:bg-[var(--color-studio-dark-control-hover)]"
            >
              {option.label}
            </StudioListBoxItem>
          )}
        </StudioListBox>
      </StudioPopover>
    </AriaSelect>
  );
}
