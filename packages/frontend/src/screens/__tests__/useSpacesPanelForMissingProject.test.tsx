// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useSpacesPanelForMissingProject,
  type SpacesPanelForMissingProjectInput,
} from "../useSpacesPanelForMissingProject";

const DELETED = "11111111-1111-4111-8111-111111111111";
const OTHER_DELETED = "22222222-2222-4222-8222-222222222222";
const OPEN = "33333333-3333-4333-8333-333333333333";

function Probe(input: SpacesPanelForMissingProjectInput) {
  useSpacesPanelForMissingProject(input);
  return null;
}

describe("useSpacesPanelForMissingProject", () => {
  let container: HTMLDivElement;
  let root: Root;
  const openPanelTab = vi.fn();

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    openPanelTab.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const render = async (input: Partial<SpacesPanelForMissingProjectInput>) => {
    await act(async () => {
      root.render(
        <Probe
          activeProjectId=""
          routedProjectId={DELETED}
          controllerProjectMissing
          projectReadyForWorkspace
          openPanelTab={openPanelTab}
          {...input}
        />,
      );
    });
  };

  // A space deleted in another tab leaves no space open while the URL still
  // names it. Its chat stayed the active tab: its header and chat tabs above
  // the notice, and no Home, Chat and Spaces dock on a phone.
  it("opens Spaces for the space the URL names when no space is open", async () => {
    await render({});

    expect(openPanelTab).toHaveBeenCalledTimes(1);
    expect(openPanelTab).toHaveBeenCalledWith("projects");
  });

  it("opens Spaces once per missing space, and again for another one", async () => {
    await render({});
    await render({ projectReadyForWorkspace: true });
    expect(openPanelTab).toHaveBeenCalledTimes(1);

    await render({ routedProjectId: OTHER_DELETED });
    expect(openPanelTab).toHaveBeenCalledTimes(2);
  });

  it("keys a missing open space on that space", async () => {
    await render({ activeProjectId: OPEN, routedProjectId: OPEN });
    expect(openPanelTab).toHaveBeenCalledTimes(1);
    await render({ activeProjectId: OPEN, routedProjectId: null });
    expect(openPanelTab).toHaveBeenCalledTimes(1);
  });

  it("leaves the tabs alone while the space is there, loading, or nothing is named", async () => {
    await render({ controllerProjectMissing: false });
    await render({ controllerProjectMissing: true, projectReadyForWorkspace: false });
    await render({ routedProjectId: null });
    expect(openPanelTab).not.toHaveBeenCalled();
  });
});
