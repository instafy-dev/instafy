import {
  ListBox,
  ListBoxItem,
  composeRenderProps,
  type ListBoxProps,
  type ListBoxItemProps,
} from "react-aria-components";

const LIST_BOX_BASE = "outline-none";
const LIST_BOX_ITEM_BASE =
  "flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-sm text-slate-600 transition data-[hovered]:bg-slate-100 data-[focused]:bg-slate-100 data-[selected]:text-slate-900 data-[selected]:font-medium data-[disabled]:opacity-50 dark:text-slate-300 dark:data-[hovered]:bg-[var(--color-studio-dark-control-hover)] dark:data-[focused]:bg-[var(--color-studio-dark-control-hover)] dark:data-[selected]:text-slate-50";

function mergeClassName(base: string, extra?: string) {
  if (!extra) {
    return base;
  }
  return `${base} ${extra}`;
}

export function StudioListBox<T extends object>({ className, ...props }: ListBoxProps<T>) {
  return (
    <ListBox
      {...props}
      className={composeRenderProps(className, (value) => mergeClassName(LIST_BOX_BASE, value))}
    />
  );
}

export function StudioListBoxItem<T extends object>({ className, ...props }: ListBoxItemProps<T>) {
  return (
    <ListBoxItem
      {...props}
      className={composeRenderProps(className, (value) => mergeClassName(LIST_BOX_ITEM_BASE, value))}
    />
  );
}
