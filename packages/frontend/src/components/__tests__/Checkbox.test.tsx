// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Checkbox } from "../Checkbox";

describe("Checkbox interaction target", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it.each([true, false])("activates once through the larger label while preserving its compact native input (visible label: %s)", async (visibleLabel) => {
    const changed = vi.fn();
    function Example() {
      const [selected, setSelected] = useState(false);
      return <Checkbox label={visibleLabel ? "Include files" : undefined} aria-label={visibleLabel ? undefined : "Include files"}
        isSelected={selected} onChange={next => { changed(next); setSelected(next); }} />;
    }
    await act(async () => root.render(<Example />));
    const input = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const target = input.labels![0];
    expect(input.tabIndex).toBe(0);
    expect(input.classList.contains("h-4")).toBe(true);
    expect(input.classList.contains("w-4")).toBe(true);
    expect(target.classList.contains("min-h-11")).toBe(true);
    expect(target.classList.contains("min-w-11")).toBe(true);
    expect(target.classList.contains("sm:pointer-fine:min-h-0")).toBe(true);
    await act(async () => target.click());
    expect(changed).toHaveBeenCalledExactlyOnceWith(true);
    expect(input.checked).toBe(true);
    await act(async () => { input.focus(); input.click(); });
    expect(document.activeElement).toBe(input);
    expect(changed.mock.calls).toEqual([[true], [false]]);
  });

  it("keeps disabled and indeterminate semantics on the native checkbox", async () => {
    const changed = vi.fn();
    await act(async () => root.render(<Checkbox label="Select files" isDisabled isIndeterminate onChange={changed} />));
    const input = container.querySelector<HTMLInputElement>("input")!;
    expect(input.disabled).toBe(true);
    expect(input.indeterminate).toBe(true);
    await act(async () => input.labels![0].click());
    expect(changed).not.toHaveBeenCalled();
    expect(input.checked).toBe(false);
  });
});
