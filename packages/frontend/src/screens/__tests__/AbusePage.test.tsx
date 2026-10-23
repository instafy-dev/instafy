// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInstafyRouter } from "../../router";
import type { FrontendFeatureComposition } from "../../features/frontendFeatureModule";
import { ABUSE_CONTACT_EMAIL } from "../AbusePage";

// The app shell listens for controller reload requests; the abuse page needs no controller.
vi.mock("../../services/runtimeController/core", () => ({
  subscribeToControllerReloadRequired: () => () => undefined,
}));

describe("/abuse", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    window.history.replaceState(null, "", "/abuse");
    // ScrollRestoration scrolls on navigation; jsdom has no layout to scroll.
    vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
  });

  it("serves a public page that says who makes hosted sites and how to report one", async () => {
    const router = createInstafyRouter({ routes: [] } as unknown as FrontendFeatureComposition);
    await act(async () => root.render(<RouterProvider router={router} />));

    const heading = container.querySelector("h1");
    expect(heading?.textContent).toBe("Report abuse");
    expect(container.textContent).toContain("made and run by Instafy users, not by Instafy");

    const contact = container.querySelector<HTMLAnchorElement>('[data-testid="abuse-contact"]');
    expect(ABUSE_CONTACT_EMAIL).toMatch(/^[^@\s]+@[^@\s]+\.[a-z]+$/);
    expect(contact?.textContent).toBe(ABUSE_CONTACT_EMAIL);
    expect(contact?.getAttribute("href")).toBe(`mailto:${ABUSE_CONTACT_EMAIL}?subject=Abuse%20report`);
    expect(container.textContent).toContain("What to include");
    expect(container.textContent).toContain("aim to reply within two business days");
    expect(document.title).toBe("Report abuse · Instafy");
  });
});
