import { controllerClient, type ControllerRuntimeStatusEntry } from "../../../sdk/instafy";
import type { ChatMessageFileChangeType } from "../types";

// Undo of a change no save took (a turn's edits a Stop left unsaved, or a
// save that failed): there is no version to revert, so Undo puts the files
// back in the folder the turn ran in, as the saved version has them
// (`/git/revert` on that folder's own origin). It is no message and no turn.

const { fetchStatus: fetchWorkspaceGitStatusFromController } = controllerClient.workspace.git;

/** The most pages of one folder's changes the check reads. */
const MAX_STATUS_PAGES = 10;
const STATUS_PAGE_SIZE = 200;

/**
 * The origin of the folder the space's turns run in on `runtimeId`, while
 * that machine serves it; null when it does not (it is stopped, or has no
 * origin of its own).
 */
export function runtimeFolderOriginId(
  statuses: readonly ControllerRuntimeStatusEntry[] | null | undefined,
  runtimeId: string | null | undefined,
): string | null {
  if (!runtimeId) return null;
  const origin = (statuses ?? []).find((entry) => entry.runtimeId === runtimeId)?.origin;
  const originId = typeof origin?.originId === "string" ? origin.originId.trim() : "";
  return originId && origin?.status !== "released" ? originId : null;
}

/** Paths the folder's origin never puts back: its own metadata and repositories. */
export function isFolderRevertablePath(path: string): boolean {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments[0]?.toLowerCase() === ".instafy") return false;
  return !segments.some((segment) => {
    const lower = segment.toLowerCase();
    return lower === ".git" || lower === ".bind";
  });
}

/** Whether a file's state in the folder (`git status`) still is a change of its kind. */
function holdsChange(code: string, changeType: ChatMessageFileChangeType): boolean {
  const state = code.toUpperCase();
  switch (changeType) {
    case "created":
      return state.includes("?") || state.includes("A");
    case "deleted":
      return state.includes("D");
    default:
      return /[MT]/.test(state) && !state.includes("D");
  }
}

function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : "";
}

/**
 * Whether each of `files` still holds its change in the folder: `held` when
 * every one does, `gone` when one reads as the saved version has it (a later
 * save took the change in, or it was undone already) or changed in another
 * way, `failed` when the folder could not be read.
 */
export async function unsavedChangeStillInFolder({
  projectId,
  originId,
  files,
}: {
  projectId: string;
  originId: string;
  files: ReadonlyArray<{ path: string; changeType: ChatMessageFileChangeType }>;
}): Promise<"held" | "gone" | "failed"> {
  const byFolder = new Map<string, typeof files[number][]>();
  for (const file of files) {
    const folder = parentOf(file.path);
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), file]);
  }
  for (const [folder, inFolder] of byFolder) {
    const codes = new Map<string, string>();
    for (let page = 0; page < MAX_STATUS_PAGES; page += 1) {
      const status = await fetchWorkspaceGitStatusFromController({
        projectId,
        originId,
        scope: folder || null,
        limit: STATUS_PAGE_SIZE,
        offset: page * STATUS_PAGE_SIZE,
        noteVersioningSignals: false,
      }).catch(() => null);
      if (!status || !status.supported || status.busy || status.error) {
        return "failed";
      }
      for (const entry of status.dirtyPaths) {
        codes.set(entry.path.replace(/^\/+/, ""), entry.code);
      }
      if (!status.hasMoreFiles || inFolder.every((file) => codes.has(file.path))) break;
    }
    for (const file of inFolder) {
      const code = codes.get(file.path);
      if (!code || !holdsChange(code, file.changeType)) return "gone";
    }
  }
  return "held";
}
