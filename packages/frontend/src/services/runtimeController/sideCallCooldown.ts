import {
  controllerRequestContextUserId,
  type ControllerApiErrorPayload,
  type ControllerRequestContext,
} from "./core";

/**
 * Side calls that ask a person's saved AI connection for something outside
 * any job. The controller counts each kind per person and refuses one over its
 * limit with a 429 that says how long until a slot frees.
 */
export type SideCall = "editor_completion" | "conversation_title";

const REFUSAL_CODES: Record<SideCall, string> = {
  editor_completion: "editor_completion_rate_limited",
  conversation_title: "conversation_title_rate_limited",
};

/** Used when a refusal does not say how long to wait: the shortest window. */
const DEFAULT_WAIT_SECONDS = 60;
/** The longest window the controller counts. */
const MAX_WAIT_SECONDS = 60 * 60;

type Cooldown = { until: number; message: string };

const cooldowns = new Map<string, Cooldown>();

function cooldownKey(call: SideCall, context: ControllerRequestContext): string {
  return JSON.stringify([call, context.baseUrl, controllerRequestContextUserId(context)]);
}

/**
 * The refusal still in force for this person and kind of call, or null. While
 * one is, asking again would only be refused, so callers show nothing instead.
 */
export function sideCallCooldown(
  call: SideCall,
  context: ControllerRequestContext,
  now: number = Date.now(),
): string | null {
  const key = cooldownKey(call, context);
  const cooldown = cooldowns.get(key);
  if (!cooldown) {
    return null;
  }
  // A wait longer than the longest window means the clock moved back since
  // the refusal; asking again costs at most one more refusal.
  if (cooldown.until <= now || cooldown.until - now > MAX_WAIT_SECONDS * 1000) {
    cooldowns.delete(key);
    return null;
  }
  return cooldown.message;
}

/**
 * Remembers a refusal of this kind of call until the controller said a slot
 * frees. Other failures are not remembered: the next pause asks again.
 */
export function noteSideCallRefusal(
  call: SideCall,
  context: ControllerRequestContext,
  error: ControllerApiErrorPayload,
  now: number = Date.now(),
): void {
  if (error.status !== 429 || error.code !== REFUSAL_CODES[call]) {
    return;
  }
  const details =
    error.details && typeof error.details === "object"
      ? (error.details as Record<string, unknown>)
      : null;
  const retryAfter = details?.retryAfterSeconds;
  const waitSeconds =
    typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(Math.ceil(retryAfter), MAX_WAIT_SECONDS)
      : DEFAULT_WAIT_SECONDS;
  cooldowns.set(cooldownKey(call, context), {
    until: now + waitSeconds * 1000,
    message: error.message,
  });
}

export function resetSideCallCooldownsForTests(): void {
  cooldowns.clear();
}
