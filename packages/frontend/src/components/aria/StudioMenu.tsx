import {
  Button,
  Menu,
  MenuItem,
  Separator,
  composeRenderProps,
  type MenuProps,
  type ButtonProps,
  type MenuItemProps,
  type SeparatorProps,
} from "react-aria-components";

const MENU_BASE = "outline-none";
const MENU_ITEM_BASE =
  "flex w-full cursor-pointer select-none items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-sm leading-5 text-slate-600 outline-none transition pointer-coarse:min-h-11 data-[focus-visible]:ring-2 data-[focus-visible]:ring-inset data-[focus-visible]:ring-primary-400/40 data-[hovered]:bg-slate-100 data-[focused]:bg-slate-100 data-[pressed]:bg-slate-100 data-[selected]:text-slate-900 data-[selected]:font-medium data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 dark:text-slate-300 dark:data-[hovered]:bg-[var(--color-studio-dark-control-hover)] dark:data-[focused]:bg-[var(--color-studio-dark-control-hover)] dark:data-[pressed]:bg-[var(--color-studio-dark-control-hover)] dark:data-[selected]:text-slate-50";
// React Aria renders an hr. Its preflight border would cover the divider fill
// with currentColor, so the shared one-pixel surface supplies the whole line.
const MENU_SEPARATOR_BASE = "my-1.5 h-px border-0 bg-slate-200 dark:bg-[var(--color-studio-dark-divider)]";

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

/** Menu-row presentation for actions inside a dialog or drill-in panel.
 * Keep button semantics and the owner's focus navigation instead of requiring
 * an ARIA Menu collection for mixed, multi-page content. */
export function StudioMenuAction({ className, ...props }: ButtonProps) {
  return (
    <Button
      type="button"
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
