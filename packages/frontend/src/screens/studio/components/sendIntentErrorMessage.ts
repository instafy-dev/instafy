/**
 * Composer status text for a refused Steer or Queue send intent. Unknown codes
 * fall back to the controller's own message, so an older client still shows
 * something readable when a newer controller adds a refusal.
 */
export function describeSendIntentError(code: string | null, fallback: string): string {
  switch (code) {
    case "no_active_job":
      return "That reply finished before the steer arrived. Your message is still in the composer.";
    case "ambiguous_active_job":
      return "More than one matching reply is active. Mention one agent, then try Steer again.";
    case "active_job_conflict":
      return "The active reply changed before the steer arrived. Review the current reply and try again.";
    case "active_turn_input_unavailable":
      return "This agent cannot accept Steer during its current turn. Queue the message instead.";
    case "browser_turn_steer_forbidden":
      return "Only the person who started this browser task can steer it. Queue your message instead.";
    case "send_intent_idempotency_conflict":
      return "This message conflicts with an earlier send attempt. Edit it slightly and try again.";
    default:
      return fallback;
  }
}
