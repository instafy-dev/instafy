// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { BrowserSessionPageStrip } from "../BrowserSessionPageStrip";

it("labels the pending AI request separately from real tabs and lets users cancel it", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const cancelRequest = vi.fn();
  const selectPage = vi.fn();
  try {
    await act(async () => {
      root.render(
        <BrowserSessionPageStrip
          pages={[]}
          browserHidden={false}
          browserOpen
          pendingNewBrowser
          onSelectPage={selectPage}
          onToggleBrowser={vi.fn()}
          onClearPendingNewBrowser={cancelRequest}
        />,
      );
    });
    const pendingRequest = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Cancel new tab request"]',
    )!;
    expect(pendingRequest.textContent).toContain("Next AI request: new tab");
    expect(container.querySelector('[data-testid="browser-session-page-chip"]')).toBeNull();
    await act(async () => pendingRequest.click());
    expect(cancelRequest).toHaveBeenCalledTimes(1);
    expect(selectPage).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});
