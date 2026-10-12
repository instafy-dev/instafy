// @vitest-environment jsdom

import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstalledSkillsSection } from "../InstalledSkillsSection";

const layout = vi.hoisted(() => ({ large: false }));
vi.mock("../../useStudioDesktopLayout", () => ({ useStudioDesktopLayout: () => layout.large }));

type InstalledProps = ComponentProps<typeof InstalledSkillsSection>;

const skill: InstalledProps["skills"][number] = {
  id: "one", slug: "one", title: "Agent collaboration and permissions", description: "Coordinate work in this space.",
  iconUrl: null, status: "enabled", directoryPath: ".agents/skills/one", filePath: ".agents/skills/one/SKILL.md",
  enabledPath: ".agents/skills/one/SKILL.md", disabledPath: ".agents/skills/one/SKILL.disabled.md",
};
function installedProps(overrides: Partial<InstalledProps> = {}): InstalledProps {
  return {
    hasProject: true, loading: false, skills: [skill], error: null, bootstrapPending: false,
    brokenSkillIcons: {}, togglePendingSkillId: null, uninstallPendingSkillId: null,
    onReload: vi.fn(), onBootstrapSkills: vi.fn(), onConnectTool: vi.fn(), onOpenAddSkillModal: vi.fn(), onMarkSkillIconBroken: vi.fn(),
    onToggleSkill: vi.fn(), onUninstallSkill: vi.fn(), onOpenSkillFile: vi.fn(), ...overrides,
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

  it("keeps restore progress visible after the actions menu closes", async () => {
    await render(<InstalledSkillsSection {...installedProps({ skills: [], bootstrapPending: true })} />);
    expect(container.textContent).toContain("Restoring defaults…");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await click("skills-actions");
    expect(query("skills-bootstrap")?.getAttribute("aria-disabled")).toBe("true");
  });

  it("announces refresh progress while keeping the existing list usable", async () => {
    const props = installedProps({ loading: true });
    await render(<InstalledSkillsSection {...props} />);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Refreshing skills…");
    await click("skills-open-file-one");
    expect(props.onOpenSkillFile).toHaveBeenCalledWith(skill);
    await click("skills-actions");
    expect(query("skills-refresh")?.getAttribute("aria-disabled")).toBe("true");
  });

});
