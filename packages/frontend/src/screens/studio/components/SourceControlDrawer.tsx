import { useEffect, useRef } from "react";
import type { GitReviewMode } from "../../../workspace/gitReviewTypes";
import { isHistoryMode, useActiveWorkspaceVersioning } from "../../../workspace/useActiveWorkspaceVersioning";
import { HistoryDrawer } from "./HistoryDrawer";
import { LegacyChangesDrawer } from "./LegacyChangesDrawer";

/**
 * Changes or History, by how the space keeps versions. A cloud space on the
 * stateful gateway (and any space whose mode is not known yet) gets today's
 * Changes drawer, unchanged. Stateless cloud spaces and Desktop spaces get
 * History. Opening the drawer checks the mode again.
 */
export function SourceControlDrawer({
  onRequestClose,
  openRequest,
}: {
  onRequestClose?: () => void;
  openRequest?: {
    key: number;
    previewPath: string | null;
    reviewMode?: GitReviewMode;
  } | null;
  /** Read by the lazy panel's loading frame only. */
  title?: string;
}) {
  const versioning = useActiveWorkspaceVersioning();
  const refreshRef = useRef(versioning.refresh);
  refreshRef.current = versioning.refresh;

  useEffect(() => {
    void refreshRef.current();
  }, []);

  if (isHistoryMode(versioning.chromeMode)) {
    return <HistoryDrawer versioning={versioning} onRequestClose={onRequestClose} />;
  }
  return <LegacyChangesDrawer onRequestClose={onRequestClose} openRequest={openRequest} />;
}
