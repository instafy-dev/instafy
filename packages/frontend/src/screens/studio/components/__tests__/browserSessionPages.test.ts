import { describe, expect, it } from "vitest";
import {
  browserSessionPageIsBlank,
  browserSessionPageIsPlaceholder,
  buildNewBrowserSessionMessage,
  shouldAutoTargetBrowserSessionMessage,
} from "../browserSessionPages";

describe("browserSessionPages", () => {
  it("builds a one-shot new browser session message", () => {
    expect(
      buildNewBrowserSessionMessage("Open bbc.com and keep the current page available."),
    ).toContain("fresh browser page/context");
    expect(
      buildNewBrowserSessionMessage("Open bbc.com and keep the current page available."),
    ).toContain("Prefer another page in the shared browser session");
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

  // A tab listed with no address shows no page to target yet, but it is no
  // blank tab: it may be on its way to someone's page.
  it("tells a blank tab from one the browser lists with no address", () => {
    expect(browserSessionPageIsBlank({ url: "about:blank" })).toBe(true);
    expect(browserSessionPageIsBlank({ url: " Chrome://NewTab/ " })).toBe(true);
    expect(browserSessionPageIsBlank({ url: "https://example.com/" })).toBe(false);
    expect(browserSessionPageIsBlank({ url: "" })).toBe(false);
    expect(browserSessionPageIsPlaceholder({ url: "" })).toBe(true);
  });
});
