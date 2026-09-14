import { describe, expect, it, vi } from "vitest";
import { routeConnectorSelection, type ConnectorRoutingActions } from "../connectorRouting";
import { CONNECTORS, type Connector, type SkillConnector } from "../connectors";

function actions(): ConnectorRoutingActions & Record<keyof ConnectorRoutingActions, ReturnType<typeof vi.fn>> {
  return {
    openConfirm: vi.fn(),
    leaveSheet: vi.fn(),
    openImportModal: vi.fn(),
    beginGithubImport: vi.fn(),
  };
}

function connector(id: string): Connector {
  return CONNECTORS.find((entry) => entry.id === id)!;
}

describe("routeConnectorSelection", () => {
  it("opens the confirm stage for a skill and nothing else", () => {
    const acts = actions();
    const slack = connector("slack") as SkillConnector;
    routeConnectorSelection(slack, acts);

    expect(acts.openConfirm).toHaveBeenCalledTimes(1);
    expect(acts.openConfirm).toHaveBeenCalledWith(slack);
    expect(acts.leaveSheet).not.toHaveBeenCalled();
    expect(acts.openImportModal).not.toHaveBeenCalled();
    expect(acts.beginGithubImport).not.toHaveBeenCalled();
  });

  it("leaves the sheet, then opens the import modal for the paste link", () => {
    const order: string[] = [];
    const acts = actions();
    acts.leaveSheet.mockImplementation(() => order.push("leaveSheet"));
    acts.openImportModal.mockImplementation(() => order.push("openImportModal"));
    routeConnectorSelection(connector("other"), acts);

    expect(order).toEqual(["leaveSheet", "openImportModal"]);
    expect(acts.openConfirm).not.toHaveBeenCalled();
    expect(acts.beginGithubImport).not.toHaveBeenCalled();
  });

  it("leaves the sheet, then starts the GitHub import flow for GitHub", () => {
    const order: string[] = [];
    const acts = actions();
    acts.leaveSheet.mockImplementation(() => order.push("leaveSheet"));
    acts.beginGithubImport.mockImplementation(() => order.push("beginGithubImport"));
    routeConnectorSelection(connector("github"), acts);

    expect(order).toEqual(["leaveSheet", "beginGithubImport"]);
    expect(acts.openConfirm).not.toHaveBeenCalled();
    expect(acts.openImportModal).not.toHaveBeenCalled();
  });

  it("routes every static skill connector to the confirm stage only", () => {
    for (const entry of CONNECTORS.filter((item) => item.kind === "skill")) {
      const acts = actions();
      routeConnectorSelection(entry, acts);
      expect(acts.openConfirm).toHaveBeenCalledWith(entry);
      expect(acts.leaveSheet).not.toHaveBeenCalled();
      expect(acts.openImportModal).not.toHaveBeenCalled();
      expect(acts.beginGithubImport).not.toHaveBeenCalled();
    }
  });
});
