// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserReadingRow } from "../BrowserReadingRow";
import type { BrowserSessionPage } from "../browserSessionPages";

function page(id: string, overrides: Partial<BrowserSessionPage> = {}): BrowserSessionPage {
  return {
    id,
    url: `https://www.${id}.example/path`,
    host: `www.${id}.example`,
    label: id,
    title: `${id} title`,
    lastReferencedAt: 1,
    isActive: false,
    ...overrides,
  };
}

describe("BrowserReadingRow", () => {
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

  it("lists each page as host and title text, and takes over in one press", async () => {
    const onTakeOver = vi.fn();
    await act(async () => root.render(
      <BrowserReadingRow
        pages={[page("alpha"), page("beta", { title: "<img src=x onerror=alert(1)> Beta" })]}
        canTakeOver
        onTakeOver={onTakeOver}
      />,
    ));
    const row = container.querySelector('[data-testid="browser-reading-row"]')!;
    expect(row.textContent).toContain("Octo is reading");
    const items = [...row.querySelectorAll('[data-testid="browser-reading-page"]')];
    expect(items.map((item) => item.textContent)).toEqual([
      "alpha.example· alpha title",
      "beta.example· <img src=x onerror=alert(1)> Beta",
    ]);
    // Page titles are text, never markup.
    expect(row.querySelector("img")).toBeNull();
    expect(items[0]!.getAttribute("title")).toBe("alpha title\nhttps://www.alpha.example/path");
    expect(row.querySelector("ul")!.getAttribute("aria-labelledby")).toBe(
      row.querySelector("span[id]")!.id,
    );

    const takeOver = container.querySelector<HTMLButtonElement>('[data-testid="browser-reading-takeover"]')!;
    expect(takeOver.textContent).toBe("Take over");
    expect(onTakeOver).not.toHaveBeenCalled();
    await act(async () => takeOver.click());
    // No confirmation step: one press revokes the agent's control.
    expect(onTakeOver).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("names the agent, shows progress and errors, and hides without pages", async () => {
    await act(async () => root.render(
      <BrowserReadingRow pages={[page("alpha")]} agentName="Researcher" canTakeOver takingOver error="Could not stop" onTakeOver={vi.fn()} />,
    ));
    expect(container.textContent).toContain("Researcher is reading");
    const takeOver = container.querySelector<HTMLButtonElement>('[data-testid="browser-reading-takeover"]')!;
    expect(takeOver.textContent).toBe("Stopping AI…");
    expect(takeOver.disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("Could not stop");

    await act(async () => root.render(<BrowserReadingRow pages={[page("alpha")]} canTakeOver={false} onTakeOver={vi.fn()} />));
    expect(container.querySelector('[data-testid="browser-reading-row"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="browser-reading-takeover"]')).toBeNull();

    await act(async () => root.render(<BrowserReadingRow pages={[]} canTakeOver onTakeOver={vi.fn()} />));
    expect(container.querySelector('[data-testid="browser-reading-row"]')).toBeNull();
  });

  it("labels a tab the agent opened in the row as its prompts do", async () => {
    const opened = page("gamma", { openedBy: "agent", agentTabNumber: 3 });
    await act(async () => root.render(<BrowserReadingRow pages={[opened]} canTakeOver onTakeOver={vi.fn()} />));
    const item = container.querySelector<HTMLElement>('[data-testid="browser-reading-page"]')!;
    expect(item.title.startsWith("Octo's tab 3: ")).toBe(true);
    expect(item.textContent).toContain("Octo's tab 3:");
  });
});
