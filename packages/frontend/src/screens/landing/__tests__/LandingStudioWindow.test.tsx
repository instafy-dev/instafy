// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROTATE_INTERVAL_MS } from "../LandingSessionDeck";
import { TurnColumn } from "../LandingStudioWindow";
import { BEAT, SESSION_SCENARIOS, TURN_END_BEAT, TURN_END_MS } from "../landingTurnScript";

describe("landing studio window turn column", () => {
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
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(scenarioId: string, beat: number, playing: boolean) {
    const scenario = SESSION_SCENARIOS.find((entry) => entry.id === scenarioId)!;
    await act(async () => {
      root.render(<TurnColumn scenario={scenario} beat={beat} playing={playing} withTestIds />);
    });
    return scenario;
  }

  function all(selector: string) {
    return Array.from(container.querySelectorAll(selector));
  }

  // Every transient playback piece sits under an aria-hidden wrapper, and
  // nothing in the column is a control or a live region, at any beat.
  function expectPresentational() {
    const transient = all(
      '[data-testid="landing-typing-line"], [data-testid="landing-run-caption"], [data-testid="landing-run-chip"], [data-testid="landing-run-spinner"], [data-testid="landing-kim-typing"]',
    );
    expect(transient.length).toBeGreaterThan(0);
    expect(transient.every((node) => node.closest('[aria-hidden="true"]') !== null)).toBe(true);
    expect(all('a, button, input, [tabindex], [role="status"], [role="alert"], [aria-live]:not([aria-live="off"])')).toHaveLength(0);
  }

  // The finished frame is the point of the card, so the beat table may be
  // retimed freely as long as it leaves the completed turn on screen.
  it("rests on the finished turn for at least 3.5 s before rotation", () => {
    expect(ROTATE_INTERVAL_MS - TURN_END_MS).toBeGreaterThanOrEqual(3500);
  });

  it("renders the finished turn for every scenario with nothing in motion", async () => {
    for (const scenario of SESSION_SCENARIOS) {
      await render(scenario.id, TURN_END_BEAT, false);
      expect(all('[data-testid="landing-own-message"]')).toHaveLength(1);
      expect(container.querySelector('[data-testid="landing-own-message"]')?.textContent).toBe(scenario.prompt);
      expect(container.querySelector('[data-testid="landing-summary"]')?.textContent).toContain(scenario.summary);
      expect(container.textContent).toContain(scenario.opener);
      expect(container.textContent).toContain(scenario.reply);
      expect(all('[data-testid="landing-file-chip"]').map((chip) => chip.textContent)).toEqual(
        scenario.files.map((file) => `${file.path.slice(file.path.lastIndexOf("/") + 1)}+${file.added}${file.removed > 0 ? `-${file.removed}` : ""}`),
      );
      expect(all(".instafy-status-sweep")).toHaveLength(0);
      expect(all(".animate-spin")).toHaveLength(0);
      expect(all(".animate-pulse")).toHaveLength(0);
      expect(all(".instafy-compact-event-pill")).toHaveLength(0);
      expect(container.textContent).not.toContain("Kim is typing…");
      expect(all('[data-octo-motion="thinking"]')).toHaveLength(0);
      expect(all("[data-beat-visible]").every((node) => node.getAttribute("data-beat-visible") === "true")).toBe(true);
      expect(all('[data-testid="landing-run-chip"]').some((chip) => chip.classList.contains("invisible"))).toBe(false);
    }
  });

  it("opens each scenario's artifact where the app puts it", async () => {
    await render("code", TURN_END_BEAT, false);
    const card = container.querySelector('[data-testid="landing-diff-card"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("Updated");
    expect(card?.textContent).toContain("router.ts");
    const rows = all('[data-testid="landing-diff-row"]');
    expect(rows).toHaveLength(6);
    expect(rows.filter((row) => row.classList.contains("border-rose-400"))).toHaveLength(2);
    expect(rows.filter((row) => row.classList.contains("border-emerald-400"))).toHaveLength(2);
    const router = all('[data-testid="landing-file-chip"]').find((chip) => chip.textContent?.includes("router.ts"));
    expect(router?.textContent).toContain("+7");
    expect(router?.textContent).toContain("-9");
    expect(router?.className).toContain("border-primary-300/70");
    expect(container.querySelector('[data-testid="landing-code-block"]')).toBeNull();
    expect(container.querySelector('[data-testid="landing-browser-dock"]')).toBeNull();
    expect(container.querySelector("table")).toBeNull();

    await render("books", TURN_END_BEAT, false);
    expect(container.querySelector('[data-testid="landing-diff-card"]')).toBeNull();
    expect(container.querySelector('[data-testid="landing-browser-dock"]')).toBeNull();
    expect(container.querySelector('[data-testid="landing-code-block"]')?.textContent).toContain("214 of 217 rows matched");
    expect(container.querySelector("table")).toBeNull();

    await render("site", TURN_END_BEAT, false);
    expect(container.querySelector('[data-testid="landing-diff-card"]')).toBeNull();
    expect(container.querySelector('[data-testid="landing-code-block"]')).toBeNull();
    const dock = container.querySelector('[data-testid="landing-browser-dock"]');
    expect(dock).not.toBeNull();
    expect(dock?.textContent).toContain("Ready");
    expect(dock?.textContent).not.toContain("Starting…");
    expect(dock?.textContent).toContain("Room for your next idea.");
    expect(dock?.textContent).toContain("forma.site/pricing");
    // The browser session is an inline artifact of Octo's message, like the
    // diff card, not a panel parked under the whole conversation.
    const thread = container.querySelector('[data-testid="landing-octo-thread"]');
    expect(thread?.contains(dock!)).toBe(true);
    const reply = container.querySelector('[data-testid="landing-kim-reply"]');
    expect(thread?.contains(reply!)).toBe(false);
    expect(dock!.compareDocumentPosition(reply!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("draws the live run from the beat table", async () => {
    const scenario = await render("code", BEAT.STEP2, true);
    expectPresentational();
    expect(container.querySelector('[data-testid="landing-run-caption"]')?.textContent).toBe(scenario.steps[1].caption);
    expect(container.querySelector('[data-testid="landing-run-stop"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="landing-run-spinner"]')).not.toBeNull();
    const chips = all('[data-testid="landing-run-chip"]');
    expect(chips).toHaveLength(5);
    expect(chips.slice(0, 2).every((chip) => !chip.classList.contains("invisible"))).toBe(true);
    expect(chips.slice(2).every((chip) => chip.classList.contains("invisible"))).toBe(true);
    // While a command is in flight the spinner pill is the single live indicator.
    expect(chips.some((chip) => chip.classList.contains("instafy-compact-event-pill-live"))).toBe(false);
    expect(all('[data-octo-motion="thinking"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="landing-summary"]')?.getAttribute("data-beat-visible")).toBe("false");

    await render("code", BEAT.STEP4, true);
    expectPresentational();
    expect(container.querySelector('[data-testid="landing-owner-badge"]')?.textContent).toBe("canary");
    expect(container.querySelector('[data-testid="landing-run-caption"]')?.textContent).toBe(scenario.steps[3].caption);

    await render("site", BEAT.STEP4, true);
    expectPresentational();
    expect(container.querySelector('[data-testid="landing-owner-badge"]')?.textContent).toBe("pixel");
    expect(container.querySelector('[data-testid="landing-run-stop"]')).toBeNull();
    expect(container.querySelector('[data-testid="landing-run-spinner"]')).toBeNull();
    expect(all('[data-testid="landing-run-chip"]').filter((chip) => chip.classList.contains("instafy-compact-event-pill-live"))).toHaveLength(1);
    // The dock is laid out at final size from the first beat, holding the
    // Starting pill's width, but nothing in it is shown or turning yet.
    expect(container.querySelector('[data-testid="landing-browser-dock"]')?.getAttribute("data-beat-visible")).toBe("false");
    expect(container.querySelector('[data-testid="landing-browser-dock"]')?.textContent).toContain("Starting…");
    expect(all(".animate-spin")).toHaveLength(0);

    await render("site", BEAT.ARTIFACT, true);
    expectPresentational();
    // The page lands with Octo's other artifacts, already Ready, before Kim types.
    const dock = container.querySelector('[data-testid="landing-browser-dock"]');
    expect(dock?.getAttribute("data-beat-visible")).toBe("true");
    expect(dock?.textContent).toContain("Ready");
    expect(container.querySelector('[data-testid="landing-kim-typing"]')).toBeNull();

    await render("site", BEAT.STEP1, true);
    expectPresentational();
    expect(all('[data-testid="landing-run-chip"]').filter((chip) => chip.classList.contains("instafy-compact-event-pill-live"))).toHaveLength(1);
    expect(container.querySelector('[data-testid="landing-browser-dock"]')?.getAttribute("data-beat-visible")).toBe("false");
    expect(all(".animate-spin")).toHaveLength(0);

    await render("code", BEAT.THINKING, true);
    expectPresentational();
    expect(container.querySelector('[data-testid="landing-typing-line"]')?.textContent).toBe("Thinking…");
    expect(all(".instafy-status-sweep")).toHaveLength(1);

    await render("code", BEAT.REST, true);
    // Octo's row waits for Octo: the avatar and label fade in together at thinking.
    expect(container.querySelector('[data-testid="landing-octo-working"]')?.closest("[data-beat-visible]")?.getAttribute("data-beat-visible")).toBe("false");
    await render("code", BEAT.THINKING, true);
    expect(container.querySelector('[data-testid="landing-octo-working"]')?.closest("[data-beat-visible]")?.getAttribute("data-beat-visible")).toBe("true");

    // Kim waits for Octo: at the counts beat the artifact is still closed and
    // nobody is typing; the typing bubble gets its own beat after it lands.
    await render("code", BEAT.COUNTS, true);
    expectPresentational();
    expect(container.querySelector('[data-testid="landing-kim-typing"]')).toBeNull();
    expect(container.querySelector('[data-testid="landing-diff-card"]')?.closest("[data-beat-visible]")?.getAttribute("data-beat-visible")).toBe("false");
    expect(all('[data-octo-motion="thinking"]')).toHaveLength(0);

    await render("code", BEAT.KIM_TYPING, true);
    expectPresentational();
    expect(container.querySelector('[data-testid="landing-kim-typing"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="landing-diff-card"]')?.closest("[data-beat-visible]")?.getAttribute("data-beat-visible")).toBe("true");
    expect(all(".animate-pulse").length).toBeGreaterThan(0);
  });

  // The rail reserves one slot per step plus one for the in-flight spinner, so
  // it is the same width at every beat and the spinner never floats away from
  // the last drawn chip.
  it("keeps the run rail one width with the spinner next to the last chip", async () => {
    const slots = (): string[] =>
      Array.from(container.querySelector('[data-testid="landing-run-rail"]')?.children ?? []).map((node) =>
        node.getAttribute("data-testid") === "landing-run-spinner"
          ? "spinner"
          : node.classList.contains("invisible")
            ? "reserved"
            : "chip",
      );

    await render("code", BEAT.STEP2, true);
    expect(slots()).toEqual(["chip", "chip", "spinner", "reserved", "reserved", "reserved"]);

    await render("code", BEAT.STEP4, true);
    expect(slots()).toEqual(["chip", "chip", "chip", "chip", "spinner", "reserved"]);

    await render("code", BEAT.STEP3, true);
    expect(slots()).toEqual(["chip", "chip", "chip", "reserved", "reserved", "reserved"]);

    await render("code", TURN_END_BEAT, false);
    expect(slots()).toEqual(["chip", "chip", "chip", "chip", "chip", "reserved"]);
  });
});
