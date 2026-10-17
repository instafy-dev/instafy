/**
 * A space-scoped read the controller answered with 404. The Studio's access
 * check listens and looks the space up again at once, also in a hidden tab,
 * which otherwise never checks: a space deleted elsewhere is then blocked
 * there, and the chat backfill, the runtime status retries and the event
 * stream, which all wait on access, stop instead of repeating the 404.
 */
export const CONTROLLER_PROJECT_NOT_FOUND_EVENT = "instafy:controller-project-not-found";

export interface ControllerProjectNotFoundDetail {
  projectId: string;
}

export function reportControllerProjectNotFound(projectId: string): void {
  if (typeof window === "undefined" || !projectId) {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<ControllerProjectNotFoundDetail>(CONTROLLER_PROJECT_NOT_FOUND_EVENT, {
      detail: { projectId },
    }),
  );
}
