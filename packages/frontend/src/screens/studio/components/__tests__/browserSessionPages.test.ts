import { describe, expect, it } from "vitest";
import {
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
});
