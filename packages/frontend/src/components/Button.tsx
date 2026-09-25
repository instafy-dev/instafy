import { forwardRef, useCallback, type ForwardedRef, type ReactNode } from "react";
import {
  Button as AriaButton,
  ProgressBar,
  composeRenderProps,
  type ButtonProps as AriaButtonProps
} from "react-aria-components";
import { Spinner, type SpinnerSize } from "./Spinner";

type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger";
type ButtonSize = "xs" | "sm" | "md" | "lg" | "icon";
type ButtonRadius = "none" | "md" | "lg" | "xl" | "2xl" | "full";

// The press nudge is a translate. Tailwind v4 translate utilities share one
// --tw-translate-x/--tw-translate-y pair, so it replaces any translate a caller
// sets: centre a button with `inset-y-0 my-auto` or a flex wrapper, never with
// `top-1/2 -translate-y-1/2` (guarded by __tests__/buttonPressTranslate.test.ts).
const BASE =
  "inline-flex items-center justify-center gap-2 font-medium touch-manipulation [-webkit-tap-highlight-color:transparent] transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-out focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-[var(--color-studio-dark-canvas)] data-[pressed]:translate-y-px data-[pressed]:scale-[0.98] data-[disabled]:pointer-events-none data-[disabled]:opacity-60 disabled:pointer-events-none disabled:opacity-60 data-[pending]:pointer-events-none";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "bg-primary-600 text-white shadow-sm shadow-primary-600/20 hover:bg-primary-700 data-[hovered]:bg-primary-700 hover:shadow-md hover:shadow-primary-600/25 data-[hovered]:shadow-md data-[hovered]:shadow-primary-600/25 data-[pressed]:bg-primary-800 data-[pressed]:shadow-none",
  secondary:
    "bg-slate-100 text-slate-700 shadow-sm shadow-slate-200/60 hover:bg-slate-200/90 data-[hovered]:bg-slate-200/90 hover:shadow-md hover:shadow-slate-200/80 data-[hovered]:shadow-md data-[hovered]:shadow-slate-200/80 data-[pressed]:bg-slate-300 data-[pressed]:shadow-none dark:bg-[var(--color-studio-dark-active)] dark:text-slate-100 dark:shadow-none dark:hover:bg-[var(--color-studio-dark-control-hover)] dark:data-[hovered]:bg-[var(--color-studio-dark-control-hover)] dark:data-[pressed]:bg-[var(--color-studio-dark-active)]",
  outline:
    "border border-slate-200 bg-white text-slate-700 shadow-sm shadow-slate-200/40 hover:border-slate-300 hover:bg-slate-50 data-[hovered]:border-slate-300 data-[hovered]:bg-slate-50 data-[pressed]:border-slate-400 data-[pressed]:bg-slate-100 data-[pressed]:shadow-none dark:border-[color:var(--color-studio-dark-raised-control-border)] dark:bg-[var(--color-studio-dark-raised-control)] dark:text-slate-100 dark:shadow-none dark:hover:border-[color:var(--color-studio-dark-active-border)] dark:hover:bg-[var(--color-studio-dark-control-hover)] dark:data-[hovered]:border-[color:var(--color-studio-dark-active-border)] dark:data-[hovered]:bg-[var(--color-studio-dark-control-hover)] dark:data-[pressed]:border-[color:var(--color-studio-dark-active-border)] dark:data-[pressed]:bg-[var(--color-studio-dark-active)]",
  ghost:
    "bg-transparent text-slate-700 hover:bg-slate-100 data-[hovered]:bg-slate-100 data-[pressed]:bg-slate-200/80 data-[pressed]:text-slate-900 dark:text-slate-200 dark:hover:bg-[var(--color-studio-dark-control-hover)] dark:data-[hovered]:bg-[var(--color-studio-dark-control-hover)] dark:data-[pressed]:bg-[var(--color-studio-dark-active)] dark:data-[pressed]:text-slate-50",
  danger:
    "bg-rose-500 text-white shadow-sm shadow-rose-500/20 hover:bg-rose-600 data-[hovered]:bg-rose-600 hover:shadow-md hover:shadow-rose-500/25 data-[hovered]:shadow-md data-[hovered]:shadow-rose-500/25 data-[pressed]:bg-rose-700 data-[pressed]:shadow-none"
};

// Coarse pointers (touch) get a 44px minimum height on the small sizes so tap
// targets meet the accessibility guideline; fine pointers (desktop) keep the
// compact density unchanged.
const SIZE_CLASSES: Record<ButtonSize, string> = {
  xs: "px-2 py-1 text-xs pointer-coarse:min-h-11",
  sm: "px-2.5 py-1.5 text-sm pointer-coarse:min-h-11",
  md: "px-3.5 py-2 text-sm",
  lg: "px-4 py-2.5 text-base",
  icon: "p-0 text-sm"
};

const RADIUS_CLASSES: Record<ButtonRadius, string> = {
  none: "rounded-none",
  md: "rounded-md",
  lg: "rounded-lg",
  xl: "rounded-xl",
  "2xl": "rounded-2xl",
  full: "rounded-full"
};

// The pending glyph takes the leading icon's place at the icon's size. A button
// without an icon keeps its label in place (and in its accessible name) but
// fades it out under a centred spinner. Either way nothing moves or resizes
// when a press starts waiting.
const PENDING_SPINNER_SIZE: Record<ButtonSize, SpinnerSize> = {
  xs: "xs",
  sm: "md",
  md: "md",
  lg: "md",
  icon: "md"
};

/**
 * `isPending` belongs on the pressed control only. React Aria keeps a pending
 * button focusable, ignores presses and sets aria-disabled; the spinner below
 * replaces `icon` (or the whole content of an icon button). Do not combine it
 * with `isDisabled` on the same control: native `disabled` drops focus.
 *
 * A pending submit button stops being the form's default button, so a form
 * with a single text field submits again on Enter. Guard the submit handler
 * against re-entry rather than relying on the button.
 */
export type ButtonProps = Omit<AriaButtonProps, "className"> & {
  /** Leading glyph, replaced by the pending spinner while `isPending`. */
  icon?: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  radius?: ButtonRadius;
  fullWidth?: boolean;
  className?: AriaButtonProps["className"];
  title?: string;
};

function assignForwardedRef<T>(ref: ForwardedRef<T>, value: T | null) {
  if (typeof ref === "function") {
    ref(value);
  } else if (ref) {
    ref.current = value;
  }
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "sm",
    radius = "lg",
    fullWidth = false,
    className,
    title,
    icon,
    children,
    ...props
  },
  ref
) {
  // react-aria-components filters the native `title` attribute even though
  // our shared Button API exposes it. Apply it through the DOM ref so icon
  // controls keep their hover affordance alongside the accessible label.
  const buttonRef = useCallback(
    (node: HTMLButtonElement | null) => {
      if (node) {
        if (title) {
          node.title = title;
        } else {
          node.removeAttribute("title");
        }
      }
      assignForwardedRef(ref, node);
    },
    [ref, title],
  );

  return (
    <AriaButton
      {...props}
      ref={buttonRef}
      className={composeRenderProps(className, (value) =>
        [
          BASE,
          VARIANT_CLASSES[variant],
          SIZE_CLASSES[size],
          RADIUS_CLASSES[radius],
          fullWidth ? "w-full" : "",
          value
        ]
          .filter(Boolean)
          .join(" ")
      )}
    >
      {composeRenderProps(children, (content, { isPending }) => {
        // React Aria's pattern: a labelled ProgressBar inside the pending
        // button, so the name announced when the press starts reads
        // "Loading" and not just the unchanged label.
        const pendingGlyph = (className?: string) => (
          <ProgressBar
            aria-label="Loading"
            isIndeterminate
            className={["inline-flex shrink-0", className].filter(Boolean).join(" ")}
          >
            <Spinner tone="current" size={PENDING_SPINNER_SIZE[size]} aria-hidden="true" />
          </ProgressBar>
        );
        if (size === "icon") {
          return isPending ? pendingGlyph() : content;
        }
        if (isPending && !icon) {
          return (
            <span className="relative inline-flex items-center justify-center">
              <span className="inline-flex items-center gap-2 opacity-0">{content}</span>
              {pendingGlyph("absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2")}
            </span>
          );
        }
        const glyph = isPending ? pendingGlyph() : icon;
        return glyph ? (
          <>
            {glyph}
            {content}
          </>
        ) : (
          content
        );
      })}
    </AriaButton>
  );
});

Button.displayName = "Button";

const ICON_SIZES = {
  xs: "h-6 w-6 text-sm pointer-coarse:min-h-11 pointer-coarse:min-w-11",
  sm: "h-8 w-8 text-base pointer-coarse:min-h-11 pointer-coarse:min-w-11",
  md: "h-9 w-9 text-base pointer-coarse:min-h-11 pointer-coarse:min-w-11",
  lg: "h-10 w-10 text-lg pointer-coarse:min-h-11 pointer-coarse:min-w-11"
};

export type IconButtonProps = Omit<ButtonProps, "size" | "icon"> & {
  size?: keyof typeof ICON_SIZES;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { size = "sm", className, ...props },
  ref,
) {
  return (
    <Button
      {...props}
      ref={ref}
      size="icon"
      className={composeRenderProps(className, (value) =>
        [ICON_SIZES[size], value].filter(Boolean).join(" ")
      )}
    />
  );
});

IconButton.displayName = "IconButton";
