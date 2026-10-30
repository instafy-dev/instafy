import type { ConversationSurface } from "./ConversationSurfaceLayout";

/** The longest page title the Browser view tab repeats; the pane shows the rest. */
const PAGE_TITLE_MAX_CHARS = 120;

/**
 * What the conversation's Browser view tab says beyond its name: the tab a
 * message goes to (the chat's own tab, which the pane's own tab picker
 * chooses) as its tooltip and accessible description, and, while an agent
 * uses the browser, a violet dot with "{agent} is using the browser" for
 * screen readers. The chat has no page strip of its own.
 */
export function browserViewTabDetails({ pageTitle, agentName }: {
  pageTitle: string | null;
  /** The agent using the browser now, or null. */
  agentName: string | null;
}): Pick<ConversationSurface, "title" | "description" | "busyLabel"> {
  const page = Array.from((pageTitle ?? "").replace(/\s+/g, " ").trim()).slice(0, PAGE_TITLE_MAX_CHARS).join("");
  const description = page ? `Browser · ${page}` : undefined;
  return {
    title: description ?? "Browser",
    description,
    busyLabel: agentName?.trim() ? `${agentName.trim()} is using the browser` : undefined,
  };
}
