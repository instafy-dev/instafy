// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentProfileModal } from "../AgentProfileModal";
import { ModelMenuSelect } from "../ModelMenuSelect";

const onModelChange = vi.fn();
const onClose = vi.fn();
const onSave = vi.fn();
function Editor({ pending = false }: { pending?: boolean }) {
  const [model, setModel] = useState<string | null>(null);
  return <AgentProfileModal isOpen mode="edit" title="Edit bot" pending={pending}
    handle="helper" displayName="Helper" avatarImageUrl=""
    onHandleChange={() => {}} onDisplayNameChange={() => {}} onAvatarImageUrlChange={() => {}}
    description="Keep replies concise." onDescriptionChange={() => {}}
    modelId={model} modelOptions={[{ id: "balanced", label: "Balanced" }, { id: "reasoning", label: "Reasoning" }]}
    onModelChange={(next) => { onModelChange(next); setModel(next); }}
    onClose={onClose} onSave={() => onSave(model)} />;
}

describe("agent model editing on phones", () => {
  let root: Root;
  let container: HTMLDivElement;
  let viewport: EventTarget & { offsetTop: number; offsetLeft: number; width: number; height: number; scale: number };
  let desktop: boolean;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    vi.stubGlobal("CSS", { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&") });
    desktop = false;
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query === "(min-width: 640px)" && desktop,
      media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })));
    viewport = Object.assign(new EventTarget(), { offsetTop: 0, offsetLeft: 0, width: 390, height: 844, scale: 1 });
    vi.stubGlobal("visualViewport", viewport);
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const customInput = () => document.querySelector<HTMLInputElement>('[data-testid="agent-profile-model-select-custom-input"]')!;
  const applyCustom = () => document.querySelector<HTMLButtonElement>('[data-testid="agent-profile-model-select-custom-apply"]')!;
  async function render(pending = false) { await act(async () => root.render(<Editor pending={pending} />)); }
  async function typeCustom(value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(customInput(), value);
      customInput().dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function choose(label: string, role = "option") {
    await act(async () => [...document.querySelectorAll<HTMLElement>(`[role="${role}"]`)]
      .find((item) => item.textContent === label)!.click());
  }

  it("keeps known, default and custom model choices in one phone dialog until explicit Save", async () => {
    await render();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.querySelector('[role="dialog"]')!.parentElement!.style.width).toBe("390px");
    expect(document.querySelector('[data-studio-popover]')).toBeNull();
    await choose("Reasoning");
    expect(onModelChange).toHaveBeenLastCalledWith("reasoning");
    expect(document.querySelector('[role="option"][aria-selected="true"]')?.textContent).toBe("Reasoning");
    await choose("Default (recommended)");
    expect(onModelChange).toHaveBeenLastCalledWith(null);
    await typeCustom("  team/custom-model  ");
    await act(async () => applyCustom().click());
    expect(onModelChange).toHaveBeenLastCalledWith("team/custom-model");
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[data-studio-popover]')).toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="agent-profile-save"]')!.click());
    expect(onSave).toHaveBeenCalledExactlyOnceWith("team/custom-model");
  });

  it("preserves the custom draft, focused element and cursor when the keyboard shrinks the viewport", async () => {
    await render();
    await typeCustom("another-model");
    const input = customInput();
    await act(async () => { input.focus(); input.setSelectionRange(3, 6); });
    await act(async () => {
      viewport.height = 310; viewport.offsetTop = 20;
      viewport.dispatchEvent(new Event("resize"));
      await new Promise(requestAnimationFrame);
    });
    expect(customInput()).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("another-model");
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, 6]);
    expect(document.querySelector('[role="dialog"]')!.parentElement!.style.height).toBe("310px");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })));
    expect(onModelChange).not.toHaveBeenCalled();
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(onModelChange).toHaveBeenCalledExactlyOnceWith("another-model");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("blocks model changes and dismissal while saving", async () => {
    await render();
    await typeCustom("team/model");
    await render(true);
    expect(customInput().disabled).toBe(true);
    expect(applyCustom().disabled).toBe(true);
    expect([...document.querySelectorAll('[role="option"]')].every((item) => item.getAttribute("aria-disabled") === "true")).toBe(true);
    const close = document.querySelector<HTMLButtonElement>('[aria-label="Close"]')!;
    expect(close.disabled).toBe(true);
    await choose("Balanced");
    await act(async () => {
      applyCustom().click(); close.click();
      customInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onModelChange).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it.each([false, true])("supports custom selections without catalog models (default option: %s)", async (includeDefaultOption) => {
    await act(async () => root.render(<ModelMenuSelect presentation="inline" options={[]} value="private-model"
      includeDefaultOption={includeDefaultOption} ariaLabel="Choose model" onSelect={onModelChange}
      triggerTestId="agent-profile-model-select" />));
    expect(customInput().value).toBe("private-model");
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(includeDefaultOption ? 1 : 0);
    expect(document.querySelector('[role="option"][aria-selected="true"]')).toBeNull();
    await typeCustom("  replacement  ");
    await act(async () => applyCustom().click());
    expect(onModelChange).toHaveBeenCalledExactlyOnceWith("replacement");
  });

  it("keeps the existing desktop model menu even inside a narrow parent", async () => {
    desktop = true;
    container.style.width = "320px";
    await render();
    expect(customInput()).toBeNull();
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')!.parentElement!.style.width).toBe("");
    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="agent-profile-model-select"]')!;
    await act(async () => trigger.click());
    expect(document.querySelector('[data-studio-popover]')).not.toBeNull();
    await typeCustom("  desktop-model  ");
    await act(async () => applyCustom().click());
    expect(onModelChange).toHaveBeenCalledExactlyOnceWith("desktop-model");
    expect(document.querySelector('[data-studio-popover]')).toBeNull();
    expect(trigger.textContent).toContain("desktop-model");
    expect(onSave).not.toHaveBeenCalled();
  });
});
