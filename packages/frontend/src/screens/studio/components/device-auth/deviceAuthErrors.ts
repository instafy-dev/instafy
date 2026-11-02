/**
 * Recognize the explicit disabled-login message, including from older
 * controllers. HTTP 403/404 while polling are pending responses, not evidence
 * that an account or workspace has disabled device-code login.
 */
export function isChatGptDeviceCodeLoginDisabledError(error: string | null | undefined): boolean {
  return typeof error === "string" && /device-code login is not enabled/i.test(error);
}
