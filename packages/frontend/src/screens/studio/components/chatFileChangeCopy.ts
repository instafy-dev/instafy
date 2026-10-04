import type { ChatMessageFileNotSaved } from "../types";

// Copy for the chat change card's save state. Work that did not reach the
// space's saved history is kept on an unsaved-work ref. Only a space whose
// History lists Unsaved work can point there; elsewhere the copy says the
// work is kept without naming a place the UI does not show.
export interface UnsavedWorkPlacement {
  unsavedWorkInHistory: boolean;
}

function keptAs({ unsavedWorkInHistory }: UnsavedWorkPlacement): string {
  return unsavedWorkInHistory ? "kept under History, in Unsaved work" : "kept as unsaved work";
}

// The message-level note when the turn's save failed or did not run. Every
// turn saves, so the next turn picks up what this one left behind.
export function describeUnsavedChanges(placement: UnsavedWorkPlacement): string {
  return `These changes weren't saved to the space yet. The agent saves them at its next turn, and anything left over is ${keptAs(placement)}.`;
}

// Why one file of the turn was left out of the saved history.
export function describeFileNotSaved(notSaved: ChatMessageFileNotSaved, placement: UnsavedWorkPlacement): string {
  if (notSaved.reason === "conflicted") {
    return `Changed in the space while the agent worked. The agent's version is ${keptAs(placement)}.`;
  }
  const reason = (() => {
    switch (notSaved.reason) {
      case "excluded":
        return "Build output, dependency and cache folders aren't saved to the space.";
      case "secret":
        return "Secret files stay out of the space. Use Secrets for these values.";
      case "ignored":
        return "This file matches .gitignore, so it isn't saved to the space.";
      case "too_large":
        return "Larger than 20 MB, so it isn't saved to the space.";
      case "attachment":
        return "Old chat upload files aren't saved to the space.";
      case "policy":
        return "This space's file rules refused this file.";
      case "unsupported":
        return "Links and special files can't be saved.";
      default:
        return "The space didn't save this file.";
    }
  })();
  return notSaved.keptSavedVersion ? `${reason} The saved version is unchanged.` : reason;
}
