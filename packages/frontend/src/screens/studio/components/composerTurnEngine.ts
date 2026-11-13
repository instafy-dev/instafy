import type { ChatSubmitOverride } from "./chatSubmitPlanning";

/**
 * The turn engine a send from the chat panel carries
 * (docs/Local-Engine-Turns.md 5.2): the engine chosen for the next message,
 * only on the composer's own Send of the draft it shows. That is Enter or the
 * send button, also for a restored stash's draft, which the panel sends
 * without an override of the caller's.
 *
 * A caller that passes words of its own in an override (an undo, the goal's
 * help prompt, a selection reply, a dictated voice turn) or sends
 * automatically (Try again, a site's ask, Continue) never carries it, and
 * the choice stays for the composer's next Send. Neither the controller nor
 * the runtime can tell such words from the person's own once they carry a
 * claim, so this is what keeps text Instafy wrote off the engine.
 */
export function composerTurnEngineFor({
  override,
  automatic,
  pendingEngineId,
}: {
  /** The caller's own words, when it passes some; the composer's own Send passes none. */
  override: ChatSubmitOverride | null | undefined;
  automatic: boolean;
  /** The engine chosen for the next message, if any. */
  pendingEngineId: string | null;
}): string | null {
  if (override || automatic) {
    return null;
  }
  return pendingEngineId;
}
