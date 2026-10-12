// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillsImportModal } from "../SkillsImportModal";

const layout = vi.hoisted(() => ({ desktop: true }));
vi.mock("../../../../hooks/useBreakpoint", () => ({ useBreakpoint: () => layout.desktop }));
const submit = vi.fn();

function Editor({ workspaceUnavailable }: { workspaceUnavailable: boolean }) {
  const [source, setSource] = useState(".agents/skills/draft");
  const [name, setName] = useState("My draft");
  const [overwrite, setOverwrite] = useState(true);
  return <SkillsImportModal isOpen onOpenChange={() => {}} importPending={false}
    hasProject workspaceUnavailable={workspaceUnavailable}
    importSource={source} onImportSourceChange={setSource}
    importName={name} onImportNameChange={setName}
    importOverwrite={overwrite} onImportOverwriteChange={setOverwrite}
    onSubmitImport={() => submit({ source, name, overwrite })} />;
}

describe("skill import during workspace recovery", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    vi.stubGlobal("CSS", { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&") });
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })));
    vi.stubGlobal("visualViewport", Object.assign(new EventTarget(), { offsetTop: 0, offsetLeft: 0, width: 390, height: 844, scale: 1 }));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it.each([true, false])("keeps an open editor's draft and blocks submission until recovery (desktop: %s)", async (desktop) => {
    layout.desktop = desktop;
    const render = async (workspaceUnavailable: boolean) => {
      await act(async () => root.render(<Editor workspaceUnavailable={workspaceUnavailable} />));
    };
    const button = () => document.querySelector<HTMLButtonElement>('[data-testid="skills-import-submit"]')!;
    const source = () => document.querySelector<HTMLInputElement>('[data-testid="skills-import-source"]')!;
    await render(false);
    expect(button().disabled).toBe(false);
    const originalInput = source();

    await render(true);
    expect(button().disabled).toBe(true);
    expect(document.querySelector('[role="status"]')?.textContent).toContain("Your draft is kept");
    await act(async () => button().click());
    expect(submit).not.toHaveBeenCalled();
    expect(source()).toBe(originalInput);
    expect(source().disabled).toBe(false);
    expect(source().value).toBe(".agents/skills/draft");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(source(), ".agents/skills/refined-draft");
      source().dispatchEvent(new Event("input", { bubbles: true }));
    });

    await render(false);
    expect(button().disabled).toBe(false);
    expect(source()).toBe(originalInput);
    expect(source().value).toBe(".agents/skills/refined-draft");
    expect(document.querySelector('[role="status"]')).toBeNull();
    await act(async () => button().click());
    expect(submit).toHaveBeenCalledExactlyOnceWith({ source: ".agents/skills/refined-draft", name: "My draft", overwrite: true });
  });
});
