/**
 * A send that claimed a turn engine and that the controller refused before
 * it recorded anything (docs/Local-Engine-Turns.md 2.2, 5.5): no message, run
 * or job exists for it, and the engine words the refusal by its code.
 */
export interface TurnEngineSendRefusal {
  engineId: string;
  code: string;
  /** The engine's sentence, shown in place of the controller's own text. */
  sentence: string;
}

/**
 * What the conversation's submit throws for such a send, once it has taken
 * the unsent message out of the chat, where the engine's sentence now says
 * why. Nothing went out: the composer puts the words back, with the engine
 * still chosen for the next message (useChatSubmitDispatch).
 */
export class TurnEngineSendRefusedError extends Error {
  readonly refusal: TurnEngineSendRefusal;

  constructor(refusal: TurnEngineSendRefusal) {
    super(refusal.sentence);
    this.name = "TurnEngineSendRefusedError";
    this.refusal = refusal;
  }
}

export function isTurnEngineSendRefusedError(error: unknown): error is TurnEngineSendRefusedError {
  return error instanceof TurnEngineSendRefusedError;
}
