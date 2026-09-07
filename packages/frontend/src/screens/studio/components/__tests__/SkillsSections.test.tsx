// @vitest-environment jsdom

import { act, useState, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstalledSkillsSection } from "../InstalledSkillsSection";
import { SkillsDiscoverySection } from "../SkillsDiscoverySection";

const layout = vi.hoisted(() => ({ large: false }));
vi.mock("../../useStudioDesktopLayout", () => ({ useStudioDesktopLayout: () => layout.large }));

type InstalledProps = ComponentProps<typeof InstalledSkillsSection>;
type DiscoveryProps = ComponentProps<typeof SkillsDiscoverySection>;

const skill: InstalledProps["skills"][number] = {
  id: "one", slug: "one", title: "Agent collaboration and permissions", description: "Coordinate work in this space.",
  iconUrl: null, status: "enabled", directoryPath: ".agents/skills/one", filePath: ".agents/skills/one/SKILL.md",
  enabledPath: ".agents/skills/one/SKILL.md", disabledPath: ".agents/skills/one/SKILL.disabled.md",
};
const result: DiscoveryProps["preparedDiscoveryResults"][number] = {
  discovered: {
    id: "discovered", title: "Browser automation", description: "Operate a browser.", lane: "curated",
    provenance: "catalog", isInstallable: true, source: "github", sourceLabel: "GitHub", category: "Automation",
  },
  existingSkill: null, sourceLabel: "GitHub", sourceFaviconUrl: null, faviconKey: "github", showSourceFavicon: false,
};

function installedProps(overrides: Partial<InstalledProps> = {}): InstalledProps {
  return {
    hasProject: true, loading: false, skills: [skill], error: null, bootstrapPending: false,
    brokenSkillIcons: {}, togglePendingSkillId: null, uninstallPendingSkillId: null,
    onReload: vi.fn(), onBootstrapSkills: vi.fn(), onOpenAddSkillModal: vi.fn(), onMarkSkillIconBroken: vi.fn(),
    onToggleSkill: vi.fn(), onUninstallSkill: vi.fn(), onOpenSkillFile: vi.fn(), ...overrides,
  };
}

function discoveryProps(overrides: Partial<DiscoveryProps> = {}): DiscoveryProps {
  return {
    hasProject: true, discoveryQuery: "", onDiscoveryQueryChange: vi.fn(), onDiscoverySearchSubmit: vi.fn(),
    discoveryLaneFilter: "all", onDiscoveryLaneFilterChange: vi.fn(), discoveryCategoryFilter: "all",
    onDiscoveryCategoryFilterChange: vi.fn(), discoverySort: "relevance", onDiscoverySortChange: vi.fn(),
    discoveryLoading: false, discoveryError: null, discoveryWarnings: [], totalDiscoveryCount: 1,
    discoveryLaneCounts: { curated: 1, registry: 0, longTail: 0 },
    discoveryCategoryOptions: [{ name: "Automation", normalizedValue: "automation", count: 1 }],
    preparedDiscoveryResults: [result], importPending: false, togglePendingSkillId: null,
    onMarkDiscoverySourceIconBroken: vi.fn(), onToggleExistingSkill: vi.fn(), onAskExistingSkill: vi.fn(),
    onOpenExistingSkill: vi.fn(), onDiscoveredSkillAction: vi.fn(), ...overrides,
  };
}

describe("Skills responsive controls", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("CSS", { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&") });
    layout.large = false;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(node: ReactNode) {
    await act(async () => root.render(node));
  }
  function query<T extends Element = HTMLElement>(id: string) {
    return document.querySelector<T>(`[data-testid="${id}"]`);
  }
  async function click(id: string) {
    const element = query<HTMLElement>(id);
    expect(element).not.toBeNull();
    await act(async () => element?.click());
  }

  it("keeps direct opening and toggling on mobile while requiring the actions menu for uninstall", async () => {
    const props = installedProps();
    await render(<InstalledSkillsSection {...props} />);
    expect(query("skills-uninstall-one")).toBeNull();
    await click("skills-open-file-one");
    expect(props.onOpenSkillFile).toHaveBeenCalledWith(skill);
    await act(async () => query("skills-toggle-one")?.querySelector<HTMLInputElement>("input")?.click());
    expect(props.onToggleSkill).toHaveBeenCalledWith(skill, false);
    await click("skills-actions-one");
    expect(props.onUninstallSkill).not.toHaveBeenCalled();
    expect(document.querySelector('[role="menu"]')?.getAttribute("aria-label")).toBe(`Actions for ${skill.title}`);
    await click("skills-uninstall-one");
    expect(props.onUninstallSkill).toHaveBeenCalledWith(skill);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("lets Escape dismiss mobile actions without uninstalling", async () => {
    const props = installedProps();
    await render(<InstalledSkillsSection {...props} />);
    await click("skills-actions-one");
    await act(async () => document.querySelector('[role="menu"]')?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(props.onUninstallSkill).not.toHaveBeenCalled();
  });

  it("keeps desktop open and uninstall actions directly available", async () => {
    layout.large = true;
    const props = installedProps();
    await render(<InstalledSkillsSection {...props} />);
    expect(query("skills-actions-one")).toBeNull();
    await click("skills-open-file-one");
    await click("skills-uninstall-one");
    expect(props.onOpenSkillFile).toHaveBeenCalledWith(skill);
    expect(props.onUninstallSkill).toHaveBeenCalledWith(skill);
  });

  it("disables mobile actions while an installed skill is changing", async () => {
    const props = installedProps({ uninstallPendingSkillId: skill.id });
    await render(<InstalledSkillsSection {...props} />);
    expect(query<HTMLButtonElement>("skills-actions-one")?.disabled).toBe(true);
    expect(query<HTMLButtonElement>("skills-open-file-one")?.disabled).toBe(true);
    await click("skills-actions-one");
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("starts mobile discovery with results visible and filters collapsed, preserving search and install actions", async () => {
    const props = discoveryProps();
    await render(<SkillsDiscoverySection {...props} />);
    expect(query("skills-discovery-filters")).toBeNull();
    expect(query("skills-discovery-list")).not.toBeNull();
    expect(query("skills-discovery-filters-toggle")?.getAttribute("aria-expanded")).toBe("false");
    await click("skills-discovery-search");
    await act(async () => query("skills-discovery-query")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(props.onDiscoverySearchSubmit).toHaveBeenCalledTimes(2);
    await click("skills-discovery-install-discovered");
    expect(props.onDiscoveredSkillAction).toHaveBeenCalledWith(result.discovered, null);
  });

  it("retains source, category and sort after the mobile filters close and reopen", async () => {
    function Harness() {
      const [source, setSource] = useState("all");
      const [category, setCategory] = useState("all");
      const [sort, setSort] = useState("relevance");
      return <SkillsDiscoverySection {...discoveryProps({
        discoveryLaneFilter: source, onDiscoveryLaneFilterChange: setSource,
        discoveryCategoryFilter: category, onDiscoveryCategoryFilterChange: setCategory,
        discoverySort: sort, onDiscoverySortChange: setSort,
      })} />;
    }
    await render(<Harness />);
    await click("skills-discovery-filters-toggle");
    for (const [id, value] of [["source", "curated"], ["category", "automation"], ["sort", "name_asc"]]) {
      const select = query<HTMLSelectElement>(`skills-discovery-${id}-select`);
      await act(async () => {
        if (select) select.value = value;
        select?.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
    expect(query("skills-discovery-filters-toggle")?.textContent).toContain("Filters (3)");
    await click("skills-discovery-filters-toggle");
    expect(query("skills-discovery-filters")).toBeNull();
    await click("skills-discovery-filters-toggle");
    expect(query<HTMLSelectElement>("skills-discovery-source-select")?.value).toBe("curated");
    expect(query<HTMLSelectElement>("skills-discovery-category-select")?.value).toBe("automation");
    expect(query<HTMLSelectElement>("skills-discovery-sort-select")?.value).toBe("name_asc");
  });

  it("keeps filters exposed on desktop and preserves disabled loading states", async () => {
    layout.large = true;
    await render(<SkillsDiscoverySection {...discoveryProps({ discoveryLoading: true })} />);
    expect(query("skills-discovery-filters-toggle")).toBeNull();
    expect(query("skills-discovery-filters")).not.toBeNull();
    expect(query<HTMLButtonElement>("skills-discovery-search")?.disabled).toBe(true);
    for (const id of ["source", "category", "sort"]) {
      expect(query<HTMLSelectElement>(`skills-discovery-${id}-select`)?.disabled).toBe(true);
    }
  });
});
