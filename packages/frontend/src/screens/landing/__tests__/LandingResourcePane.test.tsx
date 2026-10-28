// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LandingBrowserView } from "../LandingBrowserView";
import { LandingFileView } from "../LandingFileView";
import { LandingViewsBar, LandingViewsSegmented } from "../LandingViews";
import { paneStateFor } from "../landingPanes";
import { BEAT, SESSION_SCENARIOS, beatIndex, finishedBeat, type TurnBeatId } from "../landingTurnScript";

const [books, code, site] = SESSION_SCENARIOS;

describe("the landing's resource pane", () => {
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

  async function render(node: React.ReactNode) {
    await act(async () => root.render(<>{node}</>));
  }

  const all = (selector: string) => Array.from(container.querySelectorAll<HTMLElement>(selector));

  // Nothing in the window takes focus or is announced.
  function expectPresentational() {
    expect(all('a, button, input, textarea, select, [tabindex], [role="button"], [role="status"], [role="alert"], [aria-live]:not([aria-live="off"])')).toHaveLength(0);
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  }

  async function browserAt(id: TurnBeatId, playing = true) {
    const pane = paneStateFor(site, beatIndex(site, id));
    await render(<LandingBrowserView stage={pane.browser!} script={site.browser!} playing={playing} />);
    return container.querySelector('[data-testid="landing-browser-dock"]') as HTMLElement;
  }

  it("names the views as the studio does: Chat beside the resources in a split, a Chat tab in one view", async () => {
    await render(<LandingViewsBar pane={paneStateFor(books, BEAT.ARTIFACT)} split />);
    expectPresentational();
    const tabs = () => all('[data-testid="landing-view-tab"]');
    expect(tabs().map((tab) => tab.textContent)).toEqual(["2026-02-bank.csv", "2026-02-review.csv"]);
    expect(tabs().find((tab) => tab.dataset.selected === "true")?.dataset.viewId).toBe("file:ledger/2026-02-review.csv");
    expect(container.textContent).toContain("Chat");
    // The split's toggle is window chrome Cub keeps out of.
    expect(container.querySelector('[title="Show one view"]')?.getAttribute("data-cub-anchor")).toBe("action");

    await render(<LandingViewsBar pane={paneStateFor(books, BEAT.ARTIFACT)} split={false} />);
    expect(tabs().map((tab) => tab.textContent)).toEqual(["Chat", "2026-02-bank.csv"]);
    expect(tabs()[0].dataset.selected).toBe("true");
    expect(container.querySelector('[title="Show one view"]')).toBeNull();

    await render(<LandingViewsSegmented pane={paneStateFor(site, beatIndex(site, "approve"))} />);
    expectPresentational();
    expect(tabs().map((tab) => tab.dataset.viewId)).toEqual(["chat", "browser", "file:notes/pricing.md"]);
    expect(tabs()[1].dataset.selected).toBe("true");
    // The studio's attention: plain amber text after the label, which
    // truncates rather than disappears (ConversationWorkspaceViews.tsx).
    const approve = container.querySelector('[data-testid="landing-view-approve"]') as HTMLElement;
    expect(approve.textContent).toBe("Approve");
    expect(approve.className).toBe("text-amber-600");
    expect(tabs()[1].textContent).toBe("BrowserApprove");
    expect(approve.previousElementSibling?.className).toContain("truncate");

    // Once Octo is done Ada's press goes down on Chat, then Chat is in front.
    await render(<LandingViewsSegmented pane={paneStateFor(site, beatIndex(site, "browseDone"))} />);
    expect(tabs()[0].dataset.pressed).toBe("true");
    expect(tabs()[0].dataset.selected).toBe("false");
    await render(<LandingViewsBar pane={paneStateFor(site, beatIndex(site, "browseDone"))} split={false} />);
    expect(tabs()[0].dataset.pressed).toBe("true");
    // A split has no Chat tab to press.
    await render(<LandingViewsBar pane={paneStateFor(site, beatIndex(site, "browseDone"))} split />);
    expect(all('[data-pressed="true"]')).toHaveLength(0);
    await render(<LandingViewsSegmented pane={paneStateFor(site, beatIndex(site, "kimTyping"))} />);
    expect(tabs()[0].dataset.pressed).toBeUndefined();
    expect(tabs()[0].dataset.selected).toBe("true");
  });

  it("shows a CSV as plaintext with line numbers and the referenced line selected, never as a table", async () => {
    const pane = paneStateFor(books, BEAT.ARTIFACT);
    await render(<LandingFileView file={pane.file!.file} select={pane.file!.select} />);
    expectPresentational();
    expect(container.querySelector("table")).toBeNull();
    const lines = all("[data-line]");
    expect(lines).toHaveLength(4);
    expect(lines[0].textContent).toBe("1date,description,amount,note");
    expect(lines.filter((line) => line.dataset.selected === "true").map((line) => line.dataset.line)).toEqual(["2"]);
    expect(lines[1].querySelector(".bg-\\[\\#add6ff\\]")?.textContent).toBe("2026-02-04,Acme AB,-2140.00,duplicate?");
  });

  it("highlights TypeScript and selects the change's first range; Markdown opens in the editor without line numbers", async () => {
    const pane = paneStateFor(code, BEAT.ARTIFACT);
    await render(<LandingFileView file={pane.file!.file} select={pane.file!.select} />);
    const selected = all('[data-selected="true"]').map((line) => line.dataset.line);
    expect(selected).toEqual(["2"]);
    expect(container.textContent).toContain('import checkout from "@forma/checkout";');
    expect(container.querySelector(".text-\\[\\#0000ff\\]")?.textContent).toBe("import");

    const notes = paneStateFor(site, BEAT.REST);
    await render(<LandingFileView file={notes.file!.file} select={null} />);
    expect(container.textContent).toContain("Preview");
    expect(all("[data-line]")[0].textContent).toBe("# Pricing");
  });

  it("starts the Shared Browser with the studio's own card and placeholder", async () => {
    const view = await browserAt("press");
    expectPresentational();
    expect(view.querySelector('[data-testid="landing-browser-starting"]')?.textContent).toBe(
      "Starting Shared BrowserPreparing a secure browser session…",
    );
    expect(view.querySelector('[data-testid="landing-browser-address"]')?.textContent).toBe("Connecting to Shared Browser…");
    expect(view.querySelector(".animate-spin")).not.toBeNull();
    // The compact toolbar shows no status pill (Ready is screen-reader only in the studio).
    expect(view.textContent).not.toContain("Ready");
    expect(view.textContent).not.toContain("Starting…");
  });

  it("asks for the preview's site in Octo's words, then takes Ada's press on Allow site", async () => {
    let view = await browserAt("approve");
    expectPresentational();
    const approval = () => view.querySelector('[data-testid="landing-browser-approval"]') as HTMLElement;
    const allow = () => view.querySelector('[data-testid="landing-browser-allow"]')?.textContent;
    expect(approval().textContent).toContain(`Octo wants to use ${new URL(site.browser!.origin).hostname.replace(/^www\./u, "")}.`);
    expect(approval().textContent).not.toContain("the AI agent");
    expect(approval().textContent).not.toContain("routine browsing");
    expect(allow()).toBe("Allow site");
    // Never a scroll container a visitor could tab to.
    for (const node of all('[data-testid="landing-browser-approval"] *')) expect(node.getAttribute("class") ?? "").not.toMatch(/overflow-(y-)?(auto|scroll)/);
    expect(approval().getAttribute("data-pressed")).toBe("false");
    view = await browserAt("allowPress");
    expect(approval().getAttribute("data-pressed")).toBe("true");
    expect(view.querySelector('[data-testid="landing-browser-allow"]')?.className).toContain("scale-[0.98]");
    view = await browserAt("allowed");
    expect(approval()).toBeNull();
    // The studio's own edge glow while Octo controls the page.
    expect(view.querySelector('[data-testid="landing-browser-glow"] .browser-agent-surface[data-working="true"] .browser-agent-glow')).not.toBeNull();
  });

  it("draws Octo's unlabeled cursor and Kim's named pointer the way the studio does", async () => {
    const view = await browserAt("click");
    expectPresentational();
    // The page Octo built says only what the pricing notes say.
    const notes = site.pane.open.lines.map((line) => (typeof line === "string" ? line : line.map((token) => token.text).join(""))).join("\n");
    for (const [page, note] of [
      ["$19", "$19"],
      ["$49", "$49"],
      ["Up to 20", "Up to 20 members"],
      ["Priority", "priority support"],
      ["Email", "email support"],
      ["Yes, at any time.", "Change plans at any time."],
      ["two months free", "two months free"],
    ]) {
      expect(view.textContent).toContain(page);
      expect(notes).toContain(note);
    }
    const cursor = view.querySelector('[data-testid="landing-browser-cursor"]') as HTMLElement;
    expect(cursor.textContent).toBe("");
    expect(cursor.querySelector("path")?.getAttribute("fill")).toBe("#ffffff");
    expect(cursor.querySelector(".motion-safe\\:animate-ping")).not.toBeNull();
    const kim = view.querySelector('[data-testid="landing-dock-cursor"]') as HTMLElement;
    expect(kim.textContent).toBe("Kim");
    expect(kim.style.backgroundColor).toBe("rgb(27, 134, 75)");
    expect(kim.style.color).toBe("rgb(255, 255, 255)");
    expect(kim.previousElementSibling?.querySelector("path")?.getAttribute("fill")).toBe("#1B864B");
    expect(view.querySelector('[data-testid="landing-browser-ticker"]')?.getAttribute("data-action")).toBe("click");
    expect(view.querySelector('[data-testid="landing-browser-participants"]')?.textContent).toBe("A+1");
    expect(view.textContent).toContain("Team selected");
    // The page's own selected state is neutral, so nothing on the page reads
    // in Kim's green or the click dot's emerald except Kim and the ticker.
    const page = view.querySelector('[data-testid="landing-browser-page"]') as HTMLElement;
    expect(page.innerHTML).not.toMatch(/emerald|green/);
  });

  it("rests in its final state with nothing moving", async () => {
    const pane = paneStateFor(site, finishedBeat(site));
    await render(<LandingBrowserView stage={pane.browser!} script={site.browser!} playing={false} />);
    expectPresentational();
    expect(all(".animate-spin, .animate-ping, .motion-safe\\:animate-ping")).toHaveLength(0);
    expect(container.querySelector('[data-testid="landing-browser-glow"]')).toBeNull();
    // Octo's cursor still rests on its click (inside its 4 s linger), with no ripple.
    expect(container.querySelector('[data-testid="landing-browser-cursor"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="landing-browser-page"]')?.getAttribute("data-scrolled")).toBe("true");
    expect(container.querySelector('[data-testid="landing-browser-kim"]')?.getAttribute("data-at")).toBe("compare");
    expect(container.querySelector('[data-testid="landing-browser-address"]')?.textContent).toBe(site.browser!.url);
  });
});
