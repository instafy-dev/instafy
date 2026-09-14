import { isConnectorAvailable, type Connector, type SkillConnector } from "./connectors";

// Where a chip, sheet-row or menu-row press goes. Pure so every branch can be
// asserted without mounting ChatPanel: a skill opens the confirm stage, GitHub
// leaves the sheet for the existing import and device-login flow, and
// "Paste a skill link" leaves it for the import modal. A "soon" connector goes
// nowhere: its controls are disabled, and this guard keeps the confirm stage
// unreachable even if one is reported anyway. No branch sends anything.

export type ConnectorRoutingActions = {
  /** Open the confirm stage for one skill connector. */
  openConfirm: (connector: SkillConnector) => void;
  /** leaveSheet closes the sheet if it is open, before handing off. */
  leaveSheet: () => void;
  openImportModal: () => void;
  /** The getting-started card's GitHub mode (repo import plus device login). */
  beginGithubImport: () => void;
};

export function routeConnectorSelection(connector: Connector, actions: ConnectorRoutingActions): void {
  if (!isConnectorAvailable(connector)) {
    return;
  }
  if (connector.kind === "skill") {
    actions.openConfirm(connector);
    return;
  }
  actions.leaveSheet();
  if (connector.kind === "github") {
    actions.beginGithubImport();
    return;
  }
  actions.openImportModal();
}
