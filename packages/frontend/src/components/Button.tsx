import { forwardRef, useCallback, type ForwardedRef, type ReactNode } from "react";
import {
  Button as AriaButton,
  ProgressBar,
  composeRenderProps,
  type ButtonProps as AriaButtonProps
} from "react-aria-components";
import { Spinner, type SpinnerSize } from "./Spinner";

type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "text" | "danger";
type ButtonTone = "neutral" | "muted" | "danger" | "accent";
type ButtonSize = "xs" | "sm" | "md" | "lg" | "icon";
type ButtonRadius = "none" | "md" | "lg" | "xl" | "2xl" | "full";
type ButtonElevation = "none" | "raised";
export type ButtonPreset = "inline" | "form";

// Task-level presets own geometry and elevation; callers still choose importance
// with variant/tone. Pointer adaptation remains shared by every button.
const BUTTON_PRESETS = {
  inline: { size: "sm", radius: "xl", elevation: "none" },
  form: { size: "md", radius: "xl", elevation: "none" },
} as const satisfies Record<ButtonPreset, { size: ButtonSize; radius: ButtonRadius; elevation: ButtonElevation }>;

// The press nudge is a translate. Tailwind v4 translate utilities share one
// --tw-translate-x/--tw-translate-y pair, so it replaces any translate a caller
// sets: centre a button with `inset-y-0 my-auto` or a flex wrapper, never with
// `top-1/2 -translate-y-1/2` (guarded by __tests__/buttonPressTranslate.test.ts).
const BASE =
  "inline-flex items-center justify-center gap-2 font-medium touch-manipulation [-webkit-tap-highlight-color:transparent] transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-out focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-[var(--color-studio-dark-canvas)] data-[pressed]:translate-y-px data-[pressed]:scale-[0.98] data-[disabled]:pointer-events-none data-[disabled]:opacity-60 disabled:pointer-events-none disabled:opacity-60 data-[pending]:pointer-events-none";

const FILLED_VARIANT_CLASSES = {
  primary:
    "bg-primary-600 text-white hover:bg-primary-700 data-[hovered]:bg-primary-700 data-[pressed]:bg-primary-800",
  secondary:
    "bg-slate-100 text-slate-700 hover:bg-slate-200/90 data-[hovered]:bg-slate-200/90 data-[pressed]:bg-slate-300 dark:bg-[var(--color-studio-dark-active)] dark:text-slate-100 dark:hover:bg-[var(--color-studio-dark-control-hover)] dark:data-[hovered]:bg-[var(--color-studio-dark-control-hover)] dark:data-[pressed]:bg-[var(--color-studio-dark-active)]",
  danger:
    "bg-rose-500 text-white hover:bg-rose-600 data-[hovered]:bg-rose-600 data-[pressed]:bg-rose-700"
};

const RAISED_CLASSES = {
  primary: "shadow-sm shadow-primary-600/20 hover:shadow-md hover:shadow-primary-600/25 data-[hovered]:shadow-md data-[hovered]:shadow-primary-600/25 data-[pressed]:shadow-none",
  secondary: "shadow-sm shadow-slate-200/60 hover:shadow-md hover:shadow-slate-200/80 data-[hovered]:shadow-md data-[hovered]:shadow-slate-200/80 data-[pressed]:shadow-none dark:shadow-none",
  danger: "shadow-sm shadow-rose-500/20 hover:shadow-md hover:shadow-rose-500/25 data-[hovered]:shadow-md data-[hovered]:shadow-rose-500/25 data-[pressed]:shadow-none",
  outline: "shadow-sm shadow-slate-200/40 data-[pressed]:shadow-none dark:shadow-none",
};

// Quiet actions select one complete palette rather than competing with the
// neutral variant through caller classes. Filled variants retain their palette.
const TONE_CLASSES: Record<ButtonTone, string> = {
  neutral: "text-slate-700 hover:text-slate-900 data-[hovered]:text-slate-900 data-[pressed]:text-slate-900 dark:text-slate-200 dark:hover:text-slate-50 dark:data-[hovered]:text-slate-50 dark:data-[pressed]:text-slate-50",
  muted: "text-slate-500 hover:text-slate-800 data-[hovered]:text-slate-800 data-[pressed]:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 dark:data-[hovered]:text-slate-100 dark:data-[pressed]:text-slate-50",
  danger: "text-rose-600 hover:text-rose-700 data-[hovered]:text-rose-700 data-[pressed]:text-rose-800 dark:text-rose-300 dark:hover:text-rose-200 dark:data-[hovered]:text-rose-200 dark:data-[pressed]:text-rose-100",
  accent: "text-primary-600 hover:text-primary-700 data-[hovered]:text-primary-700 data-[pressed]:text-primary-800 dark:text-primary-300 dark:hover:text-primary-200 dark:data-[hovered]:text-primary-200 dark:data-[pressed]:text-primary-100",
};
const QUIET_SURFACE_CLASSES: Record<ButtonTone, string> = {
  neutral: "hover:bg-slate-100 data-[hovered]:bg-slate-100 data-[pressed]:bg-slate-200/80 dark:hover:bg-[var(--color-studio-dark-control-hover)] dark:data-[hovered]:bg-[var(--color-studio-dark-control-hover)] dark:data-[pressed]:bg-[var(--color-studio-dark-active)]",
  muted: "hover:bg-slate-100 data-[hovered]:bg-slate-100 data-[pressed]:bg-slate-200/80 dark:hover:bg-[var(--color-studio-dark-control-hover)] dark:data-[hovered]:bg-[var(--color-studio-dark-control-hover)] dark:data-[pressed]:bg-[var(--color-studio-dark-active)]",
  danger: "hover:bg-rose-50 data-[hovered]:bg-rose-50 data-[pressed]:bg-rose-100 dark:hover:bg-rose-500/10 dark:data-[hovered]:bg-rose-500/10 dark:data-[pressed]:bg-rose-500/20",
  accent: "hover:bg-primary-50 data-[hovered]:bg-primary-50 data-[pressed]:bg-primary-100 dark:hover:bg-primary-400/10 dark:data-[hovered]:bg-primary-400/10 dark:data-[pressed]:bg-primary-400/20",
};
const OUTLINE_CLASSES = "border border-slate-200 bg-white hover:border-slate-300 data-[hovered]:border-slate-300 data-[pressed]:border-slate-400 dark:border-[color:var(--color-studio-dark-raised-control-border)] dark:bg-[var(--color-studio-dark-raised-control)] dark:hover:border-[color:var(--color-studio-dark-active-border)] dark:data-[hovered]:border-[color:var(--color-studio-dark-active-border)] dark:data-[pressed]:border-[color:var(--color-studio-dark-active-border)]";

function appearanceClasses(variant: ButtonVariant, tone: ButtonTone, elevation: ButtonElevation): string {
  if (variant === "primary" || variant === "secondary" || variant === "danger") {
    return [FILLED_VARIANT_CLASSES[variant], elevation === "raised" ? RAISED_CLASSES[variant] : ""].filter(Boolean).join(" ");
  }
  if (variant === "text") {
    return `bg-transparent underline-offset-2 hover:underline data-[hovered]:underline ${TONE_CLASSES[tone]}`;
  }
  return [
    variant === "outline" ? OUTLINE_CLASSES : "bg-transparent",
    variant === "outline" && elevation === "raised" ? RAISED_CLASSES.outline : "",
    TONE_CLASSES[tone],
    QUIET_SURFACE_CLASSES[tone],
  ].filter(Boolean).join(" ");
}

// The primary pointer owns density: fine pointers keep each size's compact
// dimensions at every width; coarse pointers get a 44px target. Wrappers such
// as form pickers can independently supply their form-control minimums.
const TARGET_CLASSES = "pointer-coarse:min-h-11 pointer-coarse:min-w-11";
const SIZE_CLASSES: Record<ButtonSize, string> = {
  xs: "px-2 py-1 text-xs",
  sm: "px-2.5 py-1.5 text-sm",
  md: "px-3.5 py-2 text-sm",
  lg: "px-4 py-2.5 text-base",
  icon: "p-0 text-sm"
};
const TEXT_SIZE_CLASSES: Record<ButtonSize, string> = {
  xs: "p-0 text-xs", sm: "p-0 text-sm", md: "p-0 text-sm", lg: "p-0 text-base", icon: "p-0 text-sm",
};

// Keep outlined and filled preset actions the same height. The 1px outline
// replaces padding instead of adding to it; wrapping labels can still grow.
const PRESET_OUTLINE_SIZE_CLASSES: Record<ButtonPreset, string> = {
  inline: "px-2.5 py-[calc(0.375rem-1px)] text-sm",
  form: "px-3.5 py-[calc(0.5rem-1px)] text-sm",
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
  /** Palette for ghost, outline and text actions; filled variants own their tone. */
  tone?: ButtonTone;
  fullWidth?: boolean;
  className?: AriaButtonProps["className"];
  title?: string;
} & (
  | {
      /** Shared treatment for contextual actions or form submit/cancel controls. */
      preset: ButtonPreset;
      size?: never;
      radius?: never;
      elevation?: never;
    }
  | {
      preset?: undefined;
      size?: ButtonSize;
      radius?: ButtonRadius;
      /** Shadows for filled and outlined actions. Ghost and text actions are always flat. */
      elevation?: ButtonElevation;
    }
);

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
    tone = "neutral",
    preset,
    elevation: customElevation,
    size: customSize,
    radius: customRadius,
    fullWidth = false,
    className,
    title,
    icon,
    children,
    ...props
  },
  ref
) {
  const { size, radius, elevation } = preset ? BUTTON_PRESETS[preset] : {
    size: customSize ?? "sm",
    radius: customRadius ?? "lg",
    elevation: customElevation ?? "raised",
  };
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
          appearanceClasses(variant, tone, elevation),
          TARGET_CLASSES,
          preset
            ? variant === "outline" ? PRESET_OUTLINE_SIZE_CLASSES[preset] : SIZE_CLASSES[size]
            : variant === "text" ? TEXT_SIZE_CLASSES[size] : SIZE_CLASSES[size],
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
  xs: "h-6 w-6 text-sm",
  sm: "h-8 w-8 text-base",
  md: "h-9 w-9 text-base",
  lg: "h-10 w-10 text-lg"
};

export type IconButtonProps = Omit<ButtonProps, "size" | "icon" | "preset"> & {
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
