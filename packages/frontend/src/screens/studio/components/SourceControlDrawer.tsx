import { useEffect, useRef, useState } from "react";
import type { GitReviewMode } from "../../../workspace/gitReviewTypes";
import { isHistoryMode, useActiveWorkspaceVersioning } from "../../../workspace/useActiveWorkspaceVersioning";
import { HistoryDrawer } from "./HistoryDrawer";
import { focusWasLost } from "./historyFocus";
import { LegacyChangesDrawer } from "./LegacyChangesDrawer";

type DrawerKind = "history" | "changes";

/** Read out by the drawer that replaced the other one while it had keyboard focus. */
export const SOURCE_CONTROL_ARRIVAL_COPY: Record<DrawerKind, string> = {
  history: "This space shows History instead of Changes.",
  changes: "This space shows Changes instead of History.",
};

/**
 * Changes or History, by how the space keeps versions. A cloud space on the
 * stateful gateway (and any space whose mode is not known yet) gets today's
 * Changes drawer, unchanged. Stateless cloud spaces and Desktop spaces get
 * History. Opening the drawer checks the mode again.
 */
export function SourceControlDrawer({
  headerPortalTarget,
  actionsPortalTarget,
  onRequestClose,
  openRequest,
}: {
  headerPortalTarget?: HTMLElement | null;
  actionsPortalTarget?: HTMLElement | null;
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
  const kind: DrawerKind = isHistoryMode(versioning.chromeMode) ? "history" : "changes";
  const kindRef = useRef(kind);
  const lastFocusedRef = useRef<Element | null>(null);
  const [arrival, setArrival] = useState<DrawerKind | null>(null);

  useEffect(() => {
    const track = (event: FocusEvent) => {
      lastFocusedRef.current = event.target instanceof Element ? event.target : null;
    };
    document.addEventListener("focusin", track);
    return () => document.removeEventListener("focusin", track);
  }, []);

  // A probe answered another mode and one drawer replaced the other. When
  // the keyboard was in the drawer that went away, focus fell to the page:
  // the new drawer takes it on its title and says why. Otherwise nothing
  // moves, and a space that is never shown as History never sees this.
  useEffect(() => {
    if (kindRef.current === kind) {
      return;
    }
    kindRef.current = kind;
    const last = lastFocusedRef.current;
    setArrival(focusWasLost() && last !== null && !last.isConnected ? kind : null);
  }, [kind]);

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

  if (kind === "history") {
    const probeFailed = openProbe !== null && !openProbe.answered && openProbe.originId === versioning.originId;
    return (
      <HistoryDrawer
        headerPortalTarget={headerPortalTarget}
        actionsPortalTarget={actionsPortalTarget}
        versioning={versioning}
        onRequestClose={onRequestClose}
        probeFailed={probeFailed}
        arrivalNotice={arrival === "history" ? SOURCE_CONTROL_ARRIVAL_COPY.history : null}
      />
    );
  }
  return (
    <LegacyChangesDrawer
      headerPortalTarget={headerPortalTarget}
      actionsPortalTarget={actionsPortalTarget}
      onRequestClose={onRequestClose}
      openRequest={openRequest}
      arrivalNotice={arrival === "changes" ? SOURCE_CONTROL_ARRIVAL_COPY.changes : null}
    />
  );
}
