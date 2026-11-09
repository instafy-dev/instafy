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

  it.each([false, true])("keeps controls in the same safe toolbar with compact=%s", async (compact) => {
    await act(async () => {
      root.render(
        <BrowserChromeShell
          compact={compact}
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
    // Compact callers supply their overflow menu, so they must not create a
    // second context row. Existing full-control callers retain their fallback.
    expect(toolbar?.classList.contains("max-[540px]:flex-wrap")).toBe(!compact);
    const context = container.querySelector('[data-testid="browser-chrome-context-row"]');
    expect(context?.classList.contains("max-[540px]:basis-full")).toBe(!compact);
    expect(toolbar?.contains(container.querySelector('[aria-label="Address"]'))).toBe(true);
    expect(toolbar?.contains(context)).toBe(true);
    expect(toolbar?.textContent).toContain("Transport");
    expect(toolbar?.textContent).toContain("Ready");
  });

  it.each(["error", "success"] as const)("keeps %s feedback addressable and dismissible outside the toolbar", async (feedbackTone) => {
    const onDismiss = vi.fn();
    await act(async () => {
      root.render(
        <BrowserChromeShell
          address={<input aria-label="Address" aria-describedby="browser-error" />}
          feedback="The complete browser error stays readable at narrow widths."
          feedbackId="browser-error"
          feedbackTestId="browser-feedback"
          feedbackTone={feedbackTone}
          label="Browser controls"
          navigation={<button type="button">Back</button>}
          onDismissFeedback={onDismiss}
        />,
      );
    });

    const feedback = container.querySelector<HTMLElement>('[data-testid="browser-feedback"]');
    expect(feedback?.getAttribute("role")).toBe(feedbackTone === "error" ? "alert" : "status");
    expect(feedback?.id).toBe("browser-error");
    expect(feedback?.className).not.toContain("truncate");
    expect(feedback?.textContent).toContain("complete browser error");
    const toolbar = container.querySelector('[role="toolbar"]')!;
    expect(toolbar.contains(feedback)).toBe(false);
    expect(toolbar.querySelector('[aria-label="Address"]')?.getAttribute("aria-describedby")).toBe(feedback?.id);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Dismiss browser message"]')?.click();
    });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("keeps Resume an independently labelled action and honors disabled control", async () => {
    const resume = vi.fn();
    const render = (disabled: boolean) => act(async () => root.render(
      <BrowserStatusPill state="paused" resume={{ onPress: resume, disabled }} />,
    ));
    await render(true);
    const disabledButton = container.querySelector<HTMLButtonElement>('[aria-label="Resume agent control"]')!;
    expect(disabledButton.disabled).toBe(true);
    await act(async () => disabledButton.click());
    expect(resume).not.toHaveBeenCalled();
    await render(false);
    const button = container.querySelector<HTMLButtonElement>('[aria-label="Resume agent control"]')!;
    expect(button.textContent).toBe("Resume");
    expect(container.querySelector('[role="status"]')).toBeNull();
    await act(async () => button.click());
    expect(resume).toHaveBeenCalledOnce();
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
    expect(status?.className.includes("sr-only")).toBe(state === "ready");
    expect(status?.getAttribute("aria-label")).toBe(`${label}: Transport-specific detail.`);
  });

  it("tells only a screen reader it is starting while the view says so itself", async () => {
    await act(async () => {
      root.render(<BrowserStatusPill detail="Opening Instafy's browser…" state="starting" startingShownInView />);
    });
    const status = container.querySelector('[role="status"]')!;
    expect(status.textContent).toBe("Starting…");
    expect(status.className).toBe("sr-only");
    expect(status.getAttribute("aria-label")).toBe("Starting…: Opening Instafy's browser…");
    expect(status.querySelector("svg")).toBeNull();

    // Paused, off and unavailable stay visible.
    await act(async () => {
      root.render(<BrowserStatusPill detail="Instafy's browser is off." state="off" startingShownInView />);
    });
    expect(container.querySelector('[role="status"]')!.className).not.toContain("sr-only");
  });

  it("says Off in a neutral tone, without the unavailable mark", async () => {
    await act(async () => {
      root.render(<BrowserStatusPill detail="Instafy's browser is off." state="off" />);
    });
    const status = container.querySelector('[role="status"]')!;
    expect(status.textContent).toBe("Off");
    expect(status.getAttribute("aria-label")).toBe("Off: Instafy's browser is off.");
    expect(status.className).not.toContain("rose");
    expect(status.querySelector("svg")).toBeNull();
  });
});
