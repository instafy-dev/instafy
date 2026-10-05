// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeFile } from "../../types";

type Summary = { originId: string; mode: string; endpoint: string };

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  projectId: "desk-project" as string | null,
  files: [] as CodeFile[],
  runtime: {
    desktopOrigin: null as Summary | null,
    desktopOriginProjectId: null as string | null,
  },
}));

vi.mock("../../services/runtimeController/workspaceGit", () => ({
  fetchWorkspaceGitStatusFromController: mocks.status,
}));
vi.mock("../../projects/useProject", () => ({
  useProject: () => ({ activeProjectId: mocks.projectId }),
}));
vi.mock("../../runtime/useRuntime", () => ({
  useRuntime: () => mocks.runtime,
}));
vi.mock("../../code/useCode", () => ({
  useCode: () => ({ workspace: { files: mocks.files } }),
}));

import { resetWorkspaceVersioningProbesForTests } from "../../services/runtimeController/workspaceVersioning";
import { resetWorkspaceVersioningCacheForTests } from "../../services/runtimeController/workspaceVersioningCache";
import { StudioDraftsProvider, useStudioDraftSnapshot } from "../StudioDrafts";
import { StudioFileBufferDrafts } from "../StudioFileBufferDrafts";

const DESK: Summary = { originId: "desk-origin", mode: "desktop", endpoint: "http://desk" };
const EDITED: CodeFile = { id: "README.md", path: "README.md", label: "README.md", generated: "saved", modified: "edited" };
const modeKey = (projectId: string) => `instafy.versioning.mode.${projectId}`;

let draftKeys: string[] = [];

function DraftKeys() {
  draftKeys = useStudioDraftSnapshot().drafts.map((draft) => draft.key);
  return null;
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
  });
}

describe("StudioFileBufferDrafts across a project switch", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetWorkspaceVersioningCacheForTests();
    resetWorkspaceVersioningProbesForTests();
    window.localStorage.clear();
    mocks.status.mockReset();
    mocks.status.mockRejectedValue(new TypeError("Failed to fetch"));
    mocks.files = [EDITED];
    draftKeys = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(projectId: string, origin: Summary | null, originProjectId: string | null) {
    mocks.projectId = projectId;
    mocks.runtime = { desktopOrigin: origin, desktopOriginProjectId: originProjectId };
    await act(async () =>
      root.render(
        <StudioDraftsProvider>
          <StudioFileBufferDrafts />
          <DraftKeys />
        </StudioDraftsProvider>,
      ),
    );
    await flush();
  }

  it("never remembers desktop for a cloud space opened after a Desktop space", async () => {
    await render("desk-project", DESK, "desk-project");
    expect(window.localStorage.getItem(modeKey("desk-project"))).toBe("desktop");
    expect(draftKeys).toEqual(["files:desk-project:README.md"]);

    // The project changed; the store still holds the Desktop summary.
    await render("cloud-project", DESK, "desk-project");
    expect(window.localStorage.getItem(modeKey("cloud-project"))).toBeNull();
    // Legacy until the cloud space's own origin answers: no Files draft.
    expect(draftKeys).toEqual([]);
    expect(mocks.status).not.toHaveBeenCalled();
  });
});
