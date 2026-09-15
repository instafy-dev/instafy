// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { SpaceIdentity } from "../../../../components/SpaceIdentity";
import { useWorkspaceStore } from "../../../../store";

const api = vi.hoisted(() => ({ getSummary: vi.fn(), updateIdentity: vi.fn() }));
vi.mock("../../../../sdk/instafy", () => ({ controllerClient: { projects: api } }));
import { SpaceIdentityEditor } from "../SpaceIdentityEditor";
import { StudioRecentSpaces } from "../StudioRecentSpaces";

function SavedSpaceBreadcrumb({ projectId }: { projectId: string }) {
  const metadata = useWorkspaceStore(state => state.projects[projectId]?.metadata);
  return <StudioRecentSpaces presentation="path"
    spaces={[{ id: projectId, name: "Autofix", icon: metadata?.projectIcon, color: metadata?.projectColor }]}
    activeProjectId={projectId} recency={{}} collapsed={false} expanded={false}
    onExpandedChange={() => {}} onSelectSpace={() => {}} onBrowseAll={() => {}} rowClassName="" iconClassName="" />;
}

describe("space identity", () => {
  const initial = useWorkspaceStore.getState();
  const projectId = "11111111-1111-4111-8111-111111111111";
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    useWorkspaceStore.setState(initial, true);
    useWorkspaceStore.getState().createProject({ projectId, projectName: "Autofix" });
    api.getSummary.mockReset().mockResolvedValue({ projectId, projectIcon: "🚀", projectColor: "blue" });
    api.updateIdentity.mockReset().mockImplementation(async (value) => value);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    useWorkspaceStore.setState(initial, true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  const button = (label: string) => [...container.querySelectorAll("button")].find((entry) => entry.getAttribute("aria-label") === label || entry.textContent === label)!;
  async function render(canWrite = true) {
    await act(async () => root.render(<SpaceIdentityEditor projectId={projectId} name="Autofix" canWrite={canWrite} enabled />));
  }
  it("loads saved identity and saves both chosen values through the controller", async () => {
    await render();
    expect(button("Rocket").getAttribute("aria-pressed")).toBe("true");
    await act(async () => button("Seedling").click());
    await act(async () => button("Green color").click());
    expect(useWorkspaceStore.getState().state.metadata.projectIcon).toBe("🚀");
    await act(async () => button("Save appearance").click());
    expect(api.updateIdentity).toHaveBeenCalledWith({ projectId, projectIcon: "🌱", projectColor: "green" });
    expect(useWorkspaceStore.getState().state.metadata.projectIcon).toBe("🌱");
    expect(container.textContent).toContain("Space appearance saved.");
  });
  it("updates the mounted breadcrumb only after appearance is saved, without reloading", async () => {
    await act(async () => root.render(<>
      <SpaceIdentityEditor projectId={projectId} name="Autofix" canWrite enabled />
      <SavedSpaceBreadcrumb projectId={projectId} />
    </>));
    const identity = () => container.querySelector('[data-testid="sidebar-space-button"] [data-testid="space-identity"]')!;
    expect(identity().textContent).toBe("🚀");
    await act(async () => { button("Books").click(); button("Pink color").click(); });
    expect(identity().textContent).toBe("🚀");
    await act(async () => button("Save appearance").click());
    expect(identity().textContent).toBe("📚");
    expect(identity().className).toContain("bg-pink-100");
  });
  it("clears persisted identity explicitly and cancel restores saved choices", async () => {
    await render();
    await act(async () => button("Clear appearance").click());
    await act(async () => button("Cancel").click());
    expect(button("Rocket").getAttribute("aria-pressed")).toBe("true");
    await act(async () => button("Clear appearance").click());
    await act(async () => button("Save appearance").click());
    expect(api.updateIdentity).toHaveBeenCalledWith({ projectId, projectIcon: null, projectColor: null });
    expect(useWorkspaceStore.getState().state.metadata.projectIcon).toBeNull();
  });
  it("preserves saved metadata and the draft after a failed save", async () => {
    api.updateIdentity.mockRejectedValue(new Error("Unable to save appearance."));
    await render();
    await act(async () => button("Seedling").click());
    await act(async () => button("Save appearance").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Unable to save appearance.");
    expect(button("Seedling").getAttribute("aria-pressed")).toBe("true");
    expect(useWorkspaceStore.getState().state.metadata.projectIcon).toBe("🚀");
  });
  it("prevents identity edits for viewers", async () => {
    await render(false);
    expect(button("Seedling").matches(":disabled")).toBe(true);
    expect(button("Save appearance").disabled).toBe(true);
    await act(async () => button("Seedling").click());
    await act(async () => button("Save appearance").click());
    expect(api.updateIdentity).not.toHaveBeenCalled();
  });
  it("blocks edits after a failed read and retries loading the saved identity", async () => {
    api.getSummary.mockResolvedValueOnce(null);
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Unable to load space appearance.");
    expect(button("Seedling").matches(":disabled")).toBe(true);
    await act(async () => button("Retry").click());
    expect(button("Rocket").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
  it("renders initials and a safe palette fallback for missing or invalid data", async () => {
    await act(async () => root.render(<SpaceIdentity name="Autofix" icon="<script>" color="url(https://invalid)" />));
    const identity = container.querySelector('[data-testid="space-identity"]')!;
    expect(identity.textContent).toBe("A");
    expect(identity.className).toContain("bg-slate-100");
    expect(identity.hasAttribute("style")).toBe(false);
  });
});
