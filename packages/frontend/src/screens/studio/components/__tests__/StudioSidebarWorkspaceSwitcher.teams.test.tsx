// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  StudioSidebarWorkspaceSwitcher,
  type SidebarWorkspaceOrgOption,
} from "../StudioSidebarWorkspaceSwitcher";

const teams: SidebarWorkspaceOrgOption[] = [
  { key: "personal", name: "Personal", label: "Personal", slug: null, count: 2 },
  { key: "acme", name: "Acme Co", label: "Acme Co", slug: "acme", count: 5 },
  { key: "fp", name: "Fairplanen", label: "Fairplanen", slug: "fp", count: 1, avatarUrl: "https://example.test/fp.png" },
];

function render(root: Root, props: Partial<ComponentProps<typeof StudioSidebarWorkspaceSwitcher>> = {}) {
  return act(async () => {
    root.render(
      <StudioSidebarWorkspaceSwitcher
        orgOptions={teams}
        workspaceOrgKey="acme"
        onWorkspaceOrgChange={() => {}}
        canSearchSpaces={false}
        showProjectSearch={false}
        workspaceProjectSearchOpen={false}
        workspaceProjectQuery=""
        onWorkspaceProjectQueryChange={() => {}}
        onToggleProjectSearch={() => {}}
        currentOrgProject={null}
        switcherProjects={[]}
        onProjectMenuAction={() => {}}
        orgAttentionCounts={{ personal: 2, fp: 1 }}
        {...props}
      />,
    );
  });
}

describe("StudioSidebarWorkspaceSwitcher team rows", () => {
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
  });

  it("lists every team by name, with the selected one marked current", async () => {
    await render(root);

    // textContent joins the tile, name, tag and badge spans with no separator.
    const rows = Array.from(container.querySelectorAll('[data-testid^="sidebar-org-chip-"]'));
    expect(rows.map((row) => row.textContent)).toEqual([
      "PPersonal2",
      "ACAcme CoCurrent",
      "Fairplanen1",
    ]);
    const selected = container.querySelector('[data-testid="sidebar-org-chip-acme"]');
    expect(selected?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[data-testid="sidebar-org-chip-personal"]')?.getAttribute("aria-pressed")).toBe("false");
    // The avatar team renders an image tile instead of initials.
    expect(container.querySelector('[data-testid="sidebar-org-chip-fp"] img')?.getAttribute("src")).toBe(
      "https://example.test/fp.png",
    );
  });

  it("switches teams from a row and rolls attention up onto the all-teams row", async () => {
    const onWorkspaceOrgChange = vi.fn();
    await render(root, {
      onWorkspaceOrgChange,
      orgOptions: [{ key: "all", name: "All", label: "All", slug: null, count: 8 }, ...teams],
    });

    const all = container.querySelector('[data-testid="sidebar-org-chip-all"]');
    expect(all?.textContent).toBe("AllAll teams3");

    await act(async () => {
      (container.querySelector('[data-testid="sidebar-org-chip-personal"]') as HTMLButtonElement).click();
    });
    expect(onWorkspaceOrgChange).toHaveBeenCalledWith("personal");
  });

  it("offers a New team action beside team settings when creation is wired", async () => {
    const onCreateOrg = vi.fn();
    await render(root, { onCreateOrg });

    const create = container.querySelector('[data-testid="sidebar-org-new"]') as HTMLButtonElement | null;
    expect(create?.getAttribute("aria-label")).toBe("New team");
    await act(async () => {
      create?.click();
    });
    expect(onCreateOrg).toHaveBeenCalledTimes(1);

    // Without a creation handler the door simply isn't drawn.
    await render(root, { onCreateOrg: undefined });
    expect(container.querySelector('[data-testid="sidebar-org-new"]')).toBeNull();
  });

  it("still names the team when there is only one", async () => {
    await render(root, { orgOptions: [teams[0]], workspaceOrgKey: "personal", orgAttentionCounts: {} });

    const rows = container.querySelectorAll('[data-testid^="sidebar-org-chip-"]');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toBe("PPersonalCurrent");
  });
});
