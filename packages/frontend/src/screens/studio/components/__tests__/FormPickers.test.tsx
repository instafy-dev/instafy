// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Field } from "../../../../components/Field";
import { ProviderMenuSelect } from "../ProviderMenuSelect";
import { CredentialMenuSelect } from "../CredentialMenuSelect";
import type { AiProviderId } from "../../../../utils/aiProviderModels";

describe("form picker presentation", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("CSS", { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&") });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  async function choose(label: string) {
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="menuitem"]')]
      .find(node => node.textContent === label)!;
    await act(async () => item.click());
  }

  it("connects a visible provider label and preserves controlled, disabled and selection behavior", async () => {
    const changed = vi.fn();
    function Provider() {
      const [value, setValue] = useState<AiProviderId>("openai");
      return <Field label="Provider" htmlFor="provider" labelId="provider-label">
        <ProviderMenuSelect id="provider" ariaLabel="AI provider" ariaLabelledBy="provider-label" value={value}
          options={[{ id: "openai", label: "OpenAI" }, { id: "deepseek", label: "DeepSeek" }, { id: "gemini", label: "Gemini", disabled: true }]}
          onSelect={next => { changed(next); setValue(next); }} />
      </Field>;
    }
    await act(async () => root.render(<Provider />));
    const trigger = container.querySelector<HTMLButtonElement>("#provider")!;
    expect(trigger.labels?.[0].textContent).toBe("Provider");
    expect(trigger.getAttribute("aria-labelledby")).toBe("provider-label");
    expect(trigger.classList.contains("bg-white")).toBe(true);
    expect(trigger.classList.contains("bg-slate-50")).toBe(false);
    await act(async () => trigger.click());
    await choose("Gemini");
    expect(changed).not.toHaveBeenCalled();
    await choose("DeepSeek");
    expect(changed).toHaveBeenCalledExactlyOnceWith("deepseek");
    expect(trigger.textContent).toBe("DeepSeek");
    expect(document.querySelector('[data-studio-popover]')).toBeNull();
  });

  it("keeps credential connection actions separate from selection and closes the menu", async () => {
    const selected = vi.fn();
    const connect = vi.fn();
    await act(async () => root.render(
      <Field label="Credential" htmlFor="credential" labelId="credential-label">
        <CredentialMenuSelect id="credential" ariaLabel="Credential" ariaLabelledBy="credential-label" value={null}
          credentials={[]} includeAccountDefaultOption onSelect={selected} onConnectNew={connect} />
      </Field>,
    ));
    const trigger = container.querySelector<HTMLButtonElement>("#credential")!;
    expect(trigger.labels?.[0].textContent).toBe("Credential");
    await act(async () => trigger.click());
    await choose("Connect new credential…");
    expect(connect).toHaveBeenCalledOnce();
    expect(selected).not.toHaveBeenCalled();
    expect(document.querySelector('[data-studio-popover]')).toBeNull();
    await act(async () => trigger.click());
    await choose("Use account default");
    expect(selected).toHaveBeenCalledExactlyOnceWith(null);
  });
});
