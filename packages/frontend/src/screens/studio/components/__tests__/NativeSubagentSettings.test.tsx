// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeSubagentSettings } from "../NativeSubagentSettings";
import { loadNativeSubagentSettings, saveNativeSubagentSettings } from "../../../../services/runtimeController/nativeSubagentSettings";

vi.mock("../../../../services/runtimeController/nativeSubagentSettings", () => ({
  loadNativeSubagentSettings: vi.fn(), saveNativeSubagentSettings: vi.fn(),
}));
const settings = (maxNativeSubagents = 3, canManage = true) => ({
  maxNativeSubagents, canManage, limits: { maxNativeSubagents: { min: 1, max: 64, default: 3 } },
});

describe("NativeSubagentSettings", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    vi.mocked(loadNativeSubagentSettings).mockResolvedValue(settings());
    vi.mocked(saveNativeSubagentSettings).mockResolvedValue(settings(10));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  const render = async (projectId = "space-a") => { await act(async () => root.render(<NativeSubagentSettings projectId={projectId} />)); };
  const input = () => container.querySelector<HTMLInputElement>("input")!;
  const change = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const submit = async () => { await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); };

  it("loads the controller value and saves ten helpers without changing team limits", async () => {
    await render();
    expect(input().value).toBe("3");
    await change("10");
    await submit();
    expect(saveNativeSubagentSettings).toHaveBeenCalledWith("space-a", 10);
    expect(input().value).toBe("10");
    expect(container.textContent).toContain("Helper limit saved.");
  });

  it("blocks empty, fractional and out-of-range drafts", async () => {
    await render();
    for (const value of ["", "0", "65", "2.5"]) {
      await change(value);
      await submit();
    }
    expect(saveNativeSubagentSettings).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Enter a whole number from 1 to 64.");
  });

  it("keeps member settings read-only and handles an older controller", async () => {
    vi.mocked(loadNativeSubagentSettings).mockResolvedValueOnce(settings(10, false));
    await render();
    expect(input().disabled).toBe(true);
    expect(container.querySelector('[data-testid="native-subagent-save"]')).toBeNull();
    vi.mocked(loadNativeSubagentSettings).mockResolvedValueOnce({ canManage: true, limits: {} });
    await render("old-space");
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).toContain("does not support configuring native helpers");
  });

  it("retains the draft after a failed save", async () => {
    vi.mocked(saveNativeSubagentSettings).mockRejectedValueOnce(new Error("Permission changed."));
    await render();
    await change("10");
    await submit();
    expect(input().value).toBe("10");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Permission changed.");
    expect(container.textContent).not.toContain("Helper limit saved.");
  });

  it("ignores a completed save after switching spaces", async () => {
    let complete!: (value: ReturnType<typeof settings>) => void;
    vi.mocked(saveNativeSubagentSettings).mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    await render();
    await change("10");
    await submit();
    vi.mocked(loadNativeSubagentSettings).mockResolvedValueOnce(settings(6));
    await render("space-b");
    await act(async () => complete(settings(10)));
    expect(input().value).toBe("6");
    expect(container.textContent).not.toContain("Helper limit saved.");
  });
});
