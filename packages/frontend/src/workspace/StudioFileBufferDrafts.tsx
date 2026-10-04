import { useEffect } from "react";
import { useCode } from "../code/useCode";
import { useProject } from "../projects/useProject";
import { useRuntime } from "../runtime/useRuntime";
import { isFileBufferDirty, isVersionedFilesMode } from "../screens/studio/components/filesVersioning";
import type { CodeFile } from "../types";
import { FILE_BUFFER_DRAFT_PREFIX, isFileBufferDraftKey, useStudioDraftStore } from "./StudioDrafts";
import { useWorkspaceVersioning } from "./useWorkspaceVersioning";

/**
 * Register unsaved Files buffers as Studio drafts (one per file), so leaving
 * Studio or closing the tab warns while switching panels does not. Buffers
 * stay on this device either way; the warning is a reminder to save. Only the
 * versioned modes register them: legacy Files keeps today's behaviour.
 */
export function useFileBufferDrafts({
  projectId,
  files,
  enabled,
}: {
  projectId: string | null;
  files: CodeFile[];
  enabled: boolean;
}) {
  const store = useStudioDraftStore();
  useEffect(() => {
    if (!store) {
      return;
    }
    const wanted = new Set<string>();
    if (enabled && projectId) {
      for (const file of files) {
        if (isFileBufferDirty(file)) {
          wanted.add(`${FILE_BUFFER_DRAFT_PREFIX}${projectId}:${file.path}`);
        }
      }
    }
    for (const draft of store.getSnapshot().drafts) {
      if (isFileBufferDraftKey(draft.key) && !wanted.has(draft.key)) {
        store.remove(draft.key);
      }
    }
    // The guard only needs to know which files are unsaved, so the draft
    // holds constants: typing does not republish the draft store.
    for (const key of wanted) {
      store.set({ key, panel: "code", value: "unsaved", base: "saved" });
    }
  }, [enabled, files, projectId, store]);

  useEffect(
    () => () => {
      if (!store) {
        return;
      }
      for (const draft of store.getSnapshot().drafts) {
        if (isFileBufferDraftKey(draft.key)) {
          store.remove(draft.key);
        }
      }
    },
    [store],
  );
}

/** Mounted once inside the Studio drafts provider. */
export function StudioFileBufferDrafts() {
  const { workspace } = useCode();
  const { activeProjectId } = useProject();
  const { desktopOrigin } = useRuntime();
  const versioning = useWorkspaceVersioning({ projectId: activeProjectId, origin: desktopOrigin });
  useFileBufferDrafts({
    projectId: activeProjectId ?? null,
    files: workspace.files,
    enabled: isVersionedFilesMode({ mode: versioning.mode, originId: versioning.originId }),
  });
  return null;
}
