import { resolveControllerRequestContext, runtimeControllerEnabled } from "./core";

/**
 * Tells the controller the person undid the change `messageId`'s row shows.
 * It records one line in the chat's history, in its own words ("The person
 * undid the change from “…”"): kept out of the transcript, and no turn, so no
 * credit and none of the day's messages. The next turn and its routing step
 * read it, and the chat shows that change as undone after a reload too.
 * Resolves to whether the line is recorded; it never throws.
 */
export async function recordChangeUndone(params: { projectId: string; messageId: string }): Promise<boolean> {
  const projectId = params.projectId.trim();
  const messageId = params.messageId.trim();
  if (!runtimeControllerEnabled || !projectId || !messageId) {
    return false;
  }
  try {
    const context = await resolveControllerRequestContext(null);
    if (!context.accessToken) {
      return false;
    }
    const response = await fetch(
      `${context.baseUrl}/projects/${encodeURIComponent(projectId)}/messages/${encodeURIComponent(messageId)}/undone`,
      { method: "POST", headers: { authorization: `Bearer ${context.accessToken}` } },
    );
    return response.ok;
  } catch {
    return false;
  }
}
