import { useEffect, useRef, useState } from "react";
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
  const originIdRef = useRef(versioning.originId);
  originIdRef.current = versioning.originId;
  // Whether the probe made on opening got an answer, for the origin it asked.
  const [openProbe, setOpenProbe] = useState<{ originId: string | null; answered: boolean } | null>(null);

  useEffect(() => {
    let active = true;
    const originId = originIdRef.current;
    void refreshRef.current().then((result) => {
      if (active) {
        setOpenProbe({ originId, answered: result !== null });
      }
    });
    return () => {
      active = false;
    };
  }, []);

  if (isHistoryMode(versioning.chromeMode)) {
    const probeFailed = openProbe !== null && !openProbe.answered && openProbe.originId === versioning.originId;
    return <HistoryDrawer versioning={versioning} onRequestClose={onRequestClose} probeFailed={probeFailed} />;
  }
  return <LegacyChangesDrawer onRequestClose={onRequestClose} openRequest={openRequest} />;
}
