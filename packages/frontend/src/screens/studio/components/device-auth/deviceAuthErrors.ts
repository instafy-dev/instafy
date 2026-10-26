/**
 * The controller's answer when OpenAI refuses device-code login for the
 * account or workspace (a 404 when asking for a code, a 403 while polling).
 * A code from that session can never be approved, so it must not be offered.
 */
export function isChatGptDeviceCodeLoginDisabledError(error: string | null | undefined): boolean {
  return typeof error === "string" && /device-code login is not enabled/i.test(error);
}
