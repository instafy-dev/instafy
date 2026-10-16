/**
 * The spaces this tab deleted, or is deleting. That tab moves to another
 * space by itself, so the controller's notice of the deletion and its own
 * access checks must not block the space as well: the picker would flash and
 * the tab would navigate twice. Kept per tab on purpose, since every other tab
 * learns of the deletion the usual way. A delete that fails clears its mark.
 */
const projectsDeletedHere = new Set<string>();

export function markProjectDeletedHere(projectId: string): void {
  projectsDeletedHere.add(projectId);
}

export function unmarkProjectDeletedHere(projectId: string): void {
  projectsDeletedHere.delete(projectId);
}

export function isProjectDeletedHere(projectId: string): boolean {
  return projectsDeletedHere.has(projectId);
}
