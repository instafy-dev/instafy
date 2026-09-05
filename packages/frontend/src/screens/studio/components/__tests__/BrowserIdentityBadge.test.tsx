// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BrowserIdentityBadge } from "../BrowserIdentityBadge";

describe("BrowserIdentityBadge", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("makes the shared-with-team nature obvious, with an explanatory tooltip", async () => {
    await act(async () => {
      root.render(createElement(BrowserIdentityBadge, {}));
    });
    const badge = container.querySelector<HTMLElement>('[data-testid="browser-identity-badge"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain("Shared · this project");
    // The tooltip spells out the sharing so it is never a surprise.
    expect(badge?.title).toMatch(/this project's members see the same remote browser/i);
    expect(badge?.title).toMatch(/members with control can use those logins/i);
    expect(badge?.title).toMatch(/logins are not copied here/i);
  });

  it("passes through extra classes for placement", async () => {
    await act(async () => {
      root.render(createElement(BrowserIdentityBadge, { className: "hidden sm:inline-flex" }));
    });
    const badge = container.querySelector('[data-testid="browser-identity-badge"]');
    expect(badge?.className).toContain("sm:inline-flex");
  });
});
