import { describe, expect, it, vi } from "vitest";
import { routeConnectorSelection, type ConnectorRoutingActions } from "../connectorRouting";
import { CONNECTORS, isConnectorAvailable, type Connector, type SkillConnector } from "../connectors";

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

// Every shipped skill is "soon" today; an available skill is a fixture.
const availableSlack: SkillConnector = {
  ...(connector("slack") as SkillConnector),
  availability: "available",
};

describe("routeConnectorSelection", () => {
  it("opens the confirm stage for an available skill and nothing else", () => {
    const acts = actions();
    const slack = availableSlack;
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

  it("does nothing for a soon connector, so the confirm stage stays unreachable", () => {
    const soon = CONNECTORS.filter((item) => !isConnectorAvailable(item));
    expect(soon.map((item) => item.id)).toEqual(["slack", "notion", "discord", "freefinance"]);
    for (const entry of soon) {
      const acts = actions();
      routeConnectorSelection(entry, acts);
      expect(acts.openConfirm).not.toHaveBeenCalled();
      expect(acts.leaveSheet).not.toHaveBeenCalled();
      expect(acts.openImportModal).not.toHaveBeenCalled();
      expect(acts.beginGithubImport).not.toHaveBeenCalled();
    }
  });

  it("routes every static skill connector to the confirm stage only once it is available", () => {
    for (const entry of CONNECTORS.filter((item): item is SkillConnector => item.kind === "skill")) {
      const acts = actions();
      const available: SkillConnector = { ...entry, availability: "available" };
      routeConnectorSelection(available, acts);
      expect(acts.openConfirm).toHaveBeenCalledWith(available);
      expect(acts.leaveSheet).not.toHaveBeenCalled();
      expect(acts.openImportModal).not.toHaveBeenCalled();
      expect(acts.beginGithubImport).not.toHaveBeenCalled();
    }
  });
});
