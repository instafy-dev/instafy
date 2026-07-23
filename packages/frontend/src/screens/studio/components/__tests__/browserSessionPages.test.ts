import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types";
import {
  browserSessionPageIsPlaceholder,
  buildNewBrowserSessionMessage,
  buildBrowserSessionTargetedMessage,
  resolveBrowserSessionPages,
  resolvePreferredBrowserSessionPage,
  shouldAutoTargetBrowserSessionMessage,
  toBrowserSessionPageTarget,
} from "../browserSessionPages";

function assistantMessage(content: string, timestamp: number): ChatMessage {
  return {
    id: `assistant-${timestamp}`,
    role: "assistant",
    content,
    timestamp,
    messageType: "status",
    metadata: null,
  };
}

describe("browserSessionPages", () => {
  it("extracts multiple browser pages and keeps the last active page", () => {
    const pages = resolveBrowserSessionPages([
      assistantMessage(
        "Opened https://example.com and https://www.bbc.com in separate tabs in the shared browser session.",
        10,
      ),
      assistantMessage(
        'Switched back to the Example tab and confirmed the page title is "Example Domain".',
        20,
      ),
    ]);

    expect(pages).toHaveLength(2);
    expect(pages[0]?.host).toBe("example.com");
    expect(pages[0]?.title).toBe("Example Domain");
    expect(pages[0]?.isActive).toBe(true);
    expect(pages[1]?.host).toBe("bbc.com");
    expect(pages[1]?.isActive).toBe(false);
  });

  it("prefers concise page labels and collapses redirect-like duplicates", () => {
    const pages = resolveBrowserSessionPages([
      assistantMessage("Opened https://www.wikipedia.org in the shared browser session.", 10),
      assistantMessage(
        'Opened a fresh tab in the shared runtime, navigated to `https://en.wikipedia.org/wiki/Main_Page`, and the page title is "Wikipedia, the free encyclopedia."',
        20,
      ),
      assistantMessage(
        'Opened https://www.bbc.com/news and confirmed the page title is "BBC News - Breaking news, video and the latest top stories from the U.S. and around the world."',
        30,
      ),
    ]);

    expect(pages).toHaveLength(2);
    expect(pages[0]?.label).toBe("BBC News");
    expect(pages[1]?.label).toBe("Wikipedia");
    expect(pages[1]?.host).toBe("en.wikipedia.org");
  });

  it("ignores non-browser links from unrelated assistant replies", () => {
    const pages = resolveBrowserSessionPages([
      assistantMessage("You can read the docs at https://example.com/docs/api if you need them.", 10),
    ]);

    expect(pages).toEqual([]);
  });

  it("builds a one-shot browser-targeted message", () => {
    const [page] = resolveBrowserSessionPages([
      assistantMessage("Opened https://example.com in the shared browser session.", 10),
    ]);

    expect(page).toBeTruthy();
    const target = toBrowserSessionPageTarget(page!);
    expect(
      buildBrowserSessionTargetedMessage("Summarize the current page.", target),
    ).toContain('Use the existing "example.com" page in the current shared browser session');
    expect(
      buildBrowserSessionTargetedMessage("Summarize the current page.", target),
    ).toContain("https://example.com/");
    expect(
      buildBrowserSessionTargetedMessage("Summarize the current page.", target),
    ).toContain("not as a new isolated session or a new runtime-backed browser session");
  });

  it("builds a one-shot new browser session message", () => {
    expect(
      buildNewBrowserSessionMessage("Open bbc.com and keep the current page available."),
    ).toContain("fresh browser page/context");
    expect(
      buildNewBrowserSessionMessage("Open bbc.com and keep the current page available."),
    ).toContain("Prefer another page in the shared browser session");
  });

  it("prefers the active page for automatic browser continuation", () => {
    const pages = resolveBrowserSessionPages([
      assistantMessage("Opened https://example.com and https://www.bbc.com in separate tabs.", 10),
      assistantMessage('Switched back to the BBC tab and confirmed the page title is "BBC Home".', 20),
    ]);

    expect(resolvePreferredBrowserSessionPage(pages)?.host).toBe("bbc.com");
  });

  it("auto-targets prompts that clearly continue browser work", () => {
    expect(shouldAutoTargetBrowserSessionMessage("go to bbc.com")).toBe(true);
    expect(shouldAutoTargetBrowserSessionMessage("navigate further in the news site")).toBe(true);
    expect(shouldAutoTargetBrowserSessionMessage("click the cookie banner there")).toBe(true);
    expect(shouldAutoTargetBrowserSessionMessage("explain recursion")).toBe(false);
    expect(shouldAutoTargetBrowserSessionMessage("open package.json")).toBe(false);
  });

  it("distinguishes blank browser targets from targetable shared pages", () => {
    expect(browserSessionPageIsPlaceholder({ url: "about:blank" })).toBe(true);
    expect(browserSessionPageIsPlaceholder({ url: "chrome://newtab/" })).toBe(true);
    expect(browserSessionPageIsPlaceholder({ url: "https://example.com/" })).toBe(false);
  });
});
