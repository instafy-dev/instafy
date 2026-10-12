import { describe, expect, it } from "vitest";
import { paneStateFor } from "../landingPanes";
import { BEAT, SESSION_SCENARIOS, beatIndex, finishedBeat, turnEndBeat, type TurnBeatId } from "../landingTurnScript";

const [books, code, site] = SESSION_SCENARIOS;
const siteAt = (id: TurnBeatId) => paneStateFor(site, beatIndex(site, id));

describe("the conversation's views beside the chat", () => {
  it("opens the file Kim pointed to from the first frame", () => {
    expect(paneStateFor(books, BEAT.REST).tabs.map((tab) => tab.label)).toEqual(["2026-02-bank.csv"]);
    expect(paneStateFor(code, BEAT.REST).tabs.map((tab) => tab.label)).toEqual(["router.ts"]);
    expect(paneStateFor(site, BEAT.REST).tabs.map((tab) => tab.label)).toEqual(["pricing.md"]);
    for (const scenario of SESSION_SCENARIOS) {
      const pane = paneStateFor(scenario, BEAT.REST);
      expect(pane.selected).toBe(`file:${scenario.pane.open.path}`);
      expect(pane.file?.select).toBeNull();
      expect(pane.browser).toBeNull();
      expect(pane.single).toBe("chat");
    }
  });

  it("opens the reviewed CSV on the artifact beat with its referenced line selected, as plaintext", () => {
    expect(paneStateFor(books, BEAT.COUNTS).selected).toBe("file:ledger/2026-02-bank.csv");
    const pane = paneStateFor(books, BEAT.ARTIFACT);
    expect(pane.tabs.map((tab) => tab.label)).toEqual(["2026-02-bank.csv", "2026-02-review.csv"]);
    // Only a split opens it: one view keeps the chat in front with the inline card.
    expect(pane.tabs[1].splitOnly).toBe(true);
    expect(pane.selected).toBe("file:ledger/2026-02-review.csv");
    expect(pane.file?.file.language).toBe("plaintext");
    expect(pane.file?.select).toEqual([2, 2]);
    expect(pane.file?.file.lines[1]).toBe("2026-02-04,Acme AB,-2140.00,duplicate?");
    expect(pane.single).toBe("chat");
  });

  it("updates the open router in place once the files land, then selects the change's first range", () => {
    const before = paneStateFor(code, BEAT.DONE).file!;
    const landed = paneStateFor(code, BEAT.FILES).file!;
    const opened = paneStateFor(code, BEAT.ARTIFACT).file!;
    expect(before.file).toBe(code.pane.open);
    expect(landed.file).toBe(code.pane.artifact!.file);
    expect(landed.select).toBeNull();
    // A click on the file card's filename reveals the change's first range
    // (ChatFileChangeList.tsx primaryRange): line 2, never the unchanged lines
    // between the two edits.
    expect(opened.select).toEqual([2, 2]);
    expect(paneStateFor(code, BEAT.ARTIFACT).tabs).toHaveLength(1);
  });

  it("never opens a browser in the workspace scenarios", () => {
    for (const scenario of [books, code]) {
      for (let beat = 0; beat <= turnEndBeat(scenario); beat++) expect(paneStateFor(scenario, beat).browser).toBeNull();
    }
  });
});

describe("the Shared Browser in the site scenario", () => {
  it("stays closed until Ada presses Octo's request, however far Octo's run has got", () => {
    for (let beat = 0; beat < beatIndex(site, "press"); beat++) {
      const pane = paneStateFor(site, beat);
      expect(pane.browser).toBeNull();
      expect(pane.tabs.some((tab) => tab.kind === "browser")).toBe(false);
    }
  });

  it("opens the Browser tab first and in front, starting before it connects", () => {
    const pane = siteAt("press");
    expect(pane.tabs.map((tab) => tab.id)).toEqual(["browser", "file:notes/pricing.md"]);
    expect(pane.selected).toBe("browser");
    expect(pane.single).toBe("browser");
    expect(pane.browser).toMatchObject({ connected: false, page: false, address: null, placeholder: "Connecting to Shared Browser…", glow: false });
    expect(siteAt("handoff").browser).toMatchObject({ connected: true, page: false, placeholder: "Enter an address", participants: ["ada"] });
  });

  it("asks Ada to approve the preview's site before Octo reads it, and badges the tab meanwhile", () => {
    expect(siteAt("browse").browser!.approval).toBe("none");
    // The prompt opens as the studio's does, routine browsing unticked; Ada
    // scrolls to the box and ticks it, then presses Allow.
    expect(siteAt("approve").browser!.approval).toBe("site");
    expect(siteAt("approve").browser!.allowPressed).toBe(false);
    expect(siteAt("approve").tabs[0].attention).toBe(true);
    expect(siteAt("routine").browser!.approval).toBe("routine");
    expect(siteAt("routine").browser!.allowPressed).toBe(false);
    expect(siteAt("routine").tabs[0].attention).toBe(true);
    expect(siteAt("allowPress").browser!.approval).toBe("routine");
    expect(siteAt("allowPress").browser!.allowPressed).toBe(true);
    const allowed = siteAt("allowed");
    expect(allowed.browser!.approval).toBe("none");
    expect(allowed.tabs[0].attention).toBeUndefined();
    expect(allowed.browser!.routineRow).toBe(true);
    // Nothing is read before the approval: the page loads only after it.
    expect(siteAt("allowPress").browser!.page).toBe(false);
  });

  it("captions Octo's actions in the runtime's own words", () => {
    const url = site.browser!.url;
    expect(siteAt("allowed").browser!.ticker).toBeNull();
    expect(siteAt("navigate").browser!.ticker).toEqual({ type: "navigate", label: `Go to ${url}` });
    expect(siteAt("navigate").browser!.address).toBe(url);
    expect(siteAt("loaded").browser!.ticker).toEqual({ type: "nav_result", label: "Pricing · Forma" });
    expect(siteAt("scroll").browser!.ticker).toEqual({ type: "scroll", label: "Scroll" });
    expect(siteAt("click").browser!.ticker).toEqual({ type: "click", label: 'Click "Choose Team"' });
  });

  it("shows the glow only while Octo works and its cursor only from its click until it fades", () => {
    const glow = (id: TurnBeatId) => siteAt(id).browser!.glow;
    expect(glow("handoff")).toBe(false);
    expect(glow("browse")).toBe(true);
    expect(glow("scroll")).toBe(true);
    expect(glow("browseDone")).toBe(false);
    const cursor = (id: TurnBeatId) => siteAt(id).browser!.cursor;
    expect(cursor("loaded")).toBe(false);
    expect(cursor("scroll")).toBe(false);
    expect(cursor("click")).toBe(true);
    expect(cursor("reply")).toBe(true);
    expect(cursor("settle")).toBe(false);
    // The finished frame is inside the cursor's 4 s linger, so it keeps Octo's
    // cursor on the button it clicked.
    expect(paneStateFor(site, finishedBeat(site)).browser!.cursor).toBe(true);
    // Octo scrolls to the plans first, so its cursor rests on the button it clicked.
    expect(siteAt("loaded").browser!.scrolled).toBe(false);
    expect(siteAt("scroll").browser!.scrolled).toBe(true);
    expect(siteAt("scroll").browser!.teamSelected).toBe(false);
    expect(siteAt("click").browser!.teamSelected).toBe(true);
  });

  it("puts Kim on the same page with her named pointer, and by the plan comparison as she answers", () => {
    expect(siteAt("navigate").browser!.kim).toBe("away");
    expect(siteAt("loaded").browser!.participants).toEqual(["ada", "kim"]);
    expect(siteAt("loaded").browser!.kim).toBe("away");
    expect(siteAt("scroll").browser!.kim).toBe("rest");
    expect(siteAt("browseDone").browser!.kim).toBe("rest");
    // Never on the control Octo clicked: she answers from the comparison.
    expect(siteAt("kimTyping").browser!.kim).toBe("compare");
  });

  it("keeps the browser in front of one view until Ada taps Chat once Octo is done", () => {
    expect(siteAt("tap").single).toBe("chat");
    expect(siteAt("press").single).toBe("browser");
    expect(siteAt("click").single).toBe("browser");
    expect(siteAt("click").pressed).toBeNull();
    // Her press goes down on the Chat tab first, so the studio never looks
    // as if it switched views on its own; then the chat is in front.
    expect(siteAt("browseDone").single).toBe("browser");
    expect(siteAt("browseDone").pressed).toBe("chat");
    expect(siteAt("kimTyping").single).toBe("chat");
    expect(siteAt("kimTyping").pressed).toBeNull();
    expect(paneStateFor(site, turnEndBeat(site)).single).toBe("chat");
    // A split keeps the browser beside the chat throughout.
    expect(siteAt("browseDone").selected).toBe("browser");
    expect(paneStateFor(site, turnEndBeat(site)).selected).toBe("browser");
    for (const scenario of [books, code]) {
      for (let beat = 0; beat <= turnEndBeat(scenario); beat++) expect(paneStateFor(scenario, beat).pressed).toBeNull();
    }
  });

  it("rests on a finished browser with nothing in motion (reduced motion, offscreen, hidden tabs)", () => {
    const pane = paneStateFor(site, finishedBeat(site));
    expect(pane.selected).toBe("browser");
    expect(pane.single).toBe("chat");
    expect(pane.pressed).toBeNull();
    expect(pane.browser).toEqual({
      connected: true,
      page: true,
      approval: "none",
      allowPressed: false,
      routineRow: false,
      glow: false,
      address: site.browser!.url,
      placeholder: "Enter an address",
      // Kim's reply lands 1.85 s after Octo's click: its cursor (4 s) and the
      // ticker (6 s, ActionTicker.tsx) both still show the click.
      ticker: { type: "click", label: 'Click "Choose Team"' },
      cursor: true,
      kim: "compare",
      teamSelected: true,
      scrolled: true,
      participants: ["ada", "kim"],
    });
  });
});
