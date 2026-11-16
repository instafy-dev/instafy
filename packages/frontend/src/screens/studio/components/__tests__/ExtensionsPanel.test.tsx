// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionsPanel } from "../ExtensionsPanel";

const mocks = vi.hoisted(() => ({
  activeProjectId: "space-1" as string | null,
  projectList: [{ id: "space-1", name: "Garden" }],
  hostUnavailable: false,
}));
vi.mock("iconoir-react", async importOriginal => ({
  ...await importOriginal<typeof import("iconoir-react")>(),
  Globe: () => <svg data-testid="icon-globe" />,
  Puzzle: () => <svg data-testid="icon-puzzle" />,
}));
vi.mock("../../../../projects/useProjects", () => ({
  useProjects: () => ({ activeProjectId: mocks.activeProjectId, projectList: mocks.projectList }),
}));
vi.mock("../../../../status/useStatus", () => ({ useStatus: () => ({ showStatus: vi.fn() }) }));
vi.mock("../../../../services/runtimeController/logging", () => ({ isAutomationBrowser: () => false }));
vi.mock("../useExtensionsPanelData", () => ({
  useExtensionsPanelData: () => ({ localProviderHostUnavailableOnThisClient: mocks.hostUnavailable }),
}));
vi.mock("../../../../extensions/useExtensionPanelViewState", () => ({
  useExtensionPanelViewState: () => ({
    uiState: {
      pendingProviderId: null, showDeveloperDetails: false, expandedProviderDetails: {},
      providerEventLogEntries: [], providerTriggerCandidates: [],
    },
    developerDetailsToggleProps: { isSelected: false, onChange: () => undefined },
    sectionActions: {},
  }),
}));
vi.mock("../../../../extensions/extensionPanelSectionContent", () => ({
  buildExtensionPanelSectionViewModel: () => ({}),
  ExtensionPanelSectionContent: () => null,
}));
vi.mock("../SettingsShell", () => ({
  SettingsShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

describe("ExtensionsPanel header", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.activeProjectId = "space-1";
    mocks.hostUnavailable = false;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const section = () => container.querySelector<HTMLElement>('[data-testid="extensions-provider-access-section"]')!;

  it("says what a space can use here, without promising tools", async () => {
    await act(async () => root.render(<ExtensionsPanel />));
    expect(section().textContent).toContain("Let Garden use features of a phone or computer, such as a camera or speech.");
    expect(section().textContent).not.toMatch(/\btools?\b/i);
  });

  it.each([
    { activeProjectId: "space-1", hostUnavailable: false },
    { activeProjectId: "space-1", hostUnavailable: true },
    { activeProjectId: null, hostUnavailable: false },
  ])("shows the globe of the sidebar's Extensions row: %j", async state => {
    Object.assign(mocks, state);
    await act(async () => root.render(<ExtensionsPanel />));
    expect(section().querySelector('[data-testid="icon-globe"]')).not.toBeNull();
    expect(section().querySelector('[data-testid="icon-puzzle"]')).toBeNull();
    expect(section().textContent).not.toMatch(/\btools?\b/i);
  });
});
