// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { BrowserSessionPageStrip } from "../BrowserSessionPageStrip";
import type { BrowserSessionPage } from "../browserSessionPages";

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

it("keeps page selection, active-page hiding and the expanded page order separate", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const selectPage = vi.fn();
  const toggleBrowser = vi.fn();
  const pages = ["Alpha", "Beta", "Gamma", "Delta"].map((label, index) => ({
    id: label.toLowerCase(), label, title: label, url: `https://${label.toLowerCase()}.example/`,
    host: `${label.toLowerCase()}.example`, isActive: index === 1, lastReferencedAt: 1,
  }));
  const pageButtons = () => Array.from(container.querySelectorAll<HTMLButtonElement>(
    '[data-testid="browser-session-page-chip"]',
  ));
  try {
    await act(async () => root.render(
      <BrowserSessionPageStrip pages={pages} browserHidden={false} browserOpen pendingNewBrowser={false}
        onSelectPage={selectPage} onToggleBrowser={toggleBrowser} onClearPendingNewBrowser={vi.fn()} />,
    ));
    expect(pageButtons().map(button => button.textContent)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(pageButtons().map(button => button.getAttribute("aria-pressed"))).toEqual(["false", "true", "false"]);
    await act(async () => pageButtons()[0].click());
    expect(selectPage).toHaveBeenCalledWith("alpha");
    expect(toggleBrowser).not.toHaveBeenCalled();
    await act(async () => pageButtons()[1].click());
    expect(toggleBrowser).toHaveBeenCalledTimes(1);
    expect(selectPage).toHaveBeenCalledTimes(1);
    const overflow = container.querySelector<HTMLButtonElement>('[data-testid="browser-session-page-overflow"]')!;
    await act(async () => overflow.click());
    expect(pageButtons().map(button => button.textContent)).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
    await act(async () => overflow.click());
    expect(pageButtons().map(button => button.textContent)).toEqual(["Alpha", "Beta", "Gamma"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});

it("keeps agent-labelled chips selectable and hides the active page when its badge is pressed", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const selectPage = vi.fn();
  const toggleBrowser = vi.fn();
  const pages: BrowserSessionPage[] = [
    { id: "person", label: "My page", title: "My page", url: "https://person.example/", host: "person.example", isActive: true, lastReferencedAt: 1 },
    { id: "agent", label: "Release notes", title: "Release notes", url: "https://docs.example/", host: "docs.example", isActive: false, lastReferencedAt: 1, openedBy: "agent", agentTabNumber: 3 },
  ];
  const renderStrip = (activeId: string) => root.render(
    <BrowserSessionPageStrip
      pages={pages.map((page) => ({ ...page, isActive: page.id === activeId }))}
      agentTabIds={new Set(["agent"])}
      agentName="Octo"
      browserHidden={false}
      browserOpen
      pendingNewBrowser={false}
      onSelectPage={selectPage}
      onToggleBrowser={toggleBrowser}
      onClearPendingNewBrowser={vi.fn()}
    />,
  );
  try {
    await act(async () => renderStrip("person"));
    const chips = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="browser-session-page-chip"]')];
    expect(chips).toHaveLength(2);
    expect(chips[0].querySelector('[data-testid="browser-agent-tab-badge"]')).toBeNull();
    const agentChip = chips[1];
    const badge = agentChip.querySelector<HTMLElement>('[data-testid="browser-agent-tab-badge"]')!;
    expect(badge.textContent).toBe("Octo's tab 3");
    expect(badge.title).toBe("Octo opened or is using this tab");
    expect(agentChip.textContent).toContain("Release notes");
    expect(agentChip.title).toBe("Release notes");
    expect(agentChip.getAttribute("aria-pressed")).toBe("false");
    await act(async () => badge.click());
    expect(selectPage).toHaveBeenCalledExactlyOnceWith("agent");
    expect(toggleBrowser).not.toHaveBeenCalled();

    await act(async () => renderStrip("agent"));
    expect(agentChip.getAttribute("aria-pressed")).toBe("true");
    expect(chips[0].getAttribute("aria-pressed")).toBe("false");
    await act(async () => badge.click());
    expect(toggleBrowser).toHaveBeenCalledOnce();
    expect(selectPage).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});
