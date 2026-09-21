import { composeRenderProps } from "react-aria-components";
import { IconButton, type IconButtonProps } from "./Button";

export type ToggleIconButtonProps = Omit<IconButtonProps, "variant"> & {
  isSelected: boolean;
  /**
   * "chip" is the toolbar toggle: a ringed, filled control that reads as a
   * button on its own. "bare" is for a toggle that lives inside a text
   * field, such as a password or secret reveal: a muted glyph with no ring,
   * fill or shadow, which is how such reveals look in the field they sit in
   * (a ringed circle inside a bordered field was a box inside a box). The
   * set state is the glyph's colour, and `aria-pressed` says it either way.
   */
  appearance?: "chip" | "bare";
};

const BARE_STATE_CLASSES = {
  selected: [
    "!bg-transparent shadow-none !text-primary-600",
    "hover:!bg-primary-50 data-[hovered]:!bg-primary-50 data-[pressed]:!bg-primary-100",
    "dark:!text-primary-300 dark:hover:!bg-primary-400/10 dark:data-[hovered]:!bg-primary-400/10 dark:data-[pressed]:!bg-primary-400/20",
  ],
  unselected: [
    "!bg-transparent shadow-none !text-slate-500",
    "hover:!bg-slate-100 data-[hovered]:!bg-slate-100 data-[pressed]:!bg-slate-200",
    "dark:!text-slate-400 dark:hover:!bg-slate-800/60 dark:data-[hovered]:!bg-slate-800/60 dark:data-[pressed]:!bg-slate-700/60",
  ],
};

export function ToggleIconButton({
  isSelected,
  className,
  appearance = "chip",
  ...props
}: ToggleIconButtonProps) {
  if (appearance === "bare") {
    return (
      <IconButton
        {...props}
        variant="ghost"
        aria-pressed={isSelected}
        className={composeRenderProps(className, (value) =>
          [...(isSelected ? BARE_STATE_CLASSES.selected : BARE_STATE_CLASSES.unselected), value]
            .filter(Boolean)
            .join(" "),
        )}
      />
    );
  }
  const stateClasses = isSelected
    ? [
        "!bg-primary-600 !text-white ring-primary-600/30 shadow-primary-600/20",
        "hover:!bg-primary-700 data-[hovered]:!bg-primary-700 hover:ring-primary-600/40 data-[hovered]:ring-primary-600/40",
        "data-[pressed]:!bg-primary-800 data-[pressed]:ring-primary-600/50 data-[pressed]:shadow-none",
        "dark:!bg-primary-500/30 dark:!text-primary-100 dark:ring-primary-400/60 dark:shadow-none",
        "dark:hover:!bg-primary-500/40 dark:data-[hovered]:!bg-primary-500/40 dark:hover:ring-primary-300/70 dark:data-[hovered]:ring-primary-300/70",
        "dark:data-[pressed]:!bg-primary-500/55 dark:data-[pressed]:ring-primary-200/80",
      ]
    : [
        "!bg-slate-50 !text-slate-700 ring-slate-200 shadow-slate-200/40",
        "hover:!bg-slate-100 data-[hovered]:!bg-slate-100 hover:ring-slate-300 data-[hovered]:ring-slate-300",
        "data-[pressed]:!bg-slate-200 data-[pressed]:ring-slate-400 data-[pressed]:shadow-none",
        "dark:!bg-slate-900/30 dark:!text-slate-100 dark:ring-slate-700 dark:shadow-none",
        "dark:hover:!bg-slate-800/70 dark:data-[hovered]:!bg-slate-800/70 dark:hover:ring-slate-600 dark:data-[hovered]:ring-slate-600",
        "dark:data-[pressed]:!bg-slate-700/70 dark:data-[pressed]:ring-slate-500",
      ];
  return (
    <IconButton
      {...props}
      variant="ghost"
      aria-pressed={isSelected}
      className={composeRenderProps(className, (value) =>
        [
          "ring-1 ring-inset shadow-sm",
          ...stateClasses,
          value,
        ]
          .filter(Boolean)
          .join(" "),
      )}
    />
  );
}
