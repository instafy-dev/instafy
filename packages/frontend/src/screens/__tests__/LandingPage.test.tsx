// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LandingPage } from "../LandingPage";

const auth = vi.hoisted(() => ({ loading: true, user: null as { id: string } | null }));
vi.mock("../../providers/AuthProvider", () => ({ useAuth: () => auth }));

// The demo has its own selection and animation coverage.
vi.mock("../landing/LandingSessionDeck", () => ({
  LandingSessionDeck: ({ joinToFor }: { joinToFor: (scenario: { id: string }) => string }) => (
    <a data-testid="example-entry" href={joinToFor({ id: "code" })}>Start a session</a>
  ),
}));

describe("LandingPage entry", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    auth.loading = true;
    auth.user = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderPage() {
    await act(async () => root.render(<MemoryRouter><LandingPage /></MemoryRouter>));
  }

  it("renders public content immediately while a saved session is still being restored", async () => {
    await renderPage();
    expect(container.querySelector("h1")?.textContent).toContain("Good work");
    expect(container.textContent).not.toContain("Loading Instafy");
    expect(container.querySelector('[data-testid="landing-get-started-button"]')?.getAttribute("href")).toBe("/studio");
    expect(container.querySelector('[data-testid="example-entry"]')?.getAttribute("href")).toBe("/studio?from=landing-code");
    expect(container.querySelector('a[href^="/login"]')).toBeNull();
  });

  it("keeps entry destinations stable and updates every CTA when a returning user is restored", async () => {
    await renderPage();
    auth.loading = false;
    auth.user = { id: "returning-user" };
    await renderPage();

    const entries = Array.from(container.querySelectorAll('a[href="/studio"]'));
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.textContent?.includes("Open Studio"))).toBe(true);
    expect(container.textContent).not.toContain("Get started");
  });

  it("lets Studio own sign-in routing after a signed-out session resolves", async () => {
    auth.loading = false;
    await renderPage();
    const entries = Array.from(container.querySelectorAll('a[href="/studio"]'));
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.textContent?.includes("Get started"))).toBe(true);
  });
});
