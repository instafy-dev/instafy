import { act } from "react";

// react-aria focuses the selected item by querying [data-key=CSS.escape(key)]
// when a listbox mounts with a selection. jsdom has no CSS object at all, so
// that mount throws before any test can look at the menu. Same escaping the
// platform does, installed only where it is missing.
if (typeof (globalThis as { CSS?: unknown }).CSS === "undefined") {
  (globalThis as { CSS?: unknown }).CSS = {
    escape: (value: string) => String(value).replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, (c) => `\\${c}`),
  };
}

// Drive the product's Select from a unit test.
//
// Select draws its own menu, so the element a data-testid lands on is a button
// trigger, not a <select>: it has no .value, no .options, and no change event
// to dispatch. These read and choose through what the trigger does expose,
// data-value and the listbox it opens, and fall back to the native element for
// the one Select that still renders one (native).

function isNative(el: Element | null): el is HTMLSelectElement {
  return el instanceof HTMLSelectElement;
}

/** The value the control currently holds, "" when nothing is chosen. */
export function readSelectValue(el: Element | null): string {
  if (!el) return "";
  if (isNative(el)) return el.value;
  return el.getAttribute("data-value") ?? "";
}

/** Whether the control refuses input. */
export function isSelectDisabled(el: Element | null): boolean {
  if (!el) return false;
  if (isNative(el)) return el.disabled;
  return (el as HTMLButtonElement).disabled || el.getAttribute("data-disabled") === "true";
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

/** Open the menu and return the visible options' text, then close it. */
export async function readSelectOptions(el: Element | null): Promise<string[]> {
  if (!el) return [];
  if (isNative(el)) return Array.from(el.options).map((o) => o.textContent ?? "");
  await act(async () => {
    (el as HTMLElement).click();
    await settle();
  });
  const texts = Array.from(document.querySelectorAll('[role="listbox"] [role="option"]')).map(
    (o) => o.textContent ?? "",
  );
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
  });
  return texts;
}

/** Choose a value, the way a person would: open, pick, done. */
export async function chooseSelectValue(el: Element | null, value: string): Promise<void> {
  if (!el) throw new Error("chooseSelectValue: no element");
  if (isNative(el)) {
    await act(async () => {
      el.value = value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      await settle();
    });
    return;
  }
  await act(async () => {
    (el as HTMLElement).click();
    await settle();
  });
  const option = document.querySelector<HTMLElement>(`[role="listbox"] [role="option"][data-value="${value}"]`);
  if (!option) {
    const seen = Array.from(document.querySelectorAll('[role="listbox"] [role="option"]')).map((o) =>
      o.getAttribute("data-value"),
    );
    throw new Error(`chooseSelectValue: no option "${value}" (saw ${JSON.stringify(seen)})`);
  }
  await act(async () => {
    option.click();
    await settle();
  });
}
