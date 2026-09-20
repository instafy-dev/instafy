import { useCallback, useMemo, useState } from "react";
import type { SkillConnector } from "./connectors";

// One sheet instance, two stages. `null` is closed. A confirm stage reached
// from the browse stage remembers that (openedFromBrowse) so Back can return
// to the list; a confirm stage opened straight from a chip or a menu row has
// nowhere to go back to and shows no Back control.

export type ConnectSheetStage = "browse" | "confirm";

export type ConnectSheetState = {
  stage: ConnectSheetStage;
  target: SkillConnector | null;
  openedFromBrowse: boolean;
};

export type ConnectSheetController = {
  state: ConnectSheetState | null;
  openBrowse: () => void;
  openConfirm: (connector: SkillConnector) => void;
  back: () => void;
  close: () => void;
};

export function useConnectSheetState(): ConnectSheetController {
  const [state, setState] = useState<ConnectSheetState | null>(null);

  const openBrowse = useCallback(() => {
    setState({ stage: "browse", target: null, openedFromBrowse: false });
  }, []);

  const openConfirm = useCallback((connector: SkillConnector) => {
    setState((previous) => ({
      stage: "confirm",
      target: connector,
      openedFromBrowse: previous?.stage === "browse",
    }));
  }, []);

  const back = useCallback(() => {
    setState((previous) =>
      previous?.stage === "confirm" && previous.openedFromBrowse
        ? { stage: "browse", target: null, openedFromBrowse: false }
        : null,
    );
  }, []);

  const close = useCallback(() => {
    setState(null);
  }, []);

  return useMemo(
    () => ({ state, openBrowse, openConfirm, back, close }),
    [state, openBrowse, openConfirm, back, close],
  );
}
