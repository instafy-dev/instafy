// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBrowserAddressHistory } from "../browserAddressHistory";

const storageKey = (user = "user-a") => `instafy:browser-address-history:v1:${user}`;

describe("browser address history", () => {
  let root: Root;
  let container: HTMLDivElement;
  let history: ReturnType<typeof useBrowserAddressHistory>;
  let siblingHistory: ReturnType<typeof useBrowserAddressHistory>;
  const renderedUrls: string[][] = [];

  function Harness({ user = "user-a", page, sibling = false }: {
    user?: string | null;
    page?: { url: string; title?: string | null };
    sibling?: boolean;
  }) {
    const result = useBrowserAddressHistory(user, page);
    if (sibling) siblingHistory = result;
    else {
      history = result;
      renderedUrls.push(result.entries.map((entry) => entry.url));
    }
    return null;
  }

  async function render(page?: { url: string; title?: string | null }, user: string | null = "user-a") {
    await act(async () => root.render(<Harness user={user} page={page} />));
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    renderedUrls.length = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.spyOn(Date, "now").mockReturnValue(1000);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("remembers observed pages across remounts, deduplicates visits and updates late titles", async () => {
    await render({ url: "https://example.com", title: "Example" });
    vi.mocked(Date.now).mockReturnValue(2000);
    await render({ url: "https://example.org/article" });
    await render({ url: "https://example.org/article", title: "An article" });
    expect(history.entries[0]).toEqual({ url: "https://example.org/article", title: "An article", lastVisitedAt: 2000 });
    vi.mocked(Date.now).mockReturnValue(3000);
    await render({ url: "https://example.com/" });
    expect(history.entries).toEqual([
      { url: "https://example.com/", title: "Example", lastVisitedAt: 3000 },
      { url: "https://example.org/article", title: "An article", lastVisitedAt: 2000 },
    ]);
    await act(async () => root.render(null));
    await render();
    expect(history.entries.map((entry) => entry.title)).toEqual(["Example", "An article"]);
  });

  it("isolates accounts immediately and never saves an unchanged outgoing account page", async () => {
    await render({ url: "https://example.com/private" });
    renderedUrls.length = 0;
    await render({ url: "https://example.com/private" }, "user-b");
    expect(renderedUrls.every((urls) => urls.length === 0)).toBe(true);
    expect(window.localStorage.getItem(storageKey("user-b"))).toBeNull();
    await render({ url: "https://example.org/new" }, "user-b");
    expect(history.entries.map((entry) => entry.url)).toEqual(["https://example.org/new"]);
    await render(undefined, null);
    expect(history.entries).toEqual([]);
    await render();
    expect(history.entries.map((entry) => entry.url)).toEqual(["https://example.com/private"]);
  });

  it("does not save history without a signed-in account", async () => {
    await render({ url: "https://example.com/" }, null);
    expect(history.entries).toEqual([]);
    expect(window.localStorage.length).toBe(0);
  });

  it("does not update the next account's saved title from an outgoing account page", async () => {
    const saved = { url: "https://example.com/", title: "Account B page", lastVisitedAt: 50 };
    window.localStorage.setItem(storageKey("user-b"), JSON.stringify([saved]));
    await render({ url: saved.url, title: "Account A page" });
    await render({ url: saved.url, title: "Account A page" }, "user-b");
    await render({ url: saved.url, title: "Account A late title" }, "user-b");
    expect(history.entries).toEqual([saved]);
  });

  it("shares one recent list between mounted surfaces and clears without re-recording late titles", async () => {
    const renderBoth = async (title: string) => {
      await act(async () => root.render(<>
        <Harness page={{ url: "https://example.com/", title }} />
        <Harness sibling page={{ url: "https://example.org/", title: "Workspace page" }} />
      </>));
    };
    await renderBoth("Personal page");
    expect(history.entries).toEqual(siblingHistory.entries);
    expect(history.entries).toHaveLength(2);
    await act(async () => history.clear());
    expect(history.entries).toEqual([]);
    expect(siblingHistory.entries).toEqual([]);
    await renderBoth("A late title update");
    expect(history.entries).toEqual([]);
    expect(window.localStorage.getItem(storageKey())).toBeNull();
  });

  it("refreshes another window's visits and clear without writing back the current page", async () => {
    await render({ url: "https://example.com/" });
    const peerVisit = { url: "https://example.org/", title: "Another window", lastVisitedAt: 2000 };
    await act(async () => {
      window.localStorage.setItem(storageKey(), JSON.stringify([peerVisit]));
      window.dispatchEvent(new StorageEvent("storage", { key: storageKey() }));
    });
    expect(history.entries).toEqual([peerVisit]);
    await act(async () => {
      window.localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(history.entries).toEqual([]);
  });

  it.each(["not json", "{}", JSON.stringify([null, {}, { url: "https://example.com", title: "Bad date", lastVisitedAt: -1 }])])(
    "ignores malformed stored history: %s", async (raw) => {
      window.localStorage.setItem(storageKey(), raw);
      await render();
      expect(history.entries).toEqual([]);
      await render({ url: "https://example.com/", title: "Fresh" });
      expect(history.entries).toHaveLength(1);
    },
  );

  it.each(["javascript:alert(1)", "data:text/html,hello", "about:blank", "file:///tmp/file", "https://name:password@example.com/", "https://example.com/" + "x".repeat(4096)])(
    "does not store unsupported or credential-bearing URL %s", async (url) => {
      await render({ url, title: "Ignored" });
      expect(history.entries).toEqual([]);
      expect(window.localStorage.length).toBe(0);
    },
  );

  it("sanitizes persisted entries and bounds recent visits and titles", async () => {
    window.localStorage.setItem(storageKey(), JSON.stringify([
      ...Array.from({ length: 105 }, (_, index) => ({ url: `https://example.com/${index}`, title: "x".repeat(500), lastVisitedAt: index })),
      { url: "https://example.com/104", title: "Old duplicate", lastVisitedAt: 1 },
      { url: "javascript:alert(1)", title: "Unsafe", lastVisitedAt: 500 },
    ]));
    await render();
    expect(history.entries).toHaveLength(100);
    expect(history.entries[0].url).toBe("https://example.com/104");
    expect(history.entries[0].title).toHaveLength(300);
    expect(history.entries.at(-1)?.url).toBe("https://example.com/5");
    await render({ url: "https://example.org/", title: "y".repeat(500) });
    expect(history.entries).toHaveLength(100);
    expect(history.entries[0].title).toHaveLength(300);
    expect(JSON.parse(window.localStorage.getItem(storageKey())!)).toHaveLength(100);
  });

  it("does not break navigation when local storage is unavailable or full", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Full"); });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("Denied"); });
    await render({ url: "https://example.com/" });
    expect(history.entries).toEqual([]);
    await act(async () => history.clear());
    expect(history.entries).toEqual([]);
  });
});
