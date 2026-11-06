import { forwardRef, type KeyboardEvent } from "react";
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
import { STUDIO_MENU_ARIA_ROW_CLASS } from "./studioMenuStyles";

/** Dialog menus retain Tab navigation; arrows move between their enabled actions. */
export function moveStudioMenuActionFocus(event: KeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || event.defaultPrevented) return;
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(
    'button:not([disabled]):not([aria-disabled="true"])',
  ));
  if (!rows.length) return;
  const index = rows.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1
    : event.key === "ArrowDown" ? (index + 1) % rows.length : index <= 0 ? rows.length - 1 : index - 1;
  rows[next]?.focus();
  event.preventDefault();
}

const MENU_BASE = "outline-none";
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
      className={composeRenderProps(className, (value) => mergeClassName(STUDIO_MENU_ARIA_ROW_CLASS, value))}
    />
  );
}

/** Menu-row presentation for actions inside a dialog or drill-in panel.
 * Keep button semantics and the owner's focus navigation instead of requiring
 * an ARIA Menu collection for mixed, multi-page content. */
export const StudioMenuAction = forwardRef<HTMLButtonElement, ButtonProps>(function StudioMenuAction({ className, ...props }, ref) {
  return (
    <Button
      type="button"
      {...props}
      ref={ref}
      className={composeRenderProps(className, (value) => mergeClassName(STUDIO_MENU_ARIA_ROW_CLASS, value))}
    />
  );
});

export function StudioMenuSeparator({ className, ...props }: SeparatorProps) {
  return (
    <Separator
      {...props}
      className={mergeClassName(MENU_SEPARATOR_BASE, className)}
    />
  );
}
