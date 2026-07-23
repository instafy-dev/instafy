import { composeRenderProps } from "react-aria-components";
import { IconButton, type IconButtonProps } from "./Button";

export type ToggleIconButtonProps = Omit<IconButtonProps, "variant"> & {
  isSelected: boolean;
};

export function ToggleIconButton({ isSelected, className, ...props }: ToggleIconButtonProps) {
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
