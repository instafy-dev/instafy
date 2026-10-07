// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SegmentedControl } from "../SegmentedControl";

describe("SegmentedControl", () => {
  let root: Root;
  let container: HTMLDivElement;
  const changed = vi.fn();
  function Harness({ disabled = false, visibleLabel = true }: { disabled?: boolean; visibleLabel?: boolean }) {
    const [value, setValue] = useState("log");
    return <><button>Before choices</button><SegmentedControl
      label={visibleLabel ? "Activity view" : undefined}
      aria-label={visibleLabel ? undefined : "Activity view"}
      value={value} onChange={next => { changed(next); setValue(next); }} isDisabled={disabled}
      options={[{ value: "log", label: "Log", testId: "activity-log" }, { value: "graph", label: "Graph", testId: "activity-graph" }]} />
      <button>After choices</button></>;
  }
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    changed.mockReset();
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  const option = (value: string) => container.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)!;
  it("exposes one labelled group and one selected radio while keeping the existing option test IDs", async () => {
    await act(async () => root.render(<Harness />));
    const group = container.querySelector('[role="radiogroup"]')!;
    const label = document.getElementById(group.getAttribute("aria-labelledby")!);
    expect(label?.textContent).toBe("Activity view");
    expect(option("log").checked).toBe(true);
    expect(option("graph").checked).toBe(false);
    expect(option("log").tabIndex).toBe(0);
    expect(option("graph").tabIndex).toBe(-1);
    await act(async () => container.querySelector<HTMLLabelElement>('[data-testid="activity-graph"]')!.click());
    expect(option("graph").checked).toBe(true);
    expect(option("log").checked).toBe(false);
    expect(changed).toHaveBeenCalledExactlyOnceWith("graph");
  });
  it("uses arrow keys to select and focus the adjacent choice, including wraparound", async () => {
    await act(async () => root.render(<Harness visibleLabel={false} />));
    expect(container.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe("Activity view");
    await act(async () => option("log").focus());
    await act(async () => option("log").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(option("graph"));
    expect(option("graph").checked).toBe(true);
    await act(async () => option("graph").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(option("log"));
    expect(option("log").checked).toBe(true);
  });
  it("does not change a disabled group's choice", async () => {
    await act(async () => root.render(<Harness disabled />));
    expect(option("graph").disabled).toBe(true);
    await act(async () => container.querySelector<HTMLLabelElement>('[data-testid="activity-graph"]')!.click());
    expect(changed).not.toHaveBeenCalled();
    expect(option("log").checked).toBe(true);
  });
});
