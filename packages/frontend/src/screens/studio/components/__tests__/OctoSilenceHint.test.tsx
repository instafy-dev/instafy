// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OctoSilenceHint, OCTO_SILENCE_HINT_MESSAGE } from "../OctoSilenceHint";

describe("OctoSilenceHint", () => {
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

  it("dismisses once through the accessible control or the surrounding hint", async () => {
    const dismiss = vi.fn();
    await act(async () => root.render(<OctoSilenceHint onDismiss={dismiss} />));
    const hint = container.querySelector<HTMLElement>('[role="status"]')!;
    expect(hint.textContent).toContain(OCTO_SILENCE_HINT_MESSAGE);
    const button = hint.querySelector<HTMLButtonElement>('button[aria-label="Dismiss hint"]')!;
    await act(async () => button.click());
    expect(dismiss).toHaveBeenCalledTimes(1);
    await act(async () => hint.click());
    expect(dismiss).toHaveBeenCalledTimes(2);
  });
});
