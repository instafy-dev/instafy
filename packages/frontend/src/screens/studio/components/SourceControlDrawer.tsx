import { useEffect, useRef, useState } from "react";
import { readLastVersioningMode } from "../../../services/runtimeController/workspaceVersioning";
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
  const [arrival, setArrival] = useState<{ kind: DrawerKind; explained: boolean } | null>(null);
  // The Changes on screen is this space's own: a probe answered legacy, or
  // this device last saw the space in Changes. In a new space Changes only
  // stands in while the mode is checked, so History does not replace it.
  const changesWereShownRef = useRef(false);

  useEffect(() => {
    const track = (event: FocusEvent) => {
      lastFocusedRef.current = event.target instanceof Element ? event.target : null;
    };
    document.addEventListener("focusin", track);
    return () => document.removeEventListener("focusin", track);
  }, []);

  useEffect(() => {
    if (kind === "changes") {
      changesWereShownRef.current =
        versioning.resolved || readLastVersioningMode(versioning.projectId) === "legacy";
    }
  }, [kind, versioning.projectId, versioning.resolved]);

  // A probe answered another mode and one drawer replaced the other. When
  // the keyboard was in the drawer that went away, focus fell to the page:
  // the new drawer takes it on its title and says why (History only where
  // the space showed Changes before). Otherwise nothing moves, and a space
  // that is never shown as History never sees this.
  useEffect(() => {
    if (kindRef.current === kind) {
      return;
    }
    kindRef.current = kind;
    const last = lastFocusedRef.current;
    const lost = focusWasLost() && last !== null && !last.isConnected;
    setArrival(lost ? { kind, explained: kind === "changes" || changesWereShownRef.current } : null);
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
        arrived={arrival?.kind === "history"}
        arrivalNotice={arrival?.kind === "history" && arrival.explained ? SOURCE_CONTROL_ARRIVAL_COPY.history : null}
      />
    );
  }
  return (
    <LegacyChangesDrawer
      headerPortalTarget={headerPortalTarget}
      actionsPortalTarget={actionsPortalTarget}
      onRequestClose={onRequestClose}
      openRequest={openRequest}
      arrivalNotice={arrival?.kind === "changes" ? SOURCE_CONTROL_ARRIVAL_COPY.changes : null}
    />
  );
}
