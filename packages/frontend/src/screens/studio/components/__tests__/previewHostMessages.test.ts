import { describe, expect, it } from "vitest";
import { buildHostLayoutMessage, isSiteMessageSource, parseSiteMessage, withHostQuery } from "../previewHost/hostMessages";
import { SITE_PREVIEW_FRAME_ALLOW } from "../SitePreviewPane";

describe("host → site layout message", () => {
  it("has the v1 shape: the theme, and location only through Studio", () => {
    expect(buildHostLayoutMessage("dark")).toEqual({ source: "instafy-host", v: 1, type: "layout", caps: { location: "host" }, theme: "dark" });
    expect(buildHostLayoutMessage("light")).toEqual(expect.objectContaining({ theme: "light" }));
  });

  it("adds ?instafy_host=studio to the frame address, keeping the path and any query", () => {
    expect(withHostQuery("https://p-x--y.preview.test/")).toBe("https://p-x--y.preview.test/?instafy_host=studio");
    expect(withHostQuery("https://p-x--y.preview.test/app?a=1#z")).toBe("https://p-x--y.preview.test/app?a=1&instafy_host=studio#z");
    expect(withHostQuery("not a url")).toBe("not a url");
  });

  it("never delegates geolocation to the frame", () => {
    // A frame allowed geolocation would use Studio's own grant, silently, for every preview.
    expect(SITE_PREVIEW_FRAME_ALLOW.split("; ")).toEqual(["fullscreen", "clipboard-write"]);
  });
});

describe("site → host events", () => {
  it("takes any site kit's name as the source, but not Studio's own and not odd shapes", () => {
    for (const source of ["instafy-site", "site-kit", "acme-kit"]) expect(isSiteMessageSource(source)).toBe(true);
    for (const source of ["instafy-host", "", "Bad Name", "x".repeat(41), 3, null]) expect(isSiteMessageSource(source)).toBe(false);
    expect(parseSiteMessage({ source: "acme-kit", v: 1, type: "interact" })).toEqual({ type: "interact" });
    expect(parseSiteMessage({ source: "instafy-host", v: 1, type: "interact" })).toBeNull();
    expect(parseSiteMessage({ source: "acme-kit", v: 2, type: "interact" })).toBeNull();
    expect(parseSiteMessage("interact")).toBeNull();
    expect(parseSiteMessage(null)).toBeNull();
  });

  it("reads follow mode's view, tap and interact, and what a site supports", () => {
    const kit = { source: "site-kit", v: 1 };
    expect(parseSiteMessage({ ...kit, type: "layout-ack", payload: { v: 1, supports: ["view", "tap", "view", "Bad Name", 3, "x".repeat(30)] } }))
      .toEqual({ type: "layout-ack", supports: ["view", "tap"] });
    expect(parseSiteMessage({ ...kit, type: "layout-ack", payload: {} })).toEqual({ type: "layout-ack", supports: [] });
    // The view stays opaque: Studio forwards it unread (followMode.ts checks size and shape).
    const payload = { path: "/results", q: "sort=price", top: "row-3" };
    expect(parseSiteMessage({ ...kit, type: "view", seq: 7, payload })).toEqual({ type: "view", seq: 7, payload });
    expect(parseSiteMessage({ ...kit, type: "view", payload: "#t=9" })).toEqual({ type: "view", seq: null, payload: "#t=9" });
    expect(parseSiteMessage({ ...kit, type: "view" })).toBeNull();
    expect(parseSiteMessage({ ...kit, type: "tap", seq: 2, payload: { x: 0.4, y: 0.6 } })).toEqual({ type: "tap", seq: 2, payload: { x: 0.4, y: 0.6 } });
  });

  it("reads nothing else: a site cannot select, navigate or drive Studio through this channel", () => {
    for (const type of ["select", "lens", "ask", "hotkey", "page", "command", "navigate"]) {
      expect(parseSiteMessage({ source: "instafy-site", v: 1, type, payload: { id: "x", key: "escape", path: "/" } })).toBeNull();
    }
  });
});
