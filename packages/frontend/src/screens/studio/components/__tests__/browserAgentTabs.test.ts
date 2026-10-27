import { describe, expect, it } from "vitest";
import {
  browserReadingHost,
  browserReadingTitle,
  PERSONAL_BROWSER_SINGLE_PAGE_ID,
  personalBrowserTabPages,
  resolveAgentReadingPages,
  resolveAgentTabIds,
  sharedBrowserAgentTabLabel,
} from "../browserAgentTabs";
import type { BrowserSessionPage } from "../browserSessionPages";

function page(id: string, overrides: Partial<BrowserSessionPage> = {}): BrowserSessionPage {
  return {
    id,
    url: `https://${id}.example/`,
    host: `${id}.example`,
    label: id,
    title: `${id} title`,
    lastReferencedAt: 1,
    isActive: false,
    ...overrides,
  };
}

describe("resolveAgentTabIds", () => {
  const pages = [
    page("mine"),
    page("opened", { openedBy: "agent" }),
    page("bound", { openedBy: "person" }),
  ];

  it("marks the tabs the agent opened and the tab its run is bound to while it has control", () => {
    expect([...resolveAgentTabIds({ pages, agentControlActive: true, agentPageIds: ["bound"] })])
      .toEqual(["opened", "bound"]);
  });

  it("marks nothing once control is gone (Pause, Escape or take-over)", () => {
    expect(resolveAgentTabIds({ pages, agentControlActive: false, agentPageIds: ["bound"] }).size).toBe(0);
  });

  it("ignores bound ids for tabs that are not open", () => {
    expect([...resolveAgentTabIds({ pages, agentControlActive: true, agentPageIds: ["closed", " "] })])
      .toEqual(["opened"]);
  });

  it("leaves out the tabs an earlier run left open: the agent holds them no more", () => {
    const withEarlier = [...pages, page("earlier", { openedBy: "agent", leftover: true })];
    expect([...resolveAgentTabIds({ pages: withEarlier, agentControlActive: true, agentPageIds: ["bound"] })])
      .toEqual(["opened", "bound"]);
  });
});

describe("sharedBrowserAgentTabLabel", () => {
  it("names a tab the agent opened as its prompts do", () => {
    expect(sharedBrowserAgentTabLabel({ agentTabNumber: 4 })).toBe("Octo's tab 4");
    expect(sharedBrowserAgentTabLabel({})).toBe("Octo's tab");
  });

  it("names a tab an earlier run left open apart from the running turn's numbered tabs", () => {
    expect(sharedBrowserAgentTabLabel({ leftover: true })).toBe("Octo's earlier tab");
    expect(sharedBrowserAgentTabLabel({ leftover: true, agentTabNumber: 1 })).toBe("Octo's earlier tab");
  });
});

describe("resolveAgentReadingPages", () => {
  it("lists the agent's tabs that show a web page, in tab order", () => {
    const pages = [
      page("blank", { url: "about:blank", host: "", openedBy: "agent" }),
      page("b", { openedBy: "agent" }),
      page("a"),
      page("c", { openedBy: "agent" }),
    ];
    expect(resolveAgentReadingPages({ pages, agentControlActive: true, agentPageIds: ["a"] }).map((p) => p.id))
      .toEqual(["b", "a", "c"]);
    expect(resolveAgentReadingPages({ pages, agentControlActive: false })).toEqual([]);
  });

  it("never lists a tab an earlier run left open as being read", () => {
    const pages = [page("b", { openedBy: "agent", agentTabNumber: 1 }), page("earlier", { openedBy: "agent", leftover: true })];
    expect(resolveAgentReadingPages({ pages, agentControlActive: true }).map((p) => p.id)).toEqual(["b"]);
  });
});

describe("reading labels", () => {
  it("shows a bare host and a one-line, bounded title", () => {
    expect(browserReadingHost({ host: "www.example.com", url: "https://www.example.com/x" })).toBe("example.com");
    expect(browserReadingHost({ host: "", url: "https://www.docs.example/x" })).toBe("docs.example");
    expect(browserReadingTitle({ title: "  A\n title  " })).toBe("A title");
    expect(browserReadingTitle({ title: null })).toBeNull();
    const long = browserReadingTitle({ title: "x".repeat(200) })!;
    expect(long.length).toBe(80);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("personalBrowserTabPages", () => {
  it("treats a one-page host's page as its only, active tab", () => {
    expect(personalBrowserTabPages({ url: "https://www.example.com/a", title: "Example" })).toEqual([{
      id: PERSONAL_BROWSER_SINGLE_PAGE_ID,
      url: "https://www.example.com/a",
      host: "example.com",
      label: "Example",
      title: "Example",
      lastReferencedAt: 1,
      isActive: true,
    }]);
    expect(personalBrowserTabPages({ url: "" })).toEqual([]);
    expect(personalBrowserTabPages(null)).toEqual([]);
  });

  it("reads a multi-tab host's tabs and keeps only an agent opener", () => {
    const pages = personalBrowserTabPages({
      url: "https://one.example/",
      tabs: [
        { id: "t1", url: "https://one.example/", title: "One", active: true },
        { id: "t2", url: "https://two.example/", active: false, openedBy: "agent" },
        { id: "t3", url: "https://three.example/", active: false, openedBy: "something-else" },
        { id: "", url: "https://dropped.example/", active: false },
      ],
    });
    expect(pages.map((p) => [p.id, p.isActive, p.openedBy, p.label])).toEqual([
      ["t1", true, undefined, "One"],
      ["t2", false, "agent", "two.example"],
      ["t3", false, undefined, "three.example"],
    ]);
  });
});
