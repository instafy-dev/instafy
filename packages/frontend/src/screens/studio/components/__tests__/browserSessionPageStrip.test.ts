import { describe, expect, it } from "vitest";

import { resolveCollapsedBrowserSessionPages } from "../BrowserSessionPageStrip";
import { reconcileBrowserSessionPageOrder } from "../useBrowserSessionPages";
import type { BrowserSessionPage } from "../browserSessionPages";
import type { RuntimeBrowserSessionPage } from "../../../../sdk/instafy";

function browserPage(overrides: Partial<BrowserSessionPage> & Pick<BrowserSessionPage, "id" | "label">): BrowserSessionPage {
  return {
    id: overrides.id,
    url: overrides.url ?? `https://${overrides.id}.example.com/`,
    host: overrides.host ?? `${overrides.id}.example.com`,
    label: overrides.label,
    title: overrides.title ?? overrides.label,
    lastReferencedAt: overrides.lastReferencedAt ?? 1,
    isActive: overrides.isActive ?? false,
  };
}

function runtimePage(
  overrides: Partial<RuntimeBrowserSessionPage> & Pick<RuntimeBrowserSessionPage, "id" | "label">,
): RuntimeBrowserSessionPage {
  return {
    id: overrides.id,
    url: overrides.url ?? `https://${overrides.id}.example.com/`,
    host: overrides.host ?? `${overrides.id}.example.com`,
    label: overrides.label,
    title: overrides.title ?? overrides.label,
    isActive: overrides.isActive ?? false,
    canGoBack: overrides.canGoBack ?? false,
    canGoForward: overrides.canGoForward ?? false,
  };
}

describe("browser session page ordering", () => {
  it("keeps the existing tab order stable when the focused page changes", () => {
    const currentPages = [
      browserPage({ id: "pear", label: "Pear", isActive: false }),
      browserPage({ id: "bbc", label: "BBC Home", isActive: true }),
    ];
    const livePages = [
      runtimePage({ id: "bbc", label: "BBC Home", isActive: true }),
      runtimePage({ id: "pear", label: "Pear", isActive: false }),
    ];

    expect(
      reconcileBrowserSessionPageOrder({
        currentPages,
        livePages,
        activePageId: "bbc",
      }).map((page) => ({ id: page.id, isActive: page.isActive })),
    ).toEqual([
      { id: "pear", isActive: false },
      { id: "bbc", isActive: true },
    ]);
  });

  it("appends newly discovered tabs without reordering existing ones", () => {
    const currentPages = [browserPage({ id: "pear", label: "Pear", isActive: true })];
    const livePages = [
      runtimePage({ id: "bbc", label: "BBC Home", isActive: false }),
      runtimePage({ id: "pear", label: "Pear", isActive: true }),
    ];

    expect(
      reconcileBrowserSessionPageOrder({
        currentPages,
        livePages,
        activePageId: "pear",
      }).map((page) => page.id),
    ).toEqual(["pear", "bbc"]);
  });
});

describe("resolveCollapsedBrowserSessionPages", () => {
  it("keeps tab order intact while ensuring the active page stays visible", () => {
    const pages = [
      browserPage({ id: "alpha", label: "Alpha" }),
      browserPage({ id: "beta", label: "Beta" }),
      browserPage({ id: "gamma", label: "Gamma", isActive: true }),
      browserPage({ id: "delta", label: "Delta" }),
    ];

    expect(resolveCollapsedBrowserSessionPages(pages, 3).map((page) => page.id)).toEqual([
      "beta",
      "gamma",
      "delta",
    ]);
  });
});
