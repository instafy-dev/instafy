// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResearchBudgetSettings } from "../ResearchBudgetSettings";
import { loadResearchSettings, saveResearchSettings } from "../../../../services/runtimeController/researchSettings";
import { StudioDraftsProvider } from "../../../../workspace/StudioDrafts";

vi.mock("../../../../services/runtimeController/researchSettings", () => ({ loadResearchSettings: vi.fn(), saveResearchSettings: vi.fn() }));
const settings = (total = 12, site = 4, canManage = true) => ({ maxPageLoads: total, maxPageLoadsPerSite: site, canManage,
  limits: { maxPageLoads: { min: 1, max: 200, default: 12 }, maxPageLoadsPerSite: { min: 1, max: 200, default: 4 } },
});

describe("ResearchBudgetSettings", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    vi.mocked(loadResearchSettings).mockResolvedValue(settings());
    vi.mocked(saveResearchSettings).mockResolvedValue(settings(20, 8));
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  const render = async (projectId = "space-a") => { await act(async () => root.render(<StudioDraftsProvider><ResearchBudgetSettings projectId={projectId} /></StudioDraftsProvider>)); };
  const input = (key: string) => container.querySelector<HTMLInputElement>(`[data-testid="research-${key}"]`)!;
  const change = async (key: string, value: string) => { await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(key), value);
    input(key).dispatchEvent(new Event("input", { bubbles: true }));
  }); };
  const submit = async () => { await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); };

  it("loads and saves both limits, then reflects a fresh server value after remount", async () => {
    await render(); expect(input("maxPageLoadsPerSite").value).toBe("4");
    await change("maxPageLoads", "20"); await change("maxPageLoadsPerSite", "8"); await submit();
    expect(saveResearchSettings).toHaveBeenCalledWith("space-a", { maxPageLoads: 20, maxPageLoadsPerSite: 8 });
    expect(container.textContent).toContain("Research budget saved.");
    await render("space-b"); vi.mocked(loadResearchSettings).mockResolvedValueOnce(settings(30, 9)); await render();
    expect(input("maxPageLoads").value).toBe("30");
  });
  it("rejects a per-site limit greater than the task limit and noninteger values", async () => {
    await render();
    for (const value of ["13", "", "0", "2.5", "201"]) { await change("maxPageLoadsPerSite", value); await submit(); }
    expect(saveResearchSettings).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Enter a whole number");
  });
  it("keeps settings read-only for nonmanagers", async () => {
    vi.mocked(loadResearchSettings).mockResolvedValueOnce(settings(20, 8, false)); await render();
    expect(input("maxPageLoads").disabled).toBe(true);
    expect(container.querySelector('[data-testid="research-budget-save"]')).toBeNull();
  });
  it("preserves edits after a failed save and ignores a stale completion after changing spaces", async () => {
    vi.mocked(saveResearchSettings).mockRejectedValueOnce(new Error("Permission changed.")); await render();
    await change("maxPageLoads", "20"); await submit();
    expect(input("maxPageLoads").value).toBe("20");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Permission changed.");
    let complete!: (value: ReturnType<typeof settings>) => void;
    vi.mocked(saveResearchSettings).mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    await submit(); await render("space-b"); await act(async () => complete(settings(20, 8)));
    expect(input("maxPageLoads").value).toBe("12");
    expect(container.textContent).not.toContain("Research budget saved.");
  });
});
