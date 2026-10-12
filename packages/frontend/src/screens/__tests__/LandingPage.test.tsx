// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../../theme/ThemeProvider";
import { LandingPage } from "../LandingPage";

const auth = vi.hoisted(() => ({ loading: true, user: null as { id: string } | null }));
vi.mock("../../providers/AuthProvider", () => ({ useAuth: () => auth }));

// The example window has its own selection, rotation and animation coverage
// (landing/__tests__); here it is a stub, while the chips and the shared state
// stay real so the hero's layout is what ships.
vi.mock("../landing/LandingSessionDeck", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../landing/LandingSessionDeck")>();
  return {
    ...actual,
    LandingSessionDeck: ({ joinToFor }: { joinToFor: (scenario: { id: string }) => string }) => (
      <div data-testid="landing-session-deck-root">
        <div data-testid="landing-session-deck" />
        <a data-testid="example-entry" href={joinToFor({ id: "code" })}>Start a session</a>
      </div>
    ),
  };
});

// Cub's WebGL engine is a lazily imported chunk (jsdom has no WebGL); the
// host stays real so the hero's layering is what ships.
const cub = vi.hoisted(() => ({ imported: 0, mount: vi.fn() }));
vi.mock("../landing/cub/landingCub", () => {
  cub.imported++;
  return { mountLandingCub: cub.mount };
});

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
    cub.imported = 0;
    cub.mount.mockReset();
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })),
    );
    // Hold the browser's paint and idle callbacks, so the engine never loads here.
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderPage() {
    await act(async () =>
      root.render(
        <ThemeProvider>
          <MemoryRouter>
            <LandingPage />
          </MemoryRouter>
        </ThemeProvider>,
      ),
    );
  }

  it("renders public content immediately while a saved session is still being restored", async () => {
    await renderPage();
    expect(container.querySelector("h1")?.textContent).toContain("Good work");
    expect(container.textContent).not.toContain("Loading Instafy");
    expect(container.querySelector('[data-testid="landing-get-started-button"]')?.getAttribute("href")).toBe("/studio");
    expect(container.querySelector('[data-testid="example-entry"]')?.getAttribute("href")).toBe("/studio?from=landing-code");
    expect(container.querySelector('a[href^="/login"]')).toBeNull();
  });

  // Google brand verification requires the home page to say why user data is
  // requested and to link the privacy policy.
  it("states the sign-in data use next to the entry and links privacy and terms", async () => {
    await renderPage();
    const note = container.querySelector('[data-testid="landing-sign-in-data-note"]');
    expect(note?.textContent).toContain("Instafy uses only your name, email address, and profile");
    expect(note?.querySelector('a[href="/privacy"]')?.textContent).toBe("Privacy Policy");
    expect(note?.querySelector('a[href="/terms"]')?.textContent).toBe("Terms");
  });

  it("sets an all-ink headline on paper with the dot grid, no eyebrow line and no artwork", async () => {
    await renderPage();
    const page = container.querySelector('[data-testid="landing-page"]') as HTMLElement;
    expect(page.className).toContain("bg-[var(--marketing-canvas)]");
    // The document takes the same paper so overscroll matches the page.
    expect(document.documentElement.classList.contains("marketing-canvas")).toBe(true);

    const heading = container.querySelector('[data-testid="landing-hero-heading"]') as HTMLElement;
    expect(heading.tagName).toBe("H1");
    expect(heading.textContent).toBe("Good work has company.");
    expect(heading.className).toContain("text-brand-ink");
    expect(heading.querySelector("[class*='text-primary']")).toBeNull();
    expect(container.textContent).not.toContain("A shared studio for people and AI");
    expect(heading.previousElementSibling).toBeNull();

    // The hero section names only the hero; site navigation keeps its banner
    // landmark outside <main>.
    const hero = container.querySelector('section[aria-labelledby="landing-title"]') as HTMLElement;
    expect(hero.getAttribute("data-testid")).toBe("landing-hero");
    expect(hero.contains(heading)).toBe(true);
    expect(hero.querySelector('[data-testid="landing-launch-button"]')).toBeNull();
    expect(container.querySelector("main header")).toBeNull();
    expect(container.querySelector("header [data-testid='landing-launch-button']")).not.toBeNull();
    expect(container.querySelector("main")?.contains(hero)).toBe(true);

    // The hero is its own clipped stacking context, and the grid is its first,
    // decorative layer behind everything else.
    for (const name of ["relative", "isolate", "overflow-hidden"]) {
      expect(hero.classList.contains(name)).toBe(true);
    }
    const grid = hero.querySelector('[data-testid="landing-dot-grid"]') as HTMLElement;
    expect(hero.firstElementChild).toBe(grid);
    expect(grid.getAttribute("aria-hidden")).toBe("true");
    for (const name of ["marketing-dot-grid", "pointer-events-none", "absolute", "inset-0", "z-0"]) {
      expect(grid.classList.contains(name)).toBe(true);
    }

    // The grid carries the paper itself, so Cub's light ink multiplies with
    // it inside the hero's stacking context.
    expect(grid.classList.contains("bg-[var(--marketing-canvas)]")).toBe(true);

    // Cub's layer comes right after the grid: empty until his engine loads
    // (after the first paint and an idle moment, never with the page), inert,
    // and with no z-index of its own (his canvases sit above the content at
    // z-index 3, under the window's roster).
    const layer = grid.nextElementSibling as HTMLElement;
    expect(layer.getAttribute("data-testid")).toBe("landing-cub-layer");
    expect(layer.getAttribute("aria-hidden")).toBe("true");
    expect(layer.childElementCount).toBe(0);
    for (const name of ["pointer-events-none", "absolute", "inset-0"]) {
      expect(layer.classList.contains(name)).toBe(true);
    }
    expect(Array.from(layer.classList).some((name) => /^z-/.test(name))).toBe(false);
    expect(cub.imported).toBe(0);
    expect(cub.mount).not.toHaveBeenCalled();

    // The tentacle artwork and its presence cursors are gone.
    expect(container.querySelector('[data-testid="landing-tentacle-scene"]')).toBeNull();
    expect(container.querySelector("[class*='landing-tentacles']")).toBeNull();
    expect(container.querySelector("[class*='mask-image']")).toBeNull();
    expect(container.querySelector("span[style*='background-color']")).toBeNull();
  });

  it("stacks the copy, entries and chips on the left and keeps an empty cell for the hero's creature", async () => {
    await renderPage();
    const hero = container.querySelector('[data-testid="landing-hero"]') as HTMLElement;
    const heading = container.querySelector('[data-testid="landing-hero-heading"]') as HTMLElement;
    const copy = heading.parentElement as HTMLElement;
    const grid = copy.parentElement as HTMLElement;
    expect(copy.querySelector('[data-testid="landing-get-started-button"]')).not.toBeNull();
    const install = copy.querySelector('[data-testid="landing-install-button"]') as HTMLAnchorElement;
    expect(install.getAttribute("href")).toBe("/install");
    expect(install.className).toContain("border");
    expect(install.className).toContain("bg-white");

    // The chips sit in the hero with the entries, after the copy and before
    // the window: under the buttons, and beside them from 1184px. The copy and
    // the entries' row lay their children straight into the grid on phones.
    const chips = hero.querySelector('[data-testid="landing-scenario-chips"]') as HTMLElement;
    expect(chips.getAttribute("role")).toBe("group");
    expect(chips.getAttribute("aria-label")).toBe("Choose a workspace example");
    const entries = hero.querySelector('[data-testid="landing-entries-row"]') as HTMLElement;
    expect(chips.parentElement).toBe(entries);
    expect(entries.parentElement).toBe(copy);
    expect(copy.className).toContain("contents");
    expect(entries.className).toContain("contents");
    expect(entries.className).toContain("min-[74rem]:flex-row");
    expect(chips.className).toContain("col-start-1");
    expect(Array.from(chips.querySelectorAll("button"), (chip) => chip.textContent)).toEqual([
      "Close the books",
      "Build a feature",
      "Launch a site",
    ]);
    expect(chips.querySelector('[aria-pressed="true"]')?.textContent).toBe("Close the books");
    const deckRoot = hero.querySelector('[data-testid="landing-session-deck-root"]') as HTMLElement;
    expect(deckRoot.contains(chips)).toBe(false);
    expect(copy.compareDocumentPosition(chips) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(chips.compareDocumentPosition(deckRoot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // The open cell: in the hero grid, reserved space only.
    const zone = hero.querySelector('[data-testid="landing-cub-zone"]') as HTMLElement;
    expect(zone.parentElement).toBe(grid);
    expect(zone.getAttribute("aria-hidden")).toBe("true");
    expect(zone.childElementCount).toBe(0);
    expect(zone.textContent).toBe("");
    expect(zone.className).toContain("min-h-[150px]");
    expect(zone.className).toContain("md:min-h-[200px]");
    // The chips' row runs into the empty cell from 1184px; the cell takes no pointer.
    expect(zone.className).toContain("pointer-events-none");

    // Cub reads the hero through data-cub-anchor attributes.
    expect(hero.getAttribute("data-cub-anchor")).toBe("hero");
    expect(heading.getAttribute("data-cub-anchor")).toBe("headline");
    expect(heading.nextElementSibling?.getAttribute("data-cub-anchor")).toBe("sub");
    expect(copy.querySelector('[data-testid="landing-get-started-button"]')?.getAttribute("data-cub-anchor")).toBe("cta");
    expect(install.getAttribute("data-cub-anchor")).toBe("cta-secondary");
    expect(chips.getAttribute("data-cub-anchor")).toBe("chips");
    expect(zone.getAttribute("data-cub-anchor")).toBe("zone");
  });

  it("puts the header on the paper with no bar and the crew lockup", async () => {
    await renderPage();
    const header = container.querySelector("header") as HTMLElement;
    for (let node: HTMLElement | null = header; node && node !== container; node = node.parentElement) {
      expect(node.className).not.toMatch(/backdrop-blur|bg-white\/|bg-black\//);
    }
    const mark = header.querySelector("svg.octo-mark") as SVGSVGElement;
    expect(mark.getAttribute("data-octo-colorway")).toBe("crew-hidpi");
    // The approved lockup: a 30px mark (28px on phones) and a bold 20px wordmark.
    for (const name of ["h-7", "md:h-[30px]", "md:w-[30px]"]) expect(mark.classList.contains(name)).toBe(true);
    const word = mark.nextElementSibling as HTMLElement;
    expect(word.textContent).toBe("Instafy");
    for (const name of ["font-bold", "md:text-[20px]"]) expect(word.classList.contains(name)).toBe(true);
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
