import type { ReactNode } from "react";

export const CHAT_COLUMN_CLASS_NAME = "mx-auto w-full max-w-[min(100%,56rem)]";
// One content column: the composer shares the message column's width — a
// 66rem composer under 56rem messages read as misaligned edges.
export const CHAT_COMPOSER_COLUMN_CLASS_NAME = CHAT_COLUMN_CLASS_NAME;

export function ChatColumn({ children, className }: { children: ReactNode; className?: string }) {
  const classes = className ? `${CHAT_COLUMN_CLASS_NAME} ${className}` : CHAT_COLUMN_CLASS_NAME;
  return <div className={classes}>{children}</div>;
}
