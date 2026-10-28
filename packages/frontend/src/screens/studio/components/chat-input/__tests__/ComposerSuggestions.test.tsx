// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerSuggestionMenu, ComposerSuggestionOption } from "../ComposerSuggestions";

describe("composer suggestion presentation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("preserves the editor's option ref, hover and click selection without submitting the composer", async () => {
    const optionRef = createRef<HTMLButtonElement>();
    const setOptionRef = vi.fn((element: HTMLButtonElement | null) => { optionRef.current = element; });
    const select = vi.fn();
    const highlight = vi.fn();
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
    await act(async () => root.render(
      <form onSubmit={submit}>
        <ComposerSuggestionMenu>
          <ComposerSuggestionOption ref={setOptionRef} label="/goal" description="Set a goal"
            isHighlighted onClick={select} onMouseEnter={highlight} data-command="/goal" />
        </ComposerSuggestionMenu>
      </form>,
    ));

    const option = optionRef.current!;
    expect(option.tagName).toBe("BUTTON");
    expect(option.type).toBe("button");
    expect(option.getAttribute("role")).toBeNull();
    expect(option.dataset.command).toBe("/goal");
    expect(option.dataset.highlighted).toBe("true");
    expect(option.textContent).toBe("/goalSet a goal");
    await act(async () => {
      option.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      option.click();
    });
    expect(highlight).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();

    await act(async () => root.render(null));
    expect(setOptionRef.mock.lastCall?.[0]).toBeNull();
  });

  it("lets the caller update highlights while retaining input focus and native disabled behavior", async () => {
    const choose = vi.fn();
    const render = async (highlighted: boolean, disabled = false) => act(async () => root.render(
      <>
        <input aria-label="Message" />
        <ComposerSuggestionMenu>
          <ComposerSuggestionOption label="@writer" description="Writer" isHighlighted={highlighted}
            start={<span data-testid="face" aria-hidden="true">W</span>} onClick={choose} disabled={disabled} />
        </ComposerSuggestionMenu>
      </>,
    ));
    await render(false);
    const input = container.querySelector("input")!;
    input.focus();
    await render(true);
    expect(document.activeElement).toBe(input);
    const option = container.querySelector("button")!;
    expect(option.dataset.highlighted).toBe("true");
    expect(option.querySelector('[data-testid="face"]')).not.toBeNull();
    await render(false, true);
    await act(async () => option.click());
    expect(choose).not.toHaveBeenCalled();
    expect(option.dataset.highlighted).toBe("false");
  });
});
