// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectSheet, POPULAR_MIN_AVAILABLE } from "../ConnectSheet";
import { routeConnectorSelection } from "../connectorRouting";
import {
  AVAILABLE_FEATURED_CONNECTORS,
  CONNECTOR_CATEGORIES,
  CONNECTORS,
  PRODUCT_CONNECTORS,
  isConnectorAvailable,
  type Connector,
  type ProductConnector,
  type SkillConnector,
} from "../connectors";
import { useConnectSheetState, type ConnectSheetState } from "../useConnectSheetState";

const EM_DASH = "—";

// Notion is the one shipped skill whose pack is published, so its row and
// Popular mark are the pressable path. Slack and Discord are still "soon"
// (their packs are not published); the confirm-stage copy tests use this
// available copy of Slack so a flip of its availability changes no wording.
const soonSlack = CONNECTORS.find(
  (entry): entry is SkillConnector => entry.kind === "skill" && entry.id === "slack",
)!;
const slack: SkillConnector = { ...soonSlack, availability: "available" };
const notion = CONNECTORS.find(
  (entry): entry is SkillConnector => entry.kind === "skill" && entry.id === "notion",
)!;
const SOON_IDS = PRODUCT_CONNECTORS.filter((entry) => !isConnectorAvailable(entry)).map(
  (entry) => entry.id,
);

type HarnessSpies = {
  onConnect: ReturnType<typeof vi.fn>;
  onSetUpAgain: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
  openImportModal: ReturnType<typeof vi.fn>;
  beginGithubImport: ReturnType<typeof vi.fn>;
  openSkillsPanel: ReturnType<typeof vi.fn>;
  onStateChange: ReturnType<typeof vi.fn>;
};

function spies(): HarnessSpies {
  return {
    onConnect: vi.fn(),
    onSetUpAgain: vi.fn(),
    onClose: vi.fn(),
    openImportModal: vi.fn(),
    beginGithubImport: vi.fn(),
    openSkillsPanel: vi.fn(),
    onStateChange: vi.fn(),
  };
}

// The harness wires the sheet exactly like ChatPanel: one state hook, one
// router, and the same close-then-hand-off pairs for the paste link and the
// Skills panel. `initial` picks the stage the sheet opens in; a new `openKey`
// opens it again on the same instance (what a chip or menu row does).
function Harness({
  initial,
  openKey,
  installedSkillNames = new Set<string>(),
  pending = false,
  spies: s,
}: {
  initial: "browse" | SkillConnector | null;
  openKey: number;
  installedSkillNames?: ReadonlySet<string>;
  pending?: boolean;
  spies: HarnessSpies;
}) {
  const sheet = useConnectSheetState();
  const { openBrowse, openConfirm, close, back, state } = sheet;
  useEffect(() => {
    if (initial === null) {
      return;
    }
    if (initial === "browse") {
      openBrowse();
    } else {
      openConfirm(initial);
    }
  }, [initial, openKey, openBrowse, openConfirm]);
  useEffect(() => {
    s.onStateChange(state);
  }, [s, state]);

  const route = (connector: Connector) =>
    routeConnectorSelection(connector, {
      openConfirm,
      leaveSheet: close,
      openImportModal: s.openImportModal,
      beginGithubImport: s.beginGithubImport,
    });

  return (
    <>
      {/* Stand-ins for a published skill's row (and a soon one) reaching the router. */}
      <button type="button" data-testid="harness-route-available" onClick={() => route(slack)} />
      <button type="button" data-testid="harness-route-soon" onClick={() => route(soonSlack)} />
    <ConnectSheet
      isOpen={state !== null}
      stage={state?.stage ?? "browse"}
      target={state?.target ?? null}
      showBack={state?.openedFromBrowse ?? false}
      installedSkillNames={installedSkillNames}
      pending={pending}
      onSelect={(connector: ProductConnector) => route(connector)}
      onBack={back}
      onPasteLink={() => {
        close();
        s.openImportModal();
      }}
      onSearchAllSkills={(searchQuery: string) => {
        close();
        s.openSkillsPanel(searchQuery);
      }}
      onConnect={s.onConnect}
      onSetUpAgain={s.onSetUpAgain}
      onClose={() => {
        s.onClose();
        close();
      }}
    />
    </>
  );
}

function query<T extends HTMLElement>(selector: string): T | null {
  return document.body.querySelector<T>(selector);
}

function queryAll<T extends HTMLElement>(selector: string): T[] {
  return Array.from(document.body.querySelectorAll<T>(selector));
}

// The text a screen reader names a control by: visible text with aria-hidden
// subtrees (the marks, one of which is an SVG monogram) left out.
function accessibleText(element: Element | null): string {
  if (!element) {
    return "";
  }
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent?.trim() ?? "");
      return;
    }
    if (node instanceof Element && node.getAttribute("aria-hidden") === "true") {
      return;
    }
    node.childNodes.forEach(walk);
  };
  walk(element);
  return parts.filter(Boolean).join(" ");
}

function lastState(s: HarnessSpies): ConnectSheetState | null {
  const calls = s.onStateChange.mock.calls;
  return (calls[calls.length - 1]?.[0] as ConnectSheetState | null | undefined) ?? null;
}

async function typeQuery(value: string) {
  const input = query<HTMLInputElement>('[data-testid="connect-search"]')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pressEscape() {
  const dialog = query<HTMLElement>('[role="dialog"]')!;
  await act(async () => {
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    dialog.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
  });
}

describe("ConnectSheet", () => {
  let container: HTMLDivElement;
  let root: Root;
  const originalMatchMedia = window.matchMedia;

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
    document.body.innerHTML = "";
    window.matchMedia = originalMatchMedia;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    vi.clearAllMocks();
  });

  let openKey = 0;
  async function render(props: Omit<Parameters<typeof Harness>[0], "openKey">) {
    openKey += 1;
    await act(async () => {
      root.render(<Harness {...props} openKey={openKey} />);
    });
  }

  describe("browse stage", () => {
    it("renders the search box, the Popular row of the two available tools, and every category in order", async () => {
      const s = spies();
      await render({ initial: "browse", spies: s });

      expect(query('[role="dialog"]')?.getAttribute("aria-label")).toBe("Connect a tool");
      const search = query<HTMLInputElement>('[data-testid="connect-search"]');
      expect(search?.getAttribute("placeholder")).toBe("Search tools");
      expect(search?.value).toBe("");

      // Popular shows only tools that can be selected today, and only once
      // there are at least two of them: GitHub, then Notion and FreeFinance,
      // in list order, which is the no-paste-first rule the card row reads too.
      expect(AVAILABLE_FEATURED_CONNECTORS.map((entry) => entry.id)).toEqual([
        "github",
        "notion",
        "freefinance",
      ]);
      // The catalogue sits close to the threshold, so assert the row is not
      // one un-featured entry away from disappearing without a test noticing.
      expect(AVAILABLE_FEATURED_CONNECTORS.length).toBeGreaterThanOrEqual(POPULAR_MIN_AVAILABLE);
      expect(query('[data-testid="connect-popular"]')).not.toBeNull();
      expect(query("#connect-popular-label")?.textContent).toBe("Popular");
      expect(
        queryAll<HTMLButtonElement>('[data-testid="connect-popular-row"] [data-testid^="connect-popular-"]').map(
          (mark) => mark.dataset.testid,
        ),
      ).toEqual([
        "connect-popular-github",
        "connect-popular-notion",
        "connect-popular-freefinance",
      ]);
      expect(query('[data-testid="connect-popular-slack"]')).toBeNull();
      expect(query('[data-testid="connect-popular-discord"]')).toBeNull();

      // Categories: only the ones with entries, in CONNECTOR_CATEGORIES order,
      // each with one row per connector in list order.
      // Groups, not landmarks: a dialog full of named regions clutters the
      // screen-reader landmark list.
      const sections = queryAll<HTMLElement>('[data-testid^="connect-category-"]').filter(
        (element) => element.getAttribute("role") === "group",
      );
      expect(sections.map((section) => section.dataset.testid)).toEqual([
        "connect-category-chat",
        "connect-category-docs",
        "connect-category-code",
        "connect-category-finance",
      ]);
      const orderedLabels = CONNECTOR_CATEGORIES.map((category) => category.label);
      const renderedLabels = sections.map(
        (section) => section.querySelector("p")?.textContent ?? "",
      );
      expect(renderedLabels).toEqual(
        orderedLabels.filter((label) => renderedLabels.includes(label)),
      );
      expect(document.body.textContent).not.toContain("Email and calendar");
      expect(document.body.textContent).not.toContain("Files");
      const rowsIn = (id: string) =>
        Array.from(
          query(`[data-testid="connect-category-${id}"]`)!.querySelectorAll<HTMLButtonElement>(
            '[data-testid^="connect-row-"]',
          ),
        )
          .filter((element) => element instanceof HTMLButtonElement)
          .map((row) => row.dataset.testid);
      expect(rowsIn("chat")).toEqual(["connect-row-slack", "connect-row-discord"]);
      expect(rowsIn("docs")).toEqual(["connect-row-notion"]);
      expect(rowsIn("code")).toEqual(["connect-row-github"]);
      expect(rowsIn("finance")).toEqual(["connect-row-freefinance"]);
      expect(query('[data-testid="connect-row-other"]')).toBeNull();

      // Rows: mark plus name, then the meta. A soon row is disabled (the
      // Button's disabled opacity greys it; the name keeps the primary tone,
      // as on the chip and menu row) and its meta is the Soon Badge in place
      // of the region.
      expect(SOON_IDS).toEqual(["slack", "discord"]);
      const slack = query<HTMLButtonElement>('[data-testid="connect-row-slack"]')!;
      expect(slack.querySelectorAll("svg")).toHaveLength(1);
      // The mark is aria-hidden; the row reads as the name plus the meta.
      expect(slack.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
      expect(slack.querySelectorAll("span span")[0]?.textContent).toBe("Slack");
      expect(slack.disabled).toBe(true);
      expect(query('[data-testid="connect-row-slack-meta"]')?.textContent).toBe("Soon");
      // No aria-label: the visible text names the row, meta included.
      expect(slack.getAttribute("aria-label")).toBeNull();
      expect(accessibleText(slack)).toBe("Slack Soon");
      // Meta keeps the muted token (slate-600), not subtle (slate-400): 12 px
      // text needs the contrast; the Badge's neutral tone carries it.
      expect(query('[data-testid="connect-row-slack-meta"]')?.className).toContain("text-slate-600");
      expect(query('[data-testid="connect-row-slack-meta"]')?.className).toContain("rounded-full");
      // A published pack is selectable and shows its region as the meta.
      const freefinance = query<HTMLButtonElement>('[data-testid="connect-row-freefinance"]')!;
      expect(freefinance.disabled).toBe(false);
      expect(query('[data-testid="connect-row-freefinance-meta"]')?.textContent).toBe("Austria");
      expect(accessibleText(freefinance)).toBe("FreeFinance Austria");
      for (const id of SOON_IDS) {
        const row = query<HTMLButtonElement>(`[data-testid="connect-row-${id}"]`)!;
        expect(row.disabled).toBe(true);
        expect(row.getAttribute("data-disabled")).toBe("true");
        expect(row.className).toContain("data-[disabled]:opacity-60");
        expect(row.querySelectorAll("span span")[0]?.className).not.toContain("text-slate-600");
        expect(row.querySelectorAll("span span")[0]?.className).toContain("text-midnight");
        expect(query(`[data-testid="connect-row-${id}-meta"]`)?.textContent).toBe("Soon");
        // Hover reads "Coming soon" from the list item: the disabled Button
        // has pointer-events none, so the pointer lands on the item.
        expect(row.parentElement?.getAttribute("title")).toBe("Coming soon");
      }
      const github = query<HTMLButtonElement>('[data-testid="connect-row-github"]')!;
      expect(github.disabled).toBe(false);
      expect(github.parentElement?.getAttribute("title")).toBeNull();
      expect(github.querySelectorAll("span span")[0]?.className).not.toContain("text-slate-600");
      expect(query('[data-testid="connect-row-github-meta"]')).toBeNull();
      expect(github.textContent).toBe("GitHub");
      // A published skill without a region: selectable, name only, no Badge.
      const notionRow = query<HTMLButtonElement>('[data-testid="connect-row-notion"]')!;
      expect(notionRow.disabled).toBe(false);
      expect(notionRow.parentElement?.getAttribute("title")).toBeNull();
      expect(query('[data-testid="connect-row-notion-meta"]')).toBeNull();
      expect(notionRow.textContent).toBe("Notion");
      expect(accessibleText(notionRow)).toBe("Notion");
      expect(query<HTMLButtonElement>('[data-testid="connect-row-slack"]')?.textContent).toBe("SlackSoon");
      expect(document.body.textContent).not.toContain("please");
      // Both stage footers share the header's hairline token.
      expect(query('[data-testid="connect-paste-link"]')?.parentElement?.className).toContain(
        "dark:border-[color:var(--color-studio-dark-divider)]",
      );

      // Footer: the paste link and Cancel; no sending control anywhere.
      expect(query('[data-testid="connect-paste-link"]')?.textContent).toBe("Paste a skill link");
      expect(query('[data-testid="connect-browse-cancel"]')?.textContent).toBe("Cancel");
      expect(query('[data-testid="connect-confirm-submit"]')).toBeNull();
      expect(query('[data-testid="connect-confirm-stage"]')).toBeNull();
      expect(query('[data-testid="connect-confirm-back"]')).toBeNull();
      expect(document.body.textContent).not.toContain(EM_DASH);
      expect(document.body.textContent).not.toContain("!");
      expect(s.onConnect).not.toHaveBeenCalled();
    });

    it("keeps a soon row soon even when its skill folder is installed", async () => {
      // An installed folder does not make an unpublished pack selectable: the
      // Soon Badge wins over the connected meta and the row stays disabled.
      const s = spies();
      await render({
        initial: "browse",
        installedSkillNames: new Set(["freefinance", "slack", "notion"]),
        spies: s,
      });

      expect(query('[data-testid="connect-row-freefinance-meta"]')?.textContent).toBe("connected");
      expect(query('[data-testid="connect-row-slack-meta"]')?.textContent).toBe("Soon");
      const slackRow = query<HTMLButtonElement>('[data-testid="connect-row-slack"]');
      expect(slackRow?.disabled).toBe(true);
      expect(slackRow?.getAttribute("aria-label")).toBeNull();
      expect(accessibleText(slackRow)).toBe("Slack Soon");
      // A published skill's installed folder reads as connected and stays selectable.
      expect(query('[data-testid="connect-row-notion-meta"]')?.textContent).toBe("connected");
      expect(query<HTMLButtonElement>('[data-testid="connect-row-notion"]')?.disabled).toBe(false);
      expect(query('[data-testid="connect-row-github-meta"]')).toBeNull();
    });

    it("never reaches the confirm stage from a soon row, pressed or routed", async () => {
      const s = spies();
      await render({ initial: "browse", spies: s });

      const slackRow = query<HTMLButtonElement>('[data-testid="connect-row-slack"]')!;
      await act(async () => slackRow.click());
      await act(async () => {
        slackRow.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        slackRow.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        slackRow.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        slackRow.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
      });
      expect(lastState(s)?.stage).toBe("browse");
      expect(query('[data-testid="connect-confirm-stage"]')).toBeNull();
      expect(query('[data-testid="connect-browse-stage"]')).not.toBeNull();

      // Even a soon connector handed straight to the router goes nowhere.
      await act(async () => query<HTMLButtonElement>('[data-testid="harness-route-soon"]')?.click());
      expect(lastState(s)).toEqual({ stage: "browse", target: null, openedFromBrowse: false });
      expect(query('[data-testid="connect-confirm-stage"]')).toBeNull();
      expect(query('[data-testid="connect-confirm-submit"]')).toBeNull();
      expect(s.onConnect).not.toHaveBeenCalled();
      expect(s.beginGithubImport).not.toHaveBeenCalled();
      expect(s.openImportModal).not.toHaveBeenCalled();
      expect(s.onClose).not.toHaveBeenCalled();
    });

    it("filters rows by the query, listing soon tools greyed and hiding empty categories", async () => {
      const s = spies();
      await render({ initial: "browse", spies: s });

      await typeQuery("buch");
      // Typing hides the Popular row.
      expect(query('[data-testid="connect-popular"]')).toBeNull();
      expect(query('[data-testid="connect-popular-notion"]')).toBeNull();
      expect(queryAll('[data-testid^="connect-popular-"]')).toHaveLength(0);
      const sections = queryAll<HTMLElement>('[data-testid^="connect-category-"]').filter(
        (element) => element.getAttribute("role") === "group",
      );
      expect(sections.map((section) => section.dataset.testid)).toEqual(["connect-category-finance"]);
      const freefinance = query<HTMLButtonElement>('[data-testid="connect-row-freefinance"]');
      expect(freefinance).not.toBeNull();
      expect(freefinance?.disabled).toBe(false);
      expect(query('[data-testid="connect-row-freefinance-meta"]')?.textContent).toBe("Austria");
      expect(query('[data-testid="connect-row-slack"]')).toBeNull();
      expect(query('[data-testid="connect-empty"]')).toBeNull();

      await typeQuery("chat");
      expect(queryAll('[data-testid^="connect-row-"]').filter((el) => el instanceof HTMLButtonElement).map((el) => el.dataset.testid)).toEqual([
        "connect-row-slack",
        "connect-row-discord",
      ]);
      expect(query<HTMLButtonElement>('[data-testid="connect-row-slack"]')?.disabled).toBe(true);
      expect(query('[data-testid="connect-row-slack-meta"]')?.textContent).toBe("Soon");

      await typeQuery("Code");
      expect(queryAll('[data-testid^="connect-row-"]').filter((el) => el instanceof HTMLButtonElement).map((el) => el.dataset.testid)).toEqual([
        "connect-row-github",
      ]);
      expect(query<HTMLButtonElement>('[data-testid="connect-row-github"]')?.disabled).toBe(false);

      // Clearing the query brings every category and the Popular row back.
      await typeQuery("");
      expect(query('[data-testid="connect-popular-row"]')).not.toBeNull();
      expect(query('[data-testid="connect-popular-notion"]')).not.toBeNull();
      expect(query('[data-testid="connect-row-slack"]')).not.toBeNull();
      expect(query('[data-testid="connect-row-freefinance"]')).not.toBeNull();
      expect(s.onConnect).not.toHaveBeenCalled();
    });

    it("offers Search all skills when nothing matches, closing the sheet on press", async () => {
      const s = spies();
      await render({ initial: "browse", spies: s });

      await typeQuery("zzzz");
      expect(query('[data-testid="connect-empty"]')?.textContent).toContain('No tool named "zzzz".');
      expect(query('[data-testid="connect-categories"]')).toBeNull();
      expect(query('[data-testid="connect-popular"]')).toBeNull();
      // The footer stays: the paste link is always reachable.
      expect(query('[data-testid="connect-paste-link"]')).not.toBeNull();
      expect(document.body.textContent).not.toContain(EM_DASH);

      await act(async () => query<HTMLButtonElement>('[data-testid="connect-search-all"]')?.click());
      expect(s.openSkillsPanel).toHaveBeenCalledTimes(1);
      // The typed query travels with the hand-off.
      expect(s.openSkillsPanel).toHaveBeenCalledWith("zzzz");
      expect(query('[role="dialog"]')).toBeNull();
      expect(s.onConnect).not.toHaveBeenCalled();
      expect(s.openImportModal).not.toHaveBeenCalled();
    });

    it("moves an available skill row to the confirm stage without sending, with Back returning to the kept query", async () => {
      const s = spies();
      await render({ initial: "browse", spies: s });

      await typeQuery("not");
      // The press of a published skill's row: Notion is the shipped one.
      const notionRow = query<HTMLButtonElement>('[data-testid="connect-row-notion"]')!;
      expect(notionRow.disabled).toBe(false);
      await act(async () => notionRow.click());
      expect(lastState(s)).toEqual({ stage: "confirm", target: notion, openedFromBrowse: true });
      expect(query('[role="dialog"]')?.getAttribute("aria-label")).toBe("Connect Notion");
      expect(query('[data-testid="connect-confirm-stage"]')).not.toBeNull();
      expect(query('[data-testid="connect-browse-stage"]')).toBeNull();
      expect(query('[data-testid="connect-confirm-submit"]')).not.toBeNull();
      expect(s.onConnect).not.toHaveBeenCalled();
      expect(s.beginGithubImport).not.toHaveBeenCalled();
      expect(s.openImportModal).not.toHaveBeenCalled();

      // Back is offered only because the confirm stage came from the list.
      const back = query<HTMLButtonElement>('[data-testid="connect-confirm-back"]');
      expect(back?.textContent).toContain("Back");
      await act(async () => back?.click());
      expect(lastState(s)).toEqual({ stage: "browse", target: null, openedFromBrowse: false });
      expect(query('[data-testid="connect-browse-stage"]')).not.toBeNull();
      expect(query<HTMLInputElement>('[data-testid="connect-search"]')?.value).toBe("not");
      expect(query('[data-testid="connect-row-notion"]')).not.toBeNull();
      expect(query('[data-testid="connect-row-slack"]')).toBeNull();
      expect(s.onConnect).not.toHaveBeenCalled();
      expect(s.onClose).not.toHaveBeenCalled();
    });

    it("voices the narrowed count through a polite status line", async () => {
      const s = spies();
      await render({ initial: "browse", spies: s });
      const status = query<HTMLElement>('[data-testid="connect-search-status"]')!;
      expect(status.getAttribute("role")).toBe("status");
      expect(status.getAttribute("aria-live")).toBe("polite");
      expect(status.textContent).toBe("");

      await typeQuery("buch");
      expect(query('[data-testid="connect-search-status"]')?.textContent).toBe("1 tool");
      await typeQuery("chat");
      expect(query('[data-testid="connect-search-status"]')?.textContent).toBe("2 tools");
      await typeQuery("zzzz");
      expect(query('[data-testid="connect-search-status"]')?.textContent).toContain("No tool named");
      await typeQuery("   ");
      expect(query('[data-testid="connect-search-status"]')?.textContent).toBe("");
    });

    it("moves focus into the new stage after a row press and after Back, never onto Close", async () => {
      const s = spies();
      await render({ initial: "browse", spies: s });

      await act(async () => query<HTMLButtonElement>('[data-testid="harness-route-available"]')?.click());
      const confirmStage = query<HTMLElement>('[data-testid="connect-confirm-stage"]');
      expect(confirmStage).not.toBeNull();
      expect(confirmStage?.contains(document.activeElement)).toBe(true);
      expect(document.activeElement).not.toBe(query('[aria-label="Close"]'));

      await act(async () => query<HTMLButtonElement>('[data-testid="connect-confirm-back"]')?.click());
      const browseStage = query<HTMLElement>('[data-testid="connect-browse-stage"]');
      expect(browseStage).not.toBeNull();
      expect(browseStage?.contains(document.activeElement)).toBe(true);
      // jsdom has no matchMedia (coarse pointer): the search box stays
      // unfocused so a phone's keyboard does not pop on Back.
      expect(document.activeElement).not.toBe(query('[data-testid="connect-search"]'));
      expect(document.activeElement).not.toBe(query('[aria-label="Close"]'));
      expect(s.onClose).not.toHaveBeenCalled();
      expect(s.onConnect).not.toHaveBeenCalled();
    });

    it("focuses the search box on Back for a fine pointer", async () => {
      const s = spies();
      window.matchMedia = ((mediaQuery: string) =>
        ({ matches: mediaQuery === "(pointer: fine)", media: mediaQuery }) as MediaQueryList) as typeof window.matchMedia;
      await render({ initial: "browse", spies: s });
      await act(async () => query<HTMLButtonElement>('[data-testid="harness-route-available"]')?.click());
      expect(query('[data-testid="connect-confirm-stage"]')?.contains(document.activeElement)).toBe(true);
      await act(async () => query<HTMLButtonElement>('[data-testid="connect-confirm-back"]')?.click());
      expect(document.activeElement).toBe(query('[data-testid="connect-search"]'));
    });

    it("closes and starts the GitHub import flow from the GitHub row", async () => {
      const s = spies();
      await render({ initial: "browse", spies: s });

      await act(async () => query<HTMLButtonElement>('[data-testid="connect-row-github"]')?.click());
      expect(s.beginGithubImport).toHaveBeenCalledTimes(1);
      expect(query('[role="dialog"]')).toBeNull();
      expect(lastState(s)).toBeNull();
      expect(s.onConnect).not.toHaveBeenCalled();
      expect(s.openImportModal).not.toHaveBeenCalled();
    });

    it("closes and opens the import modal from Paste a skill link", async () => {
      const s = spies();
      await render({ initial: "browse", spies: s });

      await act(async () => query<HTMLButtonElement>('[data-testid="connect-paste-link"]')?.click());
      expect(s.openImportModal).toHaveBeenCalledTimes(1);
      expect(query('[role="dialog"]')).toBeNull();
      expect(s.onConnect).not.toHaveBeenCalled();
      expect(s.beginGithubImport).not.toHaveBeenCalled();
    });

    it("closes through Cancel, the header Close and Escape without sending", async () => {
      const s = spies();
      await render({ initial: "browse", spies: s });
      await act(async () => query<HTMLButtonElement>('[data-testid="connect-browse-cancel"]')?.click());
      expect(s.onClose).toHaveBeenCalledTimes(1);
      expect(query('[role="dialog"]')).toBeNull();

      await render({ initial: "browse", spies: s });
      await act(async () => query<HTMLButtonElement>('[aria-label="Close"]')?.click());
      expect(s.onClose).toHaveBeenCalledTimes(2);
      expect(query('[role="dialog"]')).toBeNull();

      await render({ initial: "browse", spies: s });
      await pressEscape();
      expect(s.onClose).toHaveBeenCalledTimes(3);
      expect(query('[role="dialog"]')).toBeNull();
      expect(s.onConnect).not.toHaveBeenCalled();
      expect(s.onSetUpAgain).not.toHaveBeenCalled();
    });

    it("focuses the search box only for a fine pointer", async () => {
      const s = spies();
      await render({ initial: "browse", spies: s });
      // jsdom has no matchMedia: a phone-safe default, no keyboard pop.
      expect(document.activeElement).not.toBe(query('[data-testid="connect-search"]'));
      await act(async () => query<HTMLButtonElement>('[data-testid="connect-browse-cancel"]')?.click());

      window.matchMedia = ((mediaQuery: string) =>
        ({ matches: mediaQuery === "(pointer: fine)", media: mediaQuery }) as MediaQueryList) as typeof window.matchMedia;
      await render({ initial: "browse", spies: s });
      expect(document.activeElement).toBe(query('[data-testid="connect-search"]'));
    });

    it("resets the query when the sheet is reopened", async () => {
      const s = spies();
      await render({ initial: "browse", spies: s });
      await typeQuery("buch");
      await act(async () => query<HTMLButtonElement>('[data-testid="connect-browse-cancel"]')?.click());
      expect(query('[role="dialog"]')).toBeNull();

      await render({ initial: "browse", spies: s });
      expect(query<HTMLInputElement>('[data-testid="connect-search"]')?.value).toBe("");
      expect(query('[data-testid="connect-row-slack"]')).not.toBeNull();
    });

    it("shows the Popular row of the available marks, routing Notion to confirm and GitHub to its import", async () => {
      const s = spies();
      await render({ initial: "browse", spies: s });

      // Exactly the available featured marks, in featured order; Slack and
      // Discord stay soon and never reach the row.
      expect(query('[data-testid="connect-popular"]')).not.toBeNull();
      expect(query("#connect-popular-label")?.textContent).toBe("Popular");
      const marks = queryAll<HTMLButtonElement>('[data-testid="connect-popular-row"] [data-testid^="connect-popular-"]');
      expect(marks.map((mark) => mark.dataset.testid)).toEqual([
        "connect-popular-github",
        "connect-popular-notion",
        "connect-popular-freefinance",
      ]);
      expect(query('[data-testid="connect-popular-slack"]')).toBeNull();
      expect(query('[data-testid="connect-popular-discord"]')).toBeNull();
      for (const mark of marks) {
        expect(mark.disabled).toBe(false);
        // Bare marks at the IconButton md size, with the touch floor.
        expect(mark.className).toContain("h-9 w-9");
        expect(mark.className).toContain("pointer-coarse:min-h-11");
        expect(mark.querySelectorAll("svg")).toHaveLength(1);
        expect(mark.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
        // The name lives on the label and the hover title; the button adds
        // no text of its own beside the mark. FreeFinance's placeholder
        // monogram draws "FF" inside its own aria-hidden svg, which is the
        // mark itself and not a label.
        expect(mark.textContent).toBe(mark.querySelector("svg")?.textContent ?? "");
      }
      expect(query<HTMLButtonElement>('[data-testid="connect-popular-github"]')?.getAttribute("aria-label")).toBe("GitHub");
      expect(query<HTMLButtonElement>('[data-testid="connect-popular-notion"]')?.getAttribute("aria-label")).toBe("Notion");
      expect(query<HTMLButtonElement>('[data-testid="connect-popular-notion"]')?.getAttribute("title")).toBe("Notion");

      // Typing hides the row; clearing the query brings it back.
      await typeQuery("git");
      expect(query('[data-testid="connect-popular"]')).toBeNull();
      expect(queryAll('[data-testid^="connect-popular-"]')).toHaveLength(0);
      await typeQuery("");
      expect(query('[data-testid="connect-popular-row"]')).not.toBeNull();
      expect(document.body.textContent).not.toContain(EM_DASH);

      // The Notion mark routes like its row: the confirm stage, with Back,
      // and nothing sent.
      await act(async () => query<HTMLButtonElement>('[data-testid="connect-popular-notion"]')?.click());
      expect(lastState(s)).toEqual({ stage: "confirm", target: notion, openedFromBrowse: true });
      expect(query('[role="dialog"]')?.getAttribute("aria-label")).toBe("Connect Notion");
      expect(query('[data-testid="connect-confirm-stage"]')).not.toBeNull();
      expect(query('[data-testid="connect-confirm-back"]')).not.toBeNull();
      expect(s.onConnect).not.toHaveBeenCalled();
      expect(s.beginGithubImport).not.toHaveBeenCalled();
      expect(s.openImportModal).not.toHaveBeenCalled();
      await act(async () => query<HTMLButtonElement>('[data-testid="connect-confirm-back"]')?.click());
      expect(lastState(s)).toEqual({ stage: "browse", target: null, openedFromBrowse: false });
      expect(query('[data-testid="connect-popular-row"]')).not.toBeNull();

      // The GitHub mark leaves the sheet for the GitHub import flow.
      await act(async () => query<HTMLButtonElement>('[data-testid="connect-popular-github"]')?.click());
      expect(s.beginGithubImport).toHaveBeenCalledTimes(1);
      expect(query('[role="dialog"]')).toBeNull();
      expect(lastState(s)).toBeNull();
      expect(s.onConnect).not.toHaveBeenCalled();
      expect(s.openImportModal).not.toHaveBeenCalled();
      expect(s.onClose).not.toHaveBeenCalled();
    });
  });

  describe("confirm stage", () => {
    it("confirms a product without sending until Connect, with no Back when opened from a chip", async () => {
      const s = spies();
      await render({ initial: slack, spies: s });

      expect(lastState(s)).toEqual({ stage: "confirm", target: slack, openedFromBrowse: false });
      expect(query('[role="dialog"]')?.getAttribute("aria-label")).toBe("Connect Slack");
      expect(document.body.textContent).toContain("Connect Slack");
      expect(query('[data-testid="connect-confirm-install-line"]')?.textContent).toBe(
        "Adds the Slack skill from instafy-dev/skills to this space, then starts its setup in this chat.",
      );
      expect(query('[data-testid="connect-confirm-needs-line"]')?.textContent).toBe(
        "Setup will ask for a Slack app bot token (SLACK_BOT_TOKEN) through the secrets card. Never paste it in chat.",
      );
      expect(query('[data-testid="connect-confirm-files-line"]')?.textContent).toBe(
        "Files land in .agents/skills/slack.",
      );
      expect(query('[data-testid="connect-confirm-files-line"] code')?.textContent).toBe(
        ".agents/skills/slack",
      );
      // No list, no search, no Back: this confirm did not come from the browse stage.
      expect(query('[data-testid="connect-browse-stage"]')).toBeNull();
      expect(query('[data-testid="connect-search"]')).toBeNull();
      expect(query('[data-testid="connect-confirm-back"]')).toBeNull();
      expect(query('[data-testid="connect-paste-link"]')).toBeNull();
      expect(s.onConnect).not.toHaveBeenCalled();
      expect(s.onSetUpAgain).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain(EM_DASH);

      await act(async () => query<HTMLButtonElement>('[data-testid="connect-confirm-submit"]')?.click());
      expect(s.onConnect).toHaveBeenCalledTimes(1);
      expect(s.onConnect).toHaveBeenCalledWith(slack);
      expect(s.onSetUpAgain).not.toHaveBeenCalled();

      await act(async () => query<HTMLButtonElement>('[data-testid="connect-confirm-cancel"]')?.click());
      expect(s.onClose).toHaveBeenCalledTimes(1);
      expect(query('[role="dialog"]')).toBeNull();
      expect(s.onConnect).toHaveBeenCalledTimes(1);
    });

    it("confirms the shipped Notion entry with its published pack and token", async () => {
      // Real data, not a fixture: the copy reads straight from connectors.ts.
      const s = spies();
      await render({ initial: notion, spies: s });

      expect(query('[role="dialog"]')?.getAttribute("aria-label")).toBe("Connect Notion");
      expect(query('[data-testid="connect-confirm-install-line"]')?.textContent).toBe(
        "Adds the Notion skill from instafy-dev/skills to this space, then starts its setup in this chat.",
      );
      expect(query('[data-testid="connect-confirm-needs-line"]')?.textContent).toBe(
        "Setup will ask for a Notion connection Installation access token (NOTION_API_KEY) through the secrets card. Never paste it in chat.",
      );
      expect(query('[data-testid="connect-confirm-files-line"]')?.textContent).toBe(
        "Files land in .agents/skills/notion.",
      );
      expect(document.body.textContent).not.toContain("https://");
      expect(document.body.textContent).not.toContain(EM_DASH);

      await act(async () => query<HTMLButtonElement>('[data-testid="connect-confirm-submit"]')?.click());
      expect(s.onConnect).toHaveBeenCalledTimes(1);
      expect(s.onConnect).toHaveBeenCalledWith(notion);
      expect(s.onSetUpAgain).not.toHaveBeenCalled();
    });

    it("never prints the source URL, only its label", async () => {
      const s = spies();
      await render({ initial: slack, spies: s });
      expect(document.body.textContent).toContain(slack.sourceLabel);
      expect(document.body.textContent).not.toContain("https://");
      expect(document.body.textContent).not.toContain(slack.source);
      expect(query("a[href]")).toBeNull();
    });

    it("joins two or more needs and switches to the plural wording", async () => {
      const s = spies();
      const twoNeeds: SkillConnector = {
        ...slack,
        needs: ["a bot token (BOT_TOKEN)", "a signing secret (SIGNING_SECRET)"],
      };
      await render({ initial: twoNeeds, spies: s });
      expect(query('[data-testid="connect-confirm-needs-line"]')?.textContent).toBe(
        "Setup will ask for a bot token (BOT_TOKEN) and a signing secret (SIGNING_SECRET) through the secrets card. Never paste them in chat.",
      );
      await act(async () => query<HTMLButtonElement>('[data-testid="connect-confirm-cancel"]')?.click());

      const threeNeeds: SkillConnector = {
        ...slack,
        needs: ["A (A_KEY)", "B (B_KEY)", "C (C_KEY)"],
      };
      await render({ initial: threeNeeds, spies: s });
      expect(query('[data-testid="connect-confirm-needs-line"]')?.textContent).toBe(
        "Setup will ask for A (A_KEY), B (B_KEY) and C (C_KEY) through the secrets card. Never paste them in chat.",
      );
      await act(async () => query<HTMLButtonElement>('[data-testid="connect-confirm-cancel"]')?.click());

      await render({ initial: { ...slack, needs: [] }, spies: s });
      expect(query('[data-testid="connect-confirm-needs-line"]')).toBeNull();
      expect(query('[data-testid="connect-confirm-files-line"]')).not.toBeNull();
    });

    it("swaps the first line for the shared-display wording when a connector carries an app", async () => {
      // Fixture only: no shipped entry sets `app` today.
      const s = spies();
      const appConnector: SkillConnector = {
        ...slack,
        id: "fixture-app",
        name: "Fixture",
        skillName: "fixture",
        needs: [],
        app: { url: "https://fixture.example/app" },
      };
      await render({ initial: appConnector, spies: s });

      expect(query('[data-testid="connect-confirm-install-line"]')?.textContent).toBe(
        "Adds the Fixture skill from instafy-dev/skills to this space. Setup opens Fixture in the shared display; you sign in there once, and the agent then works in that session.",
      );
      expect(query('[data-testid="connect-confirm-needs-line"]')).toBeNull();
      expect(query('[data-testid="connect-confirm-files-line"]')?.textContent).toBe(
        "Files land in .agents/skills/fixture.",
      );
      expect(document.body.textContent).not.toContain("https://fixture.example/app");
      expect(query('[data-testid="connect-confirm-submit"]')).not.toBeNull();
    });

    it("offers Set up again for a connected product and never sends", async () => {
      const s = spies();
      await render({ initial: slack, installedSkillNames: new Set(["slack"]), spies: s });

      expect(query('[role="dialog"]')?.getAttribute("aria-label")).toBe("Slack is connected");
      expect(query('[data-testid="connect-confirm-install-line"]')?.textContent).toBe(
        "The Slack skill is in this space at .agents/skills/slack.",
      );
      expect(query('[data-testid="connect-confirm-needs-line"]')).toBeNull();
      expect(query('[data-testid="connect-confirm-files-line"]')).toBeNull();
      expect(query('[data-testid="connect-confirm-submit"]')).toBeNull();
      const setUpAgain = query<HTMLButtonElement>('[data-testid="connect-confirm-set-up-again"]');
      expect(setUpAgain?.textContent).toContain("Set up again");

      await act(async () => setUpAgain?.click());
      expect(s.onSetUpAgain).toHaveBeenCalledTimes(1);
      expect(s.onSetUpAgain).toHaveBeenCalledWith(slack);
      expect(s.onConnect).not.toHaveBeenCalled();
    });

    it("disables only the sending control while a send is pending", async () => {
      const s = spies();
      await render({ initial: slack, pending: true, spies: s });

      // Pending, not disabled: the control stays in the tab order (so focus,
      // Escape and the Tab cycle survive the send) but ignores presses.
      const submit = query<HTMLButtonElement>('[data-testid="connect-confirm-submit"]');
      expect(submit?.getAttribute("aria-disabled")).toBe("true");
      expect(submit?.disabled).toBe(false);
      await act(async () => submit?.click());
      expect(s.onConnect).not.toHaveBeenCalled();

      // Cancel, the header Close and Escape stay live: leaving mid-send is
      // harmless and the flow's toast still reports the outcome.
      const cancel = query<HTMLButtonElement>('[data-testid="connect-confirm-cancel"]');
      const close = query<HTMLButtonElement>('[aria-label="Close"]');
      expect(cancel?.disabled).toBe(false);
      expect(close?.disabled).toBe(false);
      await pressEscape();
      expect(s.onClose).toHaveBeenCalledTimes(1);
      expect(query('[role="dialog"]')).toBeNull();
      expect(s.onConnect).not.toHaveBeenCalled();
    });

    it("closes through Escape and the header Close without sending", async () => {
      const s = spies();
      await render({ initial: slack, spies: s });
      await pressEscape();
      expect(s.onClose).toHaveBeenCalledTimes(1);
      expect(query('[role="dialog"]')).toBeNull();
      expect(s.onConnect).not.toHaveBeenCalled();

      await render({ initial: slack, spies: s });
      await act(async () => query<HTMLButtonElement>('[aria-label="Close"]')?.click());
      expect(s.onClose).toHaveBeenCalledTimes(2);
      expect(query('[role="dialog"]')).toBeNull();
      expect(s.onConnect).not.toHaveBeenCalled();
    });

    it("renders nothing while closed", async () => {
      const s = spies();
      await render({ initial: null, spies: s });
      expect(query('[role="dialog"]')).toBeNull();
      expect(query('[data-testid="connect-confirm-stage"]')).toBeNull();
      expect(query('[data-testid="connect-browse-stage"]')).toBeNull();
      expect(query('[data-testid="connect-confirm-submit"]')).toBeNull();
    });

    it("keeps the full connector union out of the confirm type", () => {
      // Compile-time guard: only SkillConnector reaches target/onConnect.
      const other: Connector = CONNECTORS.find((entry) => entry.id === "other")!;
      expect(other.kind).toBe("other");
      // @ts-expect-error an "other" connector has no source or skillName
      const invalid: SkillConnector = other;
      expect(invalid).toBe(other);
      const github: Connector = CONNECTORS.find((entry) => entry.id === "github")!;
      // @ts-expect-error a GitHub connector has no source or skillName
      const invalidGithub: SkillConnector = github;
      expect(invalidGithub).toBe(github);
    });
  });
});

describe("useConnectSheetState", () => {
  it("only offers Back for a confirm stage reached from the browse stage", async () => {
    // Exercised through the harness: openConfirm from a chip (no browse before
    // it) yields openedFromBrowse false, and back() then closes.
    const s = spies();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => {
      root.render(<Harness initial={slack} openKey={1} spies={s} />);
    });
    expect(lastState(s)).toEqual({ stage: "confirm", target: slack, openedFromBrowse: false });
    expect(query('[data-testid="connect-confirm-back"]')).toBeNull();
    await act(async () => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = "";
  });
});
