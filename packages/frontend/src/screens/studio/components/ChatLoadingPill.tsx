import type { ReactNode } from "react";
import { Spinner } from "../../../components/Spinner";

/** The chat column's loading pill: a chat's first page of messages, or a
 * space's chats before one can open, so the two waits read as one. */
export function ChatLoadingPill({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-center px-2 py-1" role="status">
      <div className="inline-flex items-center gap-3 rounded-2xl border border-slate-200/70 bg-white/85 px-4 py-3 text-sm font-medium text-slate-600 shadow-sm dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-panel-soft)] dark:text-slate-300">
        <Spinner aria-hidden="true" tone="slate" size="sm" />
        <span>{children}</span>
      </div>
    </div>
  );
}
