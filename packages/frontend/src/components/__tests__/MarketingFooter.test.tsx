// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarketingFooter } from "../MarketingFooter";

describe("MarketingFooter", () => {
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
  });

  it("links the terms, the privacy policy and the abuse page", async () => {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <MarketingFooter />
        </MemoryRouter>,
      ),
    );

    const links = Array.from(container.querySelectorAll("a")).map((link) => [
      link.getAttribute("href"),
      link.textContent,
    ]);
    expect(links).toEqual([
      ["/terms", "Terms of Use"],
      ["/privacy", "Privacy Policy"],
      ["/abuse", "Report abuse"],
    ]);
  });
});
