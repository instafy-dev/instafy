import type { ReactNode } from "react";

export const CHAT_COLUMN_CLASS_NAME = "mx-auto w-full max-w-[min(100%,56rem)]";
export const CHAT_COMPOSER_COLUMN_CLASS_NAME = "mx-auto w-full max-w-[min(100%,66rem)]";

export function ChatColumn({ children, className }: { children: ReactNode; className?: string }) {
  const classes = className ? `${CHAT_COLUMN_CLASS_NAME} ${className}` : CHAT_COLUMN_CLASS_NAME;
  return <div className={classes}>{children}</div>;
}
