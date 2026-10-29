// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROTATE_INTERVAL_MS, rotateIntervalFor } from "../LandingSessionDeck";
import { RailExpanded, RosterStack, TurnColumn, transcriptScrollOffset } from "../LandingStudioWindow";
import {
  BEAT,
  BROWSER_TURN,
  SESSION_SCENARIOS,
  TURN_END_BEAT,
  TURN_END_MS,
  beatIndex,
  browserContinuation,
  finishedBeat,
  turnEndBeat,
  turnPlanFor,
  type TurnBeatId,
} from "../landingTurnScript";
import {
  classTokens,
  expectAiTile,
  expectAvatarCoinLightEdge,
  expectCanonicalOctoCoin,
  expectPersonCircle,
} from "../../../components/__tests__/octoCoinExpectations";

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

  async function render(scenarioId: string, beat: number | TurnBeatId, playing: boolean) {
    const scenario = SESSION_SCENARIOS.find((entry) => entry.id === scenarioId)!;
    if (typeof beat === "string") beat = beatIndex(scenario, beat);
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
      '[data-testid="landing-run-line"], [data-testid="landing-kim-typing"], [data-testid="landing-browse-line"]',
    );
    expect(transient.length).toBeGreaterThan(0);
    expect(transient.every((node) => node.closest('[aria-hidden="true"]') !== null)).toBe(true);
    expect(all('a, button, input, [tabindex], [role="status"], [role="alert"], [aria-live]:not([aria-live="off"])')).toHaveLength(0);
  }

  // The finished frame is the point of the card, so the beat table may be
  // retimed freely as long as it leaves the completed turn on screen.
  it("rests on the finished turn for at least 3.5 s before rotation", () => {
    expect(ROTATE_INTERVAL_MS - TURN_END_MS).toBeGreaterThanOrEqual(3500);
    for (const scenario of SESSION_SCENARIOS) {
      const plan = turnPlanFor(scenario);
      const reply = plan.beats[beatIndex(scenario, "reply")].atMs;
      expect(rotateIntervalFor(scenario) - reply).toBeGreaterThanOrEqual(3500);
      // Everything lands before the deck moves on.
      expect(plan.beats[plan.beats.length - 1].atMs).toBeLessThan(plan.dwellMs);
    }
  });

  it("keeps every scenario's beats in order, sharing the workspace turn up to its artifact", () => {
    for (const scenario of SESSION_SCENARIOS) {
      const { beats } = turnPlanFor(scenario);
      for (let i = 1; i < beats.length; i++) expect(beats[i].atMs).toBeGreaterThan(beats[i - 1].atMs);
      expect(new Set(beats.map((entry) => entry.id)).size).toBe(beats.length);
      // Octo's workspace run (and Cub's lent arm with it) keeps one clock in every scenario.
      expect(beats.slice(0, BEAT.ARTIFACT + 1)).toEqual(turnPlanFor(SESSION_SCENARIOS[0]).beats.slice(0, BEAT.ARTIFACT + 1));
      // Kim answers last, once Octo's message is complete.
      expect(beatIndex(scenario, "kimTyping")).toBeGreaterThan(BEAT.ARTIFACT);
      expect(beatIndex(scenario, "reply")).toBe(beatIndex(scenario, "kimTyping") + 1);
    }
    expect(BROWSER_TURN.beats.slice(BEAT.ARTIFACT + 1).map((entry) => entry.id)).toEqual([
      "tap",
      "press",
      "handoff",
      "browse",
      "approve",
      "allowPress",
      "allowed",
      "navigate",
      "loaded",
      "scroll",
      "click",
      "browseDone",
      "kimTyping",
      "reply",
      "settle",
    ]);
    // Octo's cursor lingers 4 s after its click before it fades (BrowserCursorOverlay.tsx).
    const site = SESSION_SCENARIOS[2];
    const atMs = (id: Parameters<typeof beatIndex>[1]) => BROWSER_TURN.beats[beatIndex(site, id)].atMs;
    // The request card is on screen long enough to read before Ada presses it,
    // her press shows going down before the browser opens, and the site
    // approval stays up long enough to read.
    expect(atMs("tap") - atMs("artifact")).toBeGreaterThanOrEqual(1200);
    expect(atMs("press") - atMs("tap")).toBeGreaterThanOrEqual(250);
    expect(atMs("handoff") - atMs("press")).toBeGreaterThanOrEqual(800);
    expect(atMs("allowed") - atMs("approve")).toBeGreaterThanOrEqual(1600);
    // The prompt is up long enough to read before Ada presses Allow site.
    expect(atMs("allowPress") - atMs("approve")).toBeGreaterThanOrEqual(1500);
    // Each ticker caption Octo's browser work shows is up long enough to read.
    expect(atMs("loaded") - atMs("navigate")).toBeGreaterThanOrEqual(1100);
    expect(atMs("scroll") - atMs("loaded")).toBeGreaterThanOrEqual(1100);
    expect(atMs("click") - atMs("scroll")).toBeGreaterThanOrEqual(1100);
    expect(atMs("settle") - atMs("click")).toBe(4000);
    // The finished frame (Kim's reply) is inside the cursor's linger.
    expect(BROWSER_TURN.beats[finishedBeat(site)].id).toBe("reply");
    expect(atMs("reply") - atMs("click")).toBeLessThan(4000);
    expect(turnPlanFor(SESSION_SCENARIOS[0])).not.toBe(BROWSER_TURN);
    expect(turnPlanFor(site)).toBe(BROWSER_TURN);
  });

  it("scrolls the transcript only once its newest message outgrows it", () => {
    expect(transcriptScrollOffset(420, 596)).toBe(0);
    expect(transcriptScrollOffset(596, 596)).toBe(0);
    expect(transcriptScrollOffset(760.4, 596)).toBe(164);
  });

  it("renders the finished turn for every scenario with nothing in motion", async () => {
    for (const scenario of SESSION_SCENARIOS) {
      await render(scenario.id, finishedBeat(scenario), false);
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
      // The finished line says what the run did, with Details beside it.
      expect(container.querySelector('[data-testid="landing-run-line"]')?.textContent).toBe(scenario.activity);
      expect(container.querySelector('[data-testid="landing-run-line"]')?.parentElement?.textContent).toContain("Details");
    }
  });

  it("opens each scenario's result in Octo's message the way the app draws it", async () => {
    await render("code", "reply", false);
    const card = container.querySelector('[data-testid="landing-diff-card"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("Updated");
    expect(card?.textContent).toContain("router.ts");
    const rows = all('[data-testid="landing-diff-row"]');
    expect(rows).toHaveLength(6);
    expect(rows.filter((row) => row.classList.contains("border-rose-400"))).toHaveLength(2);
    expect(rows.filter((row) => row.classList.contains("border-emerald-400"))).toHaveLength(2);
    const router = all('[data-testid="landing-file-chip"]').find((chip) => chip.textContent?.includes("router.ts"));
    expect(router?.textContent).toContain("+2");
    expect(router?.textContent).toContain("-2");
    expect(router?.className).toContain("border-primary-300/70");
    // The test run shows as the studio shows a command: its text, here quoted in the summary.
    expect(container.querySelector('[data-testid="landing-summary"] code')?.textContent).toBe("pnpm test --filter payments");
    expect(container.querySelector('[data-testid="landing-summary"]')?.textContent).toContain("12 passed");
    expect(container.querySelector('[data-testid="landing-browser-request"]')).toBeNull();
    expect(container.querySelector("table")).toBeNull();

    // A .csv has no table preview: its card lists every row as added.
    await render("books", "reply", false);
    const books = container.querySelector('[data-testid="landing-diff-card"]');
    expect(books?.getAttribute("data-change")).toBe("created");
    expect(books?.textContent).toContain("Created");
    expect(books?.textContent).toContain("2026-02-review.csv");
    const bookRows = all('[data-testid="landing-diff-row"]');
    expect(bookRows.map((row) => row.textContent)).toEqual([
      "+date,description,amount,note",
      "+2026-02-04,Acme AB,-2140.00,duplicate?",
      "+2026-02-11,Linear seat,-89.90,receipt?",
      "+2026-02-19,Bank charge,-12.00,category?",
    ]);
    expect(bookRows.every((row) => row.classList.contains("border-emerald-400"))).toBe(true);
    // Every row reads whole at phone width (40 mono characters).
    expect(bookRows.every((row) => (row.textContent ?? "").length <= 40)).toBe(true);
    const reference = container.querySelector('[data-testid="landing-file-reference"]');
    expect(reference?.textContent).toBe("ledger/2026-02-review.csv:2");
    expect(reference?.getAttribute("data-open")).toBe("true");
    expect(container.querySelector('[data-testid="landing-code-block"]')).toBeNull();
    expect(container.querySelector("table")).toBeNull();

    // Launching a site ends Octo's run with the preview link and the browser
    // request; Ada's press sends the continuation and Octo's browser run follows.
    await render("site", "settle", false);
    const site = SESSION_SCENARIOS[2];
    expect(container.querySelector('[data-testid="landing-diff-card"]')).toBeNull();
    expect(container.querySelector('[data-testid="landing-message-link"]')?.textContent).toBe(site.browser!.url);
    const request = container.querySelector('[data-testid="landing-browser-request"]');
    expect(request?.textContent).toContain("Continue in browser");
    expect(request?.textContent).toContain("Open your browser and let the AI continue this task there.");
    expect(request?.textContent).toContain("Open browser and continue");
    const thread = container.querySelector('[data-testid="landing-octo-thread"]');
    expect(thread?.contains(request!)).toBe(true);
    expect(container.querySelector('[data-testid="landing-continuation"]')?.textContent).toBe(browserContinuation(site.browser!.task));
    expect(container.querySelector('[data-testid="landing-browse-summary"]')?.textContent).toContain(site.browser!.summary);
    expect(container.querySelector('[data-testid="landing-browse-line"]')?.textContent).toBe(site.browser!.activity);
    // The browser itself is never drawn inside the conversation.
    expect(container.querySelector('[data-testid="landing-browser-dock"]')).toBeNull();
    const reply = container.querySelector('[data-testid="landing-kim-reply"]');
    expect(container.querySelector('[data-testid="landing-browse-thread"]')!.compareDocumentPosition(reply!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows Ada's pointer on the file reference before her click opens it beside the chat, in a split only", async () => {
    const scenario = SESSION_SCENARIOS[0];
    const open = async (beat: number, split: boolean) => {
      await act(async () => {
        root.render(<TurnColumn scenario={scenario} beat={beat} playing withTestIds split={split} />);
      });
      return container.querySelector('[data-testid="landing-file-reference"]')?.getAttribute("data-open");
    };
    expect(await open(BEAT.FILES, true)).toBe("false");
    // The counts beat is 400 ms before the artifact beat opens the file.
    expect(await open(BEAT.COUNTS, true)).toBe("true");
    expect(await open(BEAT.ARTIFACT, true)).toBe("true");
    // One view keeps the chat in front: nobody clicks the reference there.
    expect(await open(BEAT.ARTIFACT, false)).toBe("false");
  });

  it("never promises what the studio does not do", () => {
    const copy = JSON.stringify(SESSION_SCENARIOS);
    // No deploy (a tunnel preview link instead), no device viewport, no visible Ready.
    expect(copy).not.toContain("forma.site/pricing");
    expect(copy).not.toMatch(/390 wide|\bReady\b/);
    expect(SESSION_SCENARIOS[2].browser!.url).toMatch(/^https:\/\/[a-z0-9]+\.instafy\.site\//);
    // The activity line shows what the studio's line shows: a step's own
    // label, "Thinking…" or "Waiting for you", never a command's text or
    // "Calling tool…", which the studio retired.
    for (const steps of [...SESSION_SCENARIOS.map((scenario) => scenario.steps), SESSION_SCENARIOS[2].browser!.steps]) {
      for (const step of steps) {
        expect(step.live).toMatch(/^(?:[A-Z][a-z]+(?: [a-z0-9.-]+)*…|Waiting for you)$/u);
        expect(step.live).not.toMatch(/Calling tool|Running command|pnpm|python|instafy /u);
      }
    }
  });

  it("pops Octo's message avatar once as the result lands, only while the turn plays", async () => {
    const popped = () => container.querySelector('[data-testid="landing-octo-working"]')?.hasAttribute("data-landing-octo-pop");
    await render("books", BEAT.STEP5, true);
    expect(popped()).toBe(false);
    await render("books", BEAT.DONE, true);
    expect(popped()).toBe(true);
    // The finished frame (reduced motion, offscreen, a hidden tab) never pops.
    await render("books", TURN_END_BEAT, false);
    expect(popped()).toBe(false);
  });

  it("draws Octo's message avatar as its coin, lifted over the thread spine", async () => {
    await render("books", BEAT.DONE, true);
    const face = container.querySelector('[data-testid="landing-octo-working"]');
    // The pop lands on the coin itself, and the coin is the studio's.
    expectCanonicalOctoCoin(face);
    expect(face?.hasAttribute("data-landing-octo-pop")).toBe(true);
    // The spine runs up into the avatar; the avatar's slot sits above it (as
    // the studio's agent-job-thread-avatar does), so it never cuts the ring.
    const slot = face?.closest("[data-beat-visible]");
    expect(slot?.classList.contains("relative")).toBe(true);
    expect(slot?.classList.contains("z-10")).toBe(true);
  });

  it("draws the live run from the beat table", async () => {
    const line = () => container.querySelector('[data-testid="landing-run-line"]')?.textContent;
    const scenario = await render("code", BEAT.STEP2, true);
    expectPresentational();
    // One line names the running step; no chips, no command text, no spinner.
    expect(line()).toBe(scenario.steps[1].live);
    expect(line()).toBe("Running tests…");
    expect(all(".instafy-compact-event-pill")).toHaveLength(0);
    expect(all(".animate-spin")).toHaveLength(0);
    expect(all(".instafy-status-sweep")).toHaveLength(1);
    expect(all('[data-octo-motion="thinking"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="landing-summary"]')?.getAttribute("data-beat-visible")).toBe("false");
    expect(container.textContent).not.toContain("Details");

    // A plan update is no step: between steps the line says Thinking….
    await render("code", BEAT.STEP3, true);
    expect(line()).toBe("Thinking…");

    await render("code", BEAT.STEP4, true);
    expectPresentational();
    expect(line()).toBe(scenario.steps[3].live);

    await render("site", BEAT.STEP4, true);
    expectPresentational();
    expect(line()).toBe("Editing files…");
    // The browser request is laid out at final size, but not shown yet.
    expect(container.querySelector('[data-testid="landing-browser-request"]')?.closest("[data-beat-visible]")?.getAttribute("data-beat-visible")).toBe("false");

    await render("site", BEAT.STEP5, true);
    // The tunnel's own label, never the command.
    expect(line()).toBe("Making a public link…");
    expect(container.textContent).not.toContain("instafy tunnel start");

    await render("site", BEAT.ARTIFACT, true);
    expectPresentational();
    expect(line()).toBe(SESSION_SCENARIOS[2].activity);
    // The request lands with the rest of Octo's message, before anyone presses it.
    expect(container.querySelector('[data-testid="landing-browser-request"]')?.closest("[data-beat-visible]")?.getAttribute("data-beat-visible")).toBe("true");
    expect(container.querySelector('[data-testid="landing-browser-request-button"]')?.getAttribute("data-busy")).toBe("false");
    expect(container.querySelector('[data-testid="landing-kim-typing"]')).toBeNull();

    await render("site", "tap", true);
    // Ada's press goes down on the button (Button.tsx's pressed state) before it opens anything.
    let button = container.querySelector('[data-testid="landing-browser-request-button"]');
    expect(button?.getAttribute("data-pressed")).toBe("true");
    expect(button?.getAttribute("data-busy")).toBe("false");
    expect(button?.className).toContain("scale-[0.98]");
    expect(button?.textContent).toBe("Open browser and continue");

    await render("site", "press", true);
    button = container.querySelector('[data-testid="landing-browser-request-button"]');
    expect(button?.getAttribute("data-pressed")).toBe("false");
    expect(button?.getAttribute("data-busy")).toBe("true");
    expect(button?.textContent).toBe("Opening browser…");
    expect(button?.querySelector(".animate-spin")).not.toBeNull();

    const browseLine = () => container.querySelector('[data-testid="landing-browse-line"]')?.textContent;
    await render("site", "browse", true);
    expect(browseLine()).toBe("Thinking…");

    // Octo's browser run waits on Ada while the site prompt is up, then
    // names each step and the preview's site.
    await render("site", "approve", true);
    expectPresentational();
    expect(browseLine()).toBe("Waiting for you");
    expect(all('[data-octo-motion="thinking"]')).toHaveLength(1);
    await render("site", "navigate", true);
    expect(browseLine()).toBe("Opening k7m2qa.instafy.site…");
    await render("site", "loaded", true);
    expect(browseLine()).toBe("Reading k7m2qa.instafy.site…");
    await render("site", "click", true);
    expect(browseLine()).toBe("Browsing k7m2qa.instafy.site…");
    await render("site", "browseDone", true);
    expect(browseLine()).toBe(SESSION_SCENARIOS[2].browser!.activity);

    await render("site", BEAT.STEP1, true);
    expectPresentational();
    expect(line()).toBe("Editing files…");
    expect(container.querySelector('[data-testid="landing-continuation"]')?.closest("[data-beat-visible]")?.getAttribute("data-beat-visible")).toBe("false");
    expect(all(".animate-spin")).toHaveLength(0);

    await render("code", BEAT.THINKING, true);
    expectPresentational();
    expect(line()).toBe("Thinking…");
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

    await render("code", "kimTyping", true);
    expectPresentational();
    expect(container.querySelector('[data-testid="landing-kim-typing"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="landing-diff-card"]')?.closest("[data-beat-visible]")?.getAttribute("data-beat-visible")).toBe("true");
    expect(all(".animate-pulse").length).toBeGreaterThan(0);
  });

  // Crew colours follow roster order (pink Ada, green Kim, flame agent) with
  // the label colour that reads on each fill; Octo stays ink on its own coin.
  it("paints the crew in roster order and keeps Octo ink", async () => {
    const scenario = SESSION_SCENARIOS[0];
    await act(async () => {
      root.render(
        <>
          <RailExpanded scenarios={SESSION_SCENARIOS} active={0} runLive={false} />
          <RosterStack scenario={scenario} agentVisible />
        </>,
      );
    });
    const coin = (name: string) => container.querySelector(`[data-roster-coin="${name}"]`) as HTMLElement;
    expect(Array.from(container.querySelectorAll("[data-roster-coin]"), (node) => node.getAttribute("data-roster-coin"))).toEqual([
      "ada",
      "kim",
      "octo",
      "agent",
    ]);

    const ada = coin("ada").querySelector("[data-crew-fill]") as HTMLElement;
    expect(ada.textContent).toBe("A");
    expect(ada.style.backgroundColor).toBe("rgb(255, 60, 159)");
    expect(ada.style.color).toBe("rgb(15, 23, 42)");
    const kim = coin("kim").querySelector("[data-crew-fill]") as HTMLElement;
    expect(kim.style.backgroundColor).toBe("rgb(27, 134, 75)");
    expect(kim.style.color).toBe("rgb(255, 255, 255)");
    // The scenario agent: a flame AI tile with its ink initial, never Octo's mark in a crew colour.
    const agent = coin("agent").querySelector("[data-crew-fill]") as HTMLElement;
    expect(agent.textContent).toBe(scenario.presenceAgent.charAt(0));
    expect(agent.style.backgroundColor).toBe("rgb(250, 88, 21)");
    expect(agent.style.color).toBe("rgb(15, 23, 42)");
    expect(coin("agent").getAttribute("data-agent-name")).toBe(scenario.presenceAgent);
    expect(coin("agent").querySelector("svg.octo-mark")).toBeNull();

    // One rule for faces: people are circles, every AI (Octo included) is the
    // AI tile, and each face's separator ring takes its face's shape.
    for (const person of [ada, kim]) {
      expectPersonCircle(person);
      expect(person.parentElement?.className).toContain("rounded-full");
    }
    const agentTokens = expectAiTile(agent);
    for (const name of ["octo", "agent"]) {
      const ring = classTokens(coin(name));
      expect(ring).toEqual(expect.arrayContaining(["rounded-[30%]", "ring-1"]));
      expect(ring).not.toContain("rounded-full");
    }

    // Every roster coin shares one light edge, the avatar coin shadow (no
    // grey border). People keep their hairline border and small shadow in
    // dark; the agent's only dark edge is the AI tile's own hairline, as in
    // the studio.
    for (const fill of [ada, kim, agent]) expectAvatarCoinLightEdge(fill);
    for (const person of [ada, kim]) {
      expect(classTokens(person)).toEqual(expect.arrayContaining(["dark:border", "dark:shadow-sm"]));
    }
    expect(agentTokens.filter((token) => /^dark:(border|shadow)/.test(token))).toEqual([]);

    // Octo: the studio's own tile (white with the shared coin shadow and the
    // AI tile's hairline, reversed in dark), no crew fill, tint or nodes.
    const octo = coin("octo");
    expect(octo.getAttribute("data-testid")).toBe("landing-roster-octo");
    expect(octo.querySelector("[data-crew-fill]")).toBeNull();
    expect(octo.querySelector("[style]")).toBeNull();
    expectCanonicalOctoCoin(octo.querySelector(":scope > [data-octo-coin]"));

    // Ada's profile avatar in the rail matches her roster coin.
    const profile = container.querySelector('[data-testid="landing-rail"] span[style]') as HTMLElement;
    expect(profile.textContent).toBe("A");
    expect(profile.style.backgroundColor).toBe("rgb(255, 60, 159)");
    expect(profile.style.color).toBe("rgb(15, 23, 42)");
    expect(expectAvatarCoinLightEdge(profile)).toContain("dark:border");
    expectPersonCircle(profile);

    // None of the retired palette survives.
    const html = container.innerHTML;
    for (const retired of ["233, 61, 130", "140, 185, 59", "124, 77, 216", "245, 150, 10"]) {
      expect(html).not.toContain(retired);
    }
  });

  it("keeps Kim green with a white label in the transcript", async () => {
    await render("site", turnEndBeat(SESSION_SCENARIOS[2]), false);
    const kimAvatars = all("[data-crew-fill]") as HTMLElement[];
    expect(kimAvatars.length).toBeGreaterThan(0);
    expect(kimAvatars.every((node) => node.textContent === "K")).toBe(true);
    expect(kimAvatars.every((node) => node.style.backgroundColor === "rgb(27, 134, 75)" && node.style.color === "rgb(255, 255, 255)")).toBe(true);
    for (const avatar of kimAvatars) {
      expectAvatarCoinLightEdge(avatar);
      expectPersonCircle(avatar);
    }
  });

  // The line is one line at every beat, so the transcript never moves as its
  // words change.
  it("keeps the run's activity line in one place at every beat", async () => {
    const lineRow = () => container.querySelector('[data-testid="landing-run-line"]')?.closest("[data-pin]");
    for (const beat of [BEAT.THINKING, BEAT.STEP2, BEAT.STEP4, TURN_END_BEAT]) {
      await render("code", beat, beat !== TURN_END_BEAT);
      expect(lineRow()).not.toBeNull();
      expect(container.querySelectorAll('[data-testid="landing-run-line"]')).toHaveLength(1);
    }
  });
});
