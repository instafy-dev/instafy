// @vitest-environment jsdom

import { act, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LandingPage } from "../LandingPage";

const auth = vi.hoisted(() => ({ loading: true, user: null as { id: string } | null }));
vi.mock("../../providers/AuthProvider", () => ({ useAuth: () => auth }));

// The demo has its own selection, rotation and animation coverage.
vi.mock("../landing/LandingSessionDeck", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../landing/LandingSessionDeck")>();
  return {
    SESSION_SCENARIOS: actual.SESSION_SCENARIOS,
    LandingSessionDeck: ({ joinToFor, ref }: { joinToFor: (scenario: { id: string }) => string; ref?: Ref<HTMLDivElement> }) => (
      <div ref={ref} data-testid="landing-session-deck-root">
        <a data-testid="example-entry" href={joinToFor({ id: "code" })}>Start a session</a>
      </div>
    ),
  };
});

// The tentacle artwork is 1536x1024; a scene box of the same size makes the
// image-space cursor anchors project one-to-one.
const SCENE_WIDTH = 1536;
const SCENE_HEIGHT = 1024;

describe("LandingPage entry", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    auth.loading = true;
    auth.user = null;
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(SCENE_WIDTH);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(SCENE_HEIGHT);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
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

  it("keeps the headline over the tentacle scene without an eyebrow line", async () => {
    await renderPage();
    const heading = container.querySelector('[data-testid="landing-hero-heading"]');
    expect(heading?.tagName).toBe("H1");
    expect(heading?.textContent).toBe("Good workhas company.");
    expect(container.textContent).not.toContain("A shared studio for people and AI");
    expect(container.querySelector("h1")?.previousElementSibling).toBeNull();

    const scene = container.querySelector('[data-testid="landing-tentacle-scene"]');
    expect(scene).not.toBeNull();
    expect(scene?.getAttribute("aria-hidden")).toBe("true");
    // The scene box is a viewport-sized wrapper, not the whole hero section,
    // so the cover crop and cursor anchors match the composition.
    const sceneBox = scene?.parentElement as HTMLElement;
    expect(sceneBox.tagName).toBe("DIV");
    expect(sceneBox.className).toContain("h-[max(60rem,min(100dvh,72rem))]");
    const host = sceneBox.parentElement as HTMLElement;
    expect(host.contains(heading)).toBe(true);
    expect(scene!.compareDocumentPosition(heading!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // The hero section names only the hero; site navigation keeps its banner
    // landmark outside <main>.
    const hero = container.querySelector('section[aria-labelledby="landing-title"]') as HTMLElement;
    expect(hero.contains(heading)).toBe(true);
    expect(hero.querySelector('[data-testid="landing-launch-button"]')).toBeNull();
    expect(container.querySelector("main header")).toBeNull();
    expect(container.querySelector("header [data-testid='landing-launch-button']")).not.toBeNull();
    expect(container.querySelector("main")?.contains(heading)).toBe(true);
    expect(scene?.querySelector("[class*='landing-tentacles.jpg']")).not.toBeNull();
    expect(scene?.querySelector("[class*='landing-tentacles-dark.jpg']")).not.toBeNull();
    expect(scene?.querySelector("[class*='mask-image']")).not.toBeNull();

    const pills = Array.from(scene?.querySelectorAll("span[style*='background-color']") ?? []) as HTMLElement[];
    const crew = new Map(pills.map((pill) => [pill.textContent, pill.style.backgroundColor]));
    expect(crew.get("Ada")).toBe("rgb(233, 61, 130)");
    expect(crew.get("Kim")).toBe("rgb(140, 185, 59)");
    expect(crew.get("Octo · agent")).toBe("rgb(245, 150, 10)");
    // The purple cursor follows the active scenario's agent, and the deck now
    // leads with Close the books.
    expect(crew.get("Quill · agent")).toBe("rgb(124, 77, 216)");
    expect(pills).toHaveLength(4);
  });

  it("drops presence cursors that would sit behind the workspace demo card", async () => {
    // Deck card covering the lower middle of the 1536x1024 scene: Kim
    // (1300,880) and the purple agent (260,700) project under it, Ada
    // (1210,300) and Octo (285,150) stay clear.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const covered = this.dataset?.testid === "landing-session-deck-root";
      const rect = covered
        ? { left: 100, top: 400, right: 1400, bottom: 1000 }
        : { left: 0, top: 0, right: 0, bottom: 0 };
      return {
        ...rect,
        x: rect.left,
        y: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
        toJSON: () => rect,
      } as DOMRect;
    });
    await renderPage();
    const scene = container.querySelector('[data-testid="landing-tentacle-scene"]');
    const pills = Array.from(scene?.querySelectorAll("span[style*='background-color']") ?? []) as HTMLElement[];
    expect(pills.map((pill) => pill.textContent).sort()).toEqual(["Ada", "Octo · agent"]);
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
