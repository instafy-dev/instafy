// Whether an available update should interrupt the user right now.
//
// Extracted from the event handler so the rule is testable against built
// output, like the download and progress helpers. It matters more than it
// looks: the check interval was shortened from six hours to thirty minutes,
// and without a decline that sticks, that change turns one polite prompt into
// a nag every thirty minutes forever.

export type UpdatePromptState = {
  phase: string;
  suppressAvailablePrompt: boolean;
  promptInFlight: boolean;
  declinedVersion: string | null;
};

export function shouldPromptForUpdate(version: string, state: UpdatePromptState): boolean {
  // Already downloaded: the ready-to-install prompt owns the conversation.
  if (state.phase === "downloaded") return false;
  // An explicit background check asked not to prompt.
  if (state.suppressAvailablePrompt) return false;
  // A dialog is already on screen.
  if (state.promptInFlight) return false;
  // Declining is a decision about this version, not about this minute.
  if (state.declinedVersion === version) return false;
  return true;
}

// A decline sticks to the version. Accepting clears it so a later failure or
// a fresh version can prompt again.
export function nextDeclinedVersion(
  version: string,
  accepted: boolean,
  previous: string | null,
): string | null {
  if (accepted) return null;
  return version || previous;
}
