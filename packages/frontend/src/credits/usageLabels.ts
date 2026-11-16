export const LIVE_ACCESS_SINGULAR = "Live access";
export const LIVE_ACCESS_PLURAL = "Live access";
export const LIVE_CONNECTIONS_PLURAL = "live connections";
export const LIVE_CONNECTION_SINGULAR = "live connection";
export const HOSTED_MACHINES_PLURAL = "hosted machines";
export const HOSTED_MACHINE_SINGULAR = "hosted machine";

/**
 * Credits pay only for Instafy AI turns. A turn on the person's own
 * credential (a ChatGPT login, an API key, Codex on this computer) is
 * `byoc`: dispatch takes no reserve for it (dispatch.rs `uses_managed_ai`)
 * and its completion charges no usage (agent.rs `reconcile_completion_usage`
 * reads `managedAiUsed`). docs/Credits-Billing.md: those are paid by the user.
 */
export const OWN_AI_CONNECTION_CREDITS_LINE =
  "Messages answered by your own AI connection use that account, not credits.";
