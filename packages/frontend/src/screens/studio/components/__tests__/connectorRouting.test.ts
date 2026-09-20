import { describe, expect, it, vi, type Mock } from "vitest";
import { routeConnectorSelection, type ConnectorRoutingActions } from "../connectorRouting";
import { CONNECTORS, isConnectorAvailable, type Connector, type SkillConnector } from "../connectors";

function actions(): ConnectorRoutingActions & Record<keyof ConnectorRoutingActions, Mock> {
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

// Notion is the shipped skill whose pack is published; Slack stays "soon",
// so its available form is a fixture.
const notion = connector("notion") as SkillConnector;
const availableSlack: SkillConnector = {
  ...(connector("slack") as SkillConnector),
  availability: "available",
};

describe("routeConnectorSelection", () => {
  it("opens the confirm stage for the shipped available skill and nothing else", () => {
    expect(notion.availability).toBe("available");
    const acts = actions();
    routeConnectorSelection(notion, acts);

    expect(acts.openConfirm).toHaveBeenCalledTimes(1);
    expect(acts.openConfirm).toHaveBeenCalledWith(notion);
    expect(acts.leaveSheet).not.toHaveBeenCalled();
    expect(acts.openImportModal).not.toHaveBeenCalled();
    expect(acts.beginGithubImport).not.toHaveBeenCalled();
  });

  it("opens the confirm stage for an available skill fixture and nothing else", () => {
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
    expect(soon.map((item) => item.id)).toEqual(["slack", "discord"]);
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
