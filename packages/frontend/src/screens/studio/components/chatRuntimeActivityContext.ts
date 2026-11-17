import { createContext } from "react";

// Live runtime activity, provided by ChatPanel. Persisted runtime alerts use
// it to tell when a newer workspace start supersedes them: a 45-minute-old
// "startup failed" card above a live "Starting…" row reads as a
// contradiction, not as history. `workspaceStartingSince` is when the live
// start began; an alert persisted for that same start is not history yet.
// A turn's own line uses it too: before the turn's first step it reads
// "Starting…" only while the space's machine starts, and "Thinking…" otherwise.
// It lives in its own module so the turn line's hook can read it without
// importing ChatMessageEntries, which imports that hook.
export const ChatRuntimeActivityContext = createContext<{
  workspaceStarting: boolean;
  workspaceStartingSince: number | null;
}>({
  workspaceStarting: false,
  workspaceStartingSince: null,
});
