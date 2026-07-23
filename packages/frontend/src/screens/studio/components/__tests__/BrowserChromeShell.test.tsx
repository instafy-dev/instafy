// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserChromeShell, BrowserStatusPill } from "../BrowserChromeShell";

describe("BrowserChromeShell", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps all browser controls in one safe, non-wrapping toolbar", async () => {
    await act(async () => {
      root.render(
        <BrowserChromeShell
          actions={<button type="button">Action</button>}
          address={<input aria-label="Address" />}
          label="Browser controls"
          leading={<span>Transport</span>}
          navigation={<button type="button">Back</button>}
          status={<BrowserStatusPill detail="The browser is ready." state="ready" />}
          testId="browser-chrome-test"
        />,
      );
    });

    const toolbar = container.querySelector('[data-testid="browser-chrome-test"]');
    expect(toolbar?.getAttribute("role")).toBe("toolbar");
    expect(toolbar?.getAttribute("data-browser-session-safe-zone")).toBe("true");
    expect(toolbar?.className).toContain("flex-nowrap");
    expect(toolbar?.className).toContain("overflow-hidden");
    expect(toolbar?.className).toContain("max-[540px]:flex-wrap");
    expect(toolbar?.className).toContain("max-[400px]:gap-0.5");
    expect(toolbar?.className).toContain("max-[400px]:px-1");
    expect(
      container.querySelector('[data-testid="browser-chrome-status-slot"]')?.className,
    ).not.toContain("max-[540px]:hidden");
    expect(
      container.querySelector('[data-testid="browser-chrome-context-row"]')?.className,
    ).toContain("max-[540px]:basis-full");
    expect(toolbar?.textContent).toContain("Transport");
    expect(toolbar?.textContent).toContain("Ready");
  });

  it("shows long feedback outside the toolbar without truncating it", async () => {
    const onDismiss = vi.fn();
    await act(async () => {
      root.render(
        <BrowserChromeShell
          address={<input aria-label="Address" />}
          feedback="The complete browser error stays readable at narrow widths."
          feedbackId="browser-error"
          feedbackTestId="browser-feedback"
          label="Browser controls"
          navigation={<button type="button">Back</button>}
          onDismissFeedback={onDismiss}
        />,
      );
    });

    const feedback = container.querySelector<HTMLElement>('[data-testid="browser-feedback"]');
    expect(feedback?.getAttribute("role")).toBe("alert");
    expect(feedback?.id).toBe("browser-error");
    expect(feedback?.className).not.toContain("truncate");
    expect(feedback?.textContent).toContain("complete browser error");
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Dismiss browser message"]')?.click();
    });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it.each([
    ["ready", "Ready"],
    ["starting", "Starting…"],
    ["paused", "Paused"],
    ["unavailable", "Unavailable"],
  ] as const)("uses the common %s status vocabulary", async (state, label) => {
    await act(async () => {
      root.render(<BrowserStatusPill detail="Transport-specific detail." state={state} />);
    });
    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toContain(label);
    expect(status?.getAttribute("aria-label")).toBe(`${label}: Transport-specific detail.`);
  });
});
