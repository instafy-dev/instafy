import { useCallback, useEffect } from "react";
import type { OpenBrowserPause } from "./useShowBrowserOnRequest";

/**
 * The chat's ways back to a pause in Instafy's browser that still waits for
 * the person (openBrowserPause): the press in the row under it, and the
 * chat's Browser tab, which the pause keeps while it waits, also on a device
 * with no view saved for the chat. Both open Instafy's browser, where the
 * pause is. Desktop opens its own browser for a chat with no view saved, and
 * that one has no page, no outlines and no pause. A tab for a view this
 * device already has opens that view as it is. Nothing here sends Octo
 * anything: the page may be gone, and the person lets Octo continue from the
 * Browser view once they are done there.
 */
export function useBrowserPauseTab({
  pause,
  hasView,
  viewStateHydrated,
  viewClosed,
  browserPicked,
  revealInstafyBrowser,
  selectView,
}: {
  /** The pause that still waits for this person, if any. */
  pause: OpenBrowserPause | null;
  /** This device has a view for the chat, open or hidden. */
  hasView: boolean;
  /** This device's record of the chat's view has been read. */
  viewStateHydrated: boolean;
  /** The person closed the chat's view on this device. */
  viewClosed: boolean;
  /**
   * Browser is the chat's selected view while no view is open, as the
   * conversation's view bar leaves it when the person picks the tab there.
   */
  browserPicked: boolean;
  /** Brings Instafy's browser forward in the view, over this device's own. */
  revealInstafyBrowser: () => void;
  /** Selects one of the chat's views; Browser also opens the view when it is not open. */
  selectView: (id: string) => void;
}): {
  /** The pause keeps the chat's Browser tab while no view is open. */
  offersTab: boolean;
  /** The row's press. */
  open: () => void;
  /** A pick in the chat's own tabs. */
  select: (id: string) => void;
} {
  // A view the person closed here stays closed, or its close would do
  // nothing: the row leads back then.
  const offersTab = pause !== null && !hasView && viewStateHydrated && !viewClosed;
  const open = useCallback(() => {
    revealInstafyBrowser();
    selectView("browser");
  }, [revealInstafyBrowser, selectView]);
  const select = useCallback((id: string) => {
    if (id === "browser" && offersTab) open();
    else selectView(id);
  }, [offersTab, open, selectView]);
  useEffect(() => {
    if (browserPicked && offersTab) open();
  }, [browserPicked, offersTab, open]);
  return { offersTab, open, select };
}
