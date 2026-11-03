import { resolveControllerRequestContext, runtimeControllerEnabled } from "./core";

/** How long to wait before each try again, after a try that never reached the controller or failed there. */
const RECORD_RETRY_DELAYS_MS = [1_000, 3_000];

/**
 * Tells the controller the person undid the change `messageId`'s row shows,
 * naming the files the Undo put back or removed (`paths`). It records one
 * line in the chat's history, in its own words ("The person undid the change
 * from “…”"): kept out of the transcript, and no turn, so no credit and none
 * of the day's messages. The next turn and its routing step read it, and the
 * chat shows those files as undone after a reload too.
 *
 * The Undo already happened, so a try that never reached the controller, or
 * that failed there, is made again a moment later; a refusal is not. Resolves
 * to whether the line is recorded; it never throws.
 */
export async function recordChangeUndone(
  params: { projectId: string; messageId: string; paths: readonly string[] },
  options: { retryDelaysMs?: readonly number[] } = {},
): Promise<boolean> {
  const projectId = params.projectId.trim();
  const messageId = params.messageId.trim();
  const paths = params.paths.map((path) => path.trim()).filter((path) => path.length > 0);
  if (!runtimeControllerEnabled || !projectId || !messageId || paths.length === 0) {
    return false;
  }
  const delays = options.retryDelaysMs ?? RECORD_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt += 1) {
    let retry = true;
    try {
      const context = await resolveControllerRequestContext(null);
      if (!context.accessToken) {
        return false;
      }
      const response = await fetch(
        `${context.baseUrl}/projects/${encodeURIComponent(projectId)}/messages/${encodeURIComponent(messageId)}/undone`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${context.accessToken}`, "content-type": "application/json" },
          body: JSON.stringify({ paths }),
        },
      );
      if (response.ok) {
        return true;
      }
      // A refusal (no access, not a change, not its files) stays a refusal.
      retry = response.status >= 500 || response.status === 429;
    } catch {
      retry = true;
    }
    const delay = delays[attempt];
    if (!retry || delay === undefined) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
