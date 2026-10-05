// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  projectId: "desk-project" as string | null,
  runtime: {
    desktopOrigin: null as { originId: string; mode: string; endpoint: string } | null,
    desktopOriginProjectId: null as string | null | undefined,
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

import { resetWorkspaceVersioningProbesForTests } from "../../services/runtimeController/workspaceVersioning";
import { resetWorkspaceVersioningCacheForTests } from "../../services/runtimeController/workspaceVersioningCache";
import {
  useActiveWorkspaceVersioning,
  useWorkspaceVersioningForProject,
  type ActiveWorkspaceVersioning,
} from "../useActiveWorkspaceVersioning";

let latest: ActiveWorkspaceVersioning | null = null;

function Probe() {
  latest = useActiveWorkspaceVersioning();
  return null;
}

function ProjectProbe({ projectId }: { projectId: string | null }) {
  latest = useWorkspaceVersioningForProject({ projectId });
  return null;
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
  });
}

const DESK = { originId: "desk-origin", mode: "desktop", endpoint: "http://desk" };

describe("useActiveWorkspaceVersioning across a project switch", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetWorkspaceVersioningCacheForTests();
    resetWorkspaceVersioningProbesForTests();
    window.localStorage.clear();
    mocks.status.mockReset();
    mocks.status.mockRejectedValue(new TypeError("Failed to fetch"));
    latest = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(projectId: string, origin: typeof DESK | null, originProjectId: string | null | undefined) {
    mocks.projectId = projectId;
    mocks.runtime = { desktopOrigin: origin, desktopOriginProjectId: originProjectId };
    await act(async () => root.render(<Probe />));
    await flush();
  }

  it("ignores the previous project's origin for the commit after a switch", async () => {
    await render("desk-project", DESK, "desk-project");
    expect(latest?.chromeMode).toBe("desktop");
    expect(window.localStorage.getItem("instafy.versioning.mode.desk-project")).toBe("desktop");

    // The project changed; the store still holds the Desktop summary.
    await render("cloud-project", DESK, "desk-project");
    expect(latest?.originId).toBeNull();
    expect(latest?.chromeMode).toBe("legacy");
    expect(latest?.historyReady).toBe(false);
    expect(window.localStorage.getItem("instafy.versioning.mode.cloud-project")).toBeNull();
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it("guards a surface that is handed its project the same way", async () => {
    // The active project does not matter here: the card names its own.
    mocks.projectId = null;
    mocks.runtime = { desktopOrigin: DESK, desktopOriginProjectId: "desk-project" };
    await act(async () => root.render(<ProjectProbe projectId=" cloud-project " />));
    await flush();
    expect(latest?.projectId).toBe("cloud-project");
    expect(latest?.originId).toBeNull();
    expect(latest?.chromeMode).toBe("legacy");
    expect(window.localStorage.getItem("instafy.versioning.mode.cloud-project")).toBeNull();
    expect(mocks.status).not.toHaveBeenCalled();

    await act(async () => root.render(<ProjectProbe projectId="desk-project" />));
    await flush();
    expect(latest?.originId).toBe("desk-origin");
    expect(latest?.chromeMode).toBe("desktop");
  });

  it("keeps a summary whose project is unknown", async () => {
    await render("desk-project", DESK, undefined);
    expect(latest?.originId).toBe("desk-origin");
    expect(latest?.chromeMode).toBe("desktop");
  });
});
