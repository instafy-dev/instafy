// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  StudioSidebarWorkspaceSwitcher,
  type SidebarWorkspaceOrgOption,
} from "../StudioSidebarWorkspaceSwitcher";
import { studioPerformance, type StudioPerformanceSample } from "../../../../telemetry/studioPerformance";

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
    studioPerformance.clear();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    studioPerformance.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

  it("keeps Current on the active team while a requested team is waiting or failed", async () => {
    const onRetryProjects = vi.fn();
    await render(root, {
      workspaceOrgKey: "fp", activeOrgKey: "acme", pendingOrgKey: "fp",
    });
    const current = container.querySelector('[data-testid="sidebar-org-chip-acme"]');
    const requested = container.querySelector('[data-testid="sidebar-org-chip-fp"]');
    expect(current?.textContent).toContain("Current");
    expect(requested?.textContent).toContain("Switching…");
    expect(requested?.getAttribute("aria-busy")).toBe("true");

    await render(root, {
      workspaceOrgKey: "fp", activeOrgKey: "acme", pendingOrgKey: "fp",
      projectsError: "Couldn't load spaces.", onRetryProjects,
    });
    expect(current?.textContent).toContain("Current");
    expect(requested?.textContent).toContain("Selected");
    expect(requested?.textContent).not.toContain("Current");
    expect(requested?.hasAttribute("aria-busy")).toBe(false);
    expect(container.querySelector('[data-testid="sidebar-project-discovery-error"]')?.textContent)
      .toContain("Couldn't load spaces.");
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="sidebar-project-discovery-retry"]')?.click();
    });
    expect(onRetryProjects).toHaveBeenCalledTimes(1);

    await render(root, {
      workspaceOrgKey: "fp", activeOrgKey: "acme", pendingOrgKey: "fp",
      projectsError: "Couldn't load spaces.", projectsRefreshing: true, onRetryProjects,
    });
    expect(container.querySelector<HTMLButtonElement>('[data-testid="sidebar-project-discovery-retry"]')?.disabled).toBe(true);
    expect(container.textContent).toContain("Retrying…");
    await render(root, { workspaceOrgKey: "fp", activeOrgKey: "fp" });
    expect(requested?.textContent).toContain("Current");
    expect(container.querySelector('[data-testid="sidebar-project-discovery-error"]')).toBeNull();
  });

  it("observes consecutive failed discovery attempts without completing while Retry is running", async () => {
    let nextFrame = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (frame: number) => { frames.delete(frame); });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const paint = async () => {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(async () => { callbacks.forEach((callback) => callback(performance.now())); });
    };
    const samples: StudioPerformanceSample[] = [];
    const stop = studioPerformance.subscribe((sample) => samples.push(sample));
    const pending = { workspaceOrgKey: "fp", activeOrgKey: "acme", pendingOrgKey: "fp" };
    const onRetryProjects = () => studioPerformance.begin("organization_switch", { organizationId: "fp" });
    try {
      studioPerformance.begin("organization_switch", { organizationId: "fp" });
      await render(root, { ...pending, projectsRefreshing: true });
      await paint();
      await paint();
      expect(samples).toEqual([]);
      await render(root, { ...pending, projectsError: "Couldn't load spaces.", onRetryProjects });
      await paint();
      await paint();
      expect(samples).toMatchObject([{ operation: "organization_switch", outcome: "error", loadingShown: true }]);
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="sidebar-project-discovery-retry"]')?.click();
      });
      await render(root, { ...pending, projectsError: "Couldn't load spaces.", projectsRefreshing: true, onRetryProjects });
      await paint();
      await paint();
      expect(samples).toHaveLength(1);
      await render(root, { ...pending, projectsError: "Couldn't load spaces.", projectsRefreshing: false, onRetryProjects });
      await paint();
      await paint();
      expect(samples).toMatchObject([
        { operation: "organization_switch", outcome: "error", loadingShown: true },
        { operation: "organization_switch", outcome: "error", loadingShown: true },
      ]);
    } finally {
      stop();
    }
  });
});
