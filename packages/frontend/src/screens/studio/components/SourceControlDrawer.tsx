import { useEffect, useRef, useState } from "react";
import { useActiveWorkspaceVersioning } from "../../../workspace/useActiveWorkspaceVersioning";
import { HistoryDrawer } from "./HistoryDrawer";

/**
 * The History drawer for the active space. Opening it checks how the space
 * keeps versions again; History waits for that answer before it sends
 * requests.
 */
export function SourceControlDrawer({
  headerPortalTarget,
  actionsPortalTarget,
  onRequestClose,
}: {
  headerPortalTarget?: HTMLElement | null;
  actionsPortalTarget?: HTMLElement | null;
  onRequestClose?: () => void;
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

  // A probe asked before the space's origin loaded asked nothing: History
  // waits for the origin, and the probe that comes with it.
  const probeFailed = openProbe !== null && openProbe.originId !== null && !openProbe.answered &&
    openProbe.originId === versioning.originId;
  return (
    <HistoryDrawer
      headerPortalTarget={headerPortalTarget}
      actionsPortalTarget={actionsPortalTarget}
      versioning={versioning}
      onRequestClose={onRequestClose}
      probeFailed={probeFailed}
    />
  );
}
