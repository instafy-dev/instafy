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
    const error = "Could not stop the browser task because the connection is unavailable. Reconnect and try taking control again; the page remains locked until ownership is confirmed.";
    await act(async () => root.render(
      <BrowserReadingRow pages={[page("alpha")]} agentName="Researcher" canTakeOver takingOver error={error} onTakeOver={vi.fn()} />,
    ));
    expect(container.textContent).toContain("Researcher is reading");
    const takeOver = container.querySelector<HTMLButtonElement>('[data-testid="browser-reading-takeover"]')!;
    expect(takeOver.textContent).toBe("Stopping Researcher…");
    expect(takeOver.disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(error);
    expect(container.querySelector('[role="alert"]')!.hasAttribute("title")).toBe(false);

    await act(async () => root.render(<BrowserReadingRow pages={[page("alpha")]} canTakeOver={false} onTakeOver={vi.fn()} />));
    expect(container.querySelector('[data-testid="browser-reading-row"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="browser-reading-takeover"]')).toBeNull();

    await act(async () => root.render(<BrowserReadingRow pages={[]} canTakeOver onTakeOver={vi.fn()} />));
    expect(container.querySelector('[data-testid="browser-reading-row"]')).toBeNull();
  });

  // "Octo's tab 1" is the label Octo's own prompts use; the person reads the
  // page's site and title.
  it("names the page of a tab the agent opened, never the tab's number", async () => {
    const opened = page("gamma", { openedBy: "agent", agentTabNumber: 3 });
    await act(async () => root.render(<BrowserReadingRow pages={[opened]} canTakeOver onTakeOver={vi.fn()} />));
    const item = container.querySelector<HTMLElement>('[data-testid="browser-reading-page"]')!;
    expect(item.textContent).toBe("gamma.example· gamma title");
    expect(item.title).toBe("gamma title\nhttps://www.gamma.example/path");
    expect(container.textContent).not.toContain("tab 3");
  });

  // A local test: the row read "visitporto.travel · about:blank" for 27 s
  // while a blank tab loaded a slow site, and in a later test "Octo is
  // reading 1 page visitporto.travel" for 17 s while the site never answered.
  // Until the page arrives, the browser reports the new address with the blank
  // tab's title, or with none.
  it("says it is opening a site until its page answers, never that it reads it or a blank tab's title", async () => {
    const opening = (title: string | null) => page("visitporto", {
      url: "https://www.visitporto.travel/",
      host: "visitporto.travel",
      title,
    });
    for (const title of ["about:blank", null, "  "]) {
      await act(async () => root.render(<BrowserReadingRow pages={[opening(title)]} canTakeOver onTakeOver={vi.fn()} />));
      const row = container.querySelector('[data-testid="browser-reading-row"]')!;
      expect(row.textContent).toBe("Opening visitporto.travel…Take over");
      expect(row.textContent).not.toMatch(/reading|about:blank/);
      expect(row.querySelector('[data-testid="browser-reading-page"]')).toBeNull();
      // Take over is there while it opens, as while it reads.
      expect(row.querySelector('[data-testid="browser-reading-takeover"]')).not.toBeNull();
    }

    // Two sites, neither answered yet.
    const second = page("carris", { url: "https://www.carris.pt/", host: "carris.pt", title: null });
    await act(async () => root.render(<BrowserReadingRow pages={[opening(null), second]} canTakeOver onTakeOver={vi.fn()} />));
    expect(container.querySelector('[data-testid="browser-reading-opening"]')!.textContent)
      .toBe("Opening visitporto.travel and carris.pt…");

    // Once a page answers, the row reads it: with its title, or, for a page with
    // no title of its own, the address the browser names it by.
    await act(async () => root.render(
      <BrowserReadingRow pages={[opening("Visit Porto"), second]} canTakeOver onTakeOver={vi.fn()} />,
    ));
    const row = container.querySelector('[data-testid="browser-reading-row"]')!;
    expect(row.textContent).toContain("Octo is reading");
    expect([...row.querySelectorAll('[data-testid="browser-reading-page"]')].map((item) => item.textContent))
      .toEqual(["visitporto.travel· Visit Porto", "carris.pt"]);
    await act(async () => root.render(
      <BrowserReadingRow pages={[opening("httpbin.org/forms/post")]} canTakeOver onTakeOver={vi.fn()} />,
    ));
    expect(container.textContent).toContain("Octo is reading");
    expect(container.querySelector('[data-testid="browser-reading-opening"]')).toBeNull();
  });

  // A local test: while a prompt waited for the person, the row said "Octo
  // is reading httpbin.org · httpbin.org/forms/post" above it.
  it("says it is waiting for you while a prompt waits, beside the page it is about", async () => {
    const form = page("httpbin", { url: "https://httpbin.org/forms/post", host: "httpbin.org", title: "httpbin.org/forms/post" });
    await act(async () => root.render(<BrowserReadingRow pages={[form]} waitingForYou canTakeOver onTakeOver={vi.fn()} />));
    const row = container.querySelector('[data-testid="browser-reading-row"]')!;
    const label = row.querySelector("span[id]")!;
    expect(label.textContent).toBe("Waiting for you");
    expect(row.textContent).not.toContain("reading");
    expect(row.querySelector("ul")!.getAttribute("aria-labelledby")).toBe(label.id);
    expect([...row.querySelectorAll('[data-testid="browser-reading-page"]')].map((item) => item.textContent))
      .toEqual(["httpbin.org· httpbin.org/forms/post"]);

    // A prompt about a page still opening (a site to allow): it waits all the same.
    const blank = page("httpbin", { url: "https://httpbin.org/forms/post", host: "httpbin.org", title: null });
    await act(async () => root.render(<BrowserReadingRow pages={[blank]} waitingForYou canTakeOver onTakeOver={vi.fn()} />));
    expect(container.querySelector("span[id]")!.textContent).toBe("Waiting for you");
    expect(container.textContent).not.toContain("Opening");

    // Answered: back to what Octo does.
    await act(async () => root.render(<BrowserReadingRow pages={[form]} canTakeOver onTakeOver={vi.fn()} />));
    expect(container.querySelector("span[id]")!.textContent).toBe("Octo is reading 1 page");
  });
});
