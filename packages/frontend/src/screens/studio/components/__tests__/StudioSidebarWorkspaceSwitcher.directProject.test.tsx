// @vitest-environment jsdom

import { act, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MergedProjectListItem } from "../../../../projects/useMergedControllerProjects";
import {
  StudioSidebarWorkspaceSwitcher,
  type SidebarWorkspaceOrgOption,
} from "../StudioSidebarWorkspaceSwitcher";

const personalProject: MergedProjectListItem = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Untitled Space",
  orgId: null,
  orgName: "Personal",
  state: null,
  isRemoteOnly: false,
};

const directlySharedProject: MergedProjectListItem = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Directly shared space",
  orgId: "33333333-3333-4333-8333-333333333333",
  orgName: "External team",
  state: null,
  isRemoteOnly: true,
};

const orgOptions: SidebarWorkspaceOrgOption[] = [
  {
    key: "personal",
    name: "Personal",
    label: "Personal",
    slug: null,
    count: 1,
  },
  {
    key: directlySharedProject.orgId!,
    name: directlySharedProject.orgName,
    label: directlySharedProject.orgName,
    slug: null,
    count: 1,
  },
];

function Harness({ onProjectAction }: { onProjectAction: (key: string | number) => void }) {
  const [orgKey, setOrgKey] = useState("personal");
  const projects = useMemo(
    () =>
      [personalProject, directlySharedProject].filter(
        (project) => (project.orgId ?? "personal") === orgKey,
      ),
    [orgKey],
  );

  return (
    <StudioSidebarWorkspaceSwitcher
      orgOptions={orgOptions}
      workspaceOrgKey={orgKey}
      onWorkspaceOrgChange={setOrgKey}
      canSearchSpaces={false}
      showProjectSearch={false}
      workspaceProjectSearchOpen={false}
      workspaceProjectQuery=""
      onWorkspaceProjectQueryChange={vi.fn()}
      onToggleProjectSearch={vi.fn()}
      currentOrgProject={null}
      switcherProjects={projects}
      onProjectMenuAction={onProjectAction}
    />
  );
}

describe("StudioSidebarWorkspaceSwitcher direct project memberships", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("lets a project-only guest reveal and select the shared space", async () => {
    const onProjectAction = vi.fn();
    await act(async () => {
      root.render(<Harness onProjectAction={onProjectAction} />);
    });

    expect(container.textContent).not.toContain(directlySharedProject.name);

    const externalTeam = container.querySelector<HTMLButtonElement>(
      `[data-testid="sidebar-org-chip-${directlySharedProject.orgId}"]`,
    );
    expect(externalTeam).not.toBeNull();

    await act(async () => {
      externalTeam?.click();
    });

    const sharedSpace = container.querySelector<HTMLElement>(
      `[data-testid="sidebar-project-switcher-item-${directlySharedProject.id}"]`,
    );
    expect(sharedSpace?.textContent).toContain(directlySharedProject.name);

    await act(async () => {
      sharedSpace?.click();
    });

    expect(onProjectAction).toHaveBeenCalledWith(`project:${directlySharedProject.id}`);
  });
});
