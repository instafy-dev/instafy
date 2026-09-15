import {
  Menu,
  MenuItem,
  Separator,
  composeRenderProps,
  type MenuProps,
  type MenuItemProps,
  type SeparatorProps,
} from "react-aria-components";
import { textVariants } from "../../styles/typography";

const MENU_BASE = "outline-none";
const MENU_ITEM_BASE =
  `flex w-full cursor-pointer select-none items-center justify-between rounded-lg px-2.5 py-1.5 ${textVariants.control} text-slate-600 transition data-[hovered]:bg-slate-100 data-[focused]:bg-slate-100 data-[selected]:text-slate-900 data-[selected]:font-medium data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 dark:text-slate-300 dark:data-[hovered]:bg-[var(--color-studio-dark-control-hover)] dark:data-[focused]:bg-[var(--color-studio-dark-control-hover)] dark:data-[selected]:text-slate-50`;
const MENU_SEPARATOR_BASE = "my-1.5 h-px bg-slate-200 dark:bg-[var(--color-studio-dark-divider)]";

function mergeClassName(base: string, extra?: string) {
  if (!extra) {
    return base;
  }
  return `${base} ${extra}`;
}

export function StudioMenu<T extends object>({ className, ...props }: MenuProps<T>) {
  return (
    <Menu
      {...props}
      className={composeRenderProps(className, (value) => mergeClassName(MENU_BASE, value))}
    />
  );
}

export function StudioMenuItem<T extends object>({ className, ...props }: MenuItemProps<T>) {
  return (
    <MenuItem
      {...props}
      className={composeRenderProps(className, (value) => mergeClassName(MENU_ITEM_BASE, value))}
    />
  );
}

export function StudioMenuSeparator({ className, ...props }: SeparatorProps) {
  return (
    <Separator
      {...props}
      className={mergeClassName(MENU_SEPARATOR_BASE, className)}
    />
  );
}
