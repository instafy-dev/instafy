// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Field } from "../Field";
import { Input } from "../Input";
import { Select } from "../Select";

describe("shared form controls", () => {
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

  it("gives native and styled selects the same default sizing as an adjacent Input", async () => {
    await act(async () => root.render(<>
      <Input aria-label="Name" data-testid="name" />
      <Select aria-label="Role" data-testid="role"><option value="viewer">Viewer</option></Select>
      <Select native aria-label="Native role" data-testid="native-role"><option value="viewer">Viewer</option></Select>
      <Select size="xs" aria-label="Compact role" data-testid="compact-role"><option value="viewer">Viewer</option></Select>
    </>));
    for (const id of ["name", "role", "native-role"]) {
      const control = container.querySelector(`[data-testid="${id}"]`)!;
      for (const rule of ["min-h-11", "sm:pointer-fine:min-h-[38px]", "px-3", "py-2", "text-base", "sm:text-sm", "rounded-xl"]) {
        expect(control.classList.contains(rule), `${id}: ${rule}`).toBe(true);
      }
    }
    const compact = container.querySelector('[data-testid="compact-role"]')!;
    expect(compact.classList.contains("py-1")).toBe(true);
    expect(compact.classList.contains("sm:pointer-fine:min-h-[38px]")).toBe(false);
  });

  it("keeps the styled select labelled and controlled when a user chooses an option", async () => {
    const changed = vi.fn();
    function Form() {
      const [role, setRole] = useState("viewer");
      return <Field label="Access" htmlFor="access">
        <Select id="access" value={role} onChange={event => {
          changed(event.target.value); setRole(event.target.value);
        }}>
          <option value="viewer">Read-only</option>
          <option value="builder">Read and write</option>
          <option value="admin" disabled>Administrator</option>
        </Select>
      </Field>;
    }
    await act(async () => root.render(<Form />));
    const trigger = container.querySelector<HTMLButtonElement>("#access")!;
    expect(trigger.labels?.[0].textContent).toBe("Access");
    const labelId = trigger.labels![0].id;
    expect(labelId).not.toBe("");
    expect(trigger.getAttribute("aria-labelledby")?.split(" ")).toContain(labelId);
    await act(async () => trigger.click());
    const disabledOption = document.querySelector<HTMLElement>('[role="option"][data-value="admin"]')!;
    expect(disabledOption.getAttribute("aria-disabled")).toBe("true");
    await act(async () => disabledOption.click());
    expect(changed).not.toHaveBeenCalled();
    expect(trigger.dataset.value).toBe("viewer");
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent === "Read and write")!;
    await act(async () => option.click());
    expect(changed).toHaveBeenCalledExactlyOnceWith("builder");
    expect(trigger.dataset.value).toBe("builder");
    expect(trigger.textContent).toContain("Read and write");
    expect(trigger.getAttribute("aria-labelledby")?.split(" ")).toContain(labelId);
  });

  it("respects explicit ARIA names and does not assign a Field label to another control", async () => {
    await act(async () => root.render(<>
      <Field label="Visible access" htmlFor="explicit-access" labelId="visible-label">
        <Select id="explicit-access" aria-label="Custom access"><option value="viewer">Viewer</option></Select>
      </Field>
      <Field label="Unrelated field" htmlFor="other-control" labelId="unrelated-label">
        <Select native id="standalone-access"><option value="viewer">Viewer</option></Select>
      </Field>
      <Field label="Native access" htmlFor="native-access">
        <Select native id="native-access"><option value="viewer">Viewer</option></Select>
      </Field>
    </>));
    const explicit = container.querySelector("#explicit-access")!;
    expect(explicit.getAttribute("aria-labelledby")?.split(" ") ?? []).not.toContain("visible-label");
    const standalone = container.querySelector("#standalone-access")!;
    expect(standalone.getAttribute("aria-labelledby")).toBeNull();
    const native = container.querySelector<HTMLSelectElement>("#native-access")!;
    expect(native.getAttribute("aria-labelledby")).toBe(native.labels![0].id);
  });
});
