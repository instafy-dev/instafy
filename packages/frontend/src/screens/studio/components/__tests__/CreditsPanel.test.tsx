// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreditsPanel } from "../CreditsPanel";

type LedgerRow = {
  delta: number; reason: string; metadata: Record<string, unknown> | null; createdAt: string; chatName?: string;
  spaceName?: string;
};
const TEAM_SPACE = [{ id: "project-a", orgName: "Acme Research" }];
const mocks = vi.hoisted(() => ({ checkout: vi.fn(), portal: vi.fn(), planChange: vi.fn(), showStatus: vi.fn(),
  billing: { creditBalance: 1000, creditLimit: 2000, subscription: null }, ledger: [] as LedgerRow[],
  projectList: [] as { id: string; orgName: string }[] }));
vi.mock("../../../../credits/useCredits", () => ({ CREDITS_UPDATED_EVENT: "credits-updated", useCredits: () => ({
  billing: mocks.billing, controllerEnabled: false,
  hasLoaded: true, lastError: null, ledger: mocks.ledger, ledgerError: null, refresh: async () => {},
}) }));
vi.mock("../../../../credits/creditService", () => ({ fetchCreditPolicy: vi.fn() }));
vi.mock("../../../../credits/checkoutService", () => ({ requestCheckoutSession: mocks.checkout,
  requestBillingPortalSession: mocks.portal, requestPlanChange: mocks.planChange }));
vi.mock("../../../../projects/useProjects", () => ({
  useProjects: () => ({ activeProjectId: "project-a", projectList: mocks.projectList }),
}));
vi.mock("../../../../status/useStatus", () => ({ useStatus: () => ({ showStatus: mocks.showStatus }) }));
vi.mock("../SettingsShell", () => ({ SettingsShell: ({ title, categories, onCategoryChange, children }: {
  title: string; categories: { id: string; label: string }[]; onCategoryChange: (id: string) => void; children: ReactNode;
}) => (
  <div>
    <h1 data-testid="settings-title">{title}</h1>
    <nav>{categories.map((category) => (
      <button key={category.id} type="button" data-testid={`section-${category.id}`} onClick={() => onCategoryChange(category.id)}>
        {category.label}
      </button>
    ))}</nav>
    {children}
  </div>
) }));

describe("Credits display choices", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.billing = { creditBalance: 1000, creditLimit: 2000, subscription: null };
    mocks.ledger = [];
    mocks.projectList = TEAM_SPACE;
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  const radio = (testId: string) => container.querySelector<HTMLInputElement>(`[data-testid="${testId}"] input[type="radio"]`)!;
  it("uses labelled exclusive choices for amounts, activity view and graph range without changing billing", async () => {
    await act(async () => root.render(<MemoryRouter><CreditsPanel /></MemoryRouter>));
    expect(container.querySelector('[role="radiogroup"][aria-label="Credit display units"]')).not.toBeNull();
    expect(container.querySelector('[role="radiogroup"][aria-label="Activity view"]')).not.toBeNull();
    expect(radio("credits-amount-view-units").checked).toBe(true);
    await act(async () => radio("credits-amount-view-usd").click());
    expect(radio("credits-amount-view-usd").checked).toBe(true);
    expect(radio("credits-amount-view-units").checked).toBe(false);
    expect(container.querySelector('[data-testid="credits-balance"]')?.textContent).toBe("$1.00");
    await act(async () => radio("credits-activity-view-graph").click());
    expect(radio("credits-activity-view-graph").checked).toBe(true);
    expect(container.querySelector('[role="radiogroup"][aria-label="Activity graph range"]')).not.toBeNull();
    await act(async () => radio("credits-graph-range-30d").click());
    expect(radio("credits-graph-range-30d").checked).toBe(true);
    expect(radio("credits-graph-range-7d").checked).toBe(false);
    expect(mocks.checkout).not.toHaveBeenCalled();
    expect(mocks.portal).not.toHaveBeenCalled();
    expect(mocks.planChange).not.toHaveBeenCalled();
  });

  // Local drive, Oct 28: "897 / 800" read as a balance past its own limit, with
  // "Starter resets to 200 credits daily · resets at 00:00 UTC" under it.
  // Local drive 4: the line said "every day at 00:00 UTC", but the ledger tops
  // a balance up the first time it finds it under the limit that UTC day, at
  // any hour (+1 at 10:06 UTC, a moment after a turn took 800 to 799), so the
  // line names no hour.
  it("shows the balance as a number of credits and one line for the daily refill", async () => {
    mocks.billing = { creditBalance: 897, creditLimit: 800, subscription: null };
    await act(async () => root.render(<MemoryRouter><CreditsPanel /></MemoryRouter>));
    const row = container.querySelector('[data-testid="credits-balance-row"]');
    expect(row?.textContent).toBe("897credits");
    expect(row?.textContent).not.toContain("/");
    expect(row?.textContent).not.toContain("800");
    const refill = container.querySelector('[data-testid="credits-starter-budget"]');
    expect(refill?.textContent).toBe("Tops back up to 800 credits once a day");
    // The refill names the team's own limit, which the payment checks read.
    expect(container.querySelector('[data-testid="credits-limit"]')?.textContent).toBe("800");
    expect(container.textContent).not.toMatch(/resets to|soft cap|managed AI/i);

    await act(async () => radio("credits-amount-view-usd").click());
    expect(row?.textContent).toBe("$0.90");
    expect(refill?.textContent).toBe("Tops back up to $0.80 once a day");
  });

  // Local drives 2 and 3: "Refills to 800 credits every day" read as 800 added
  // each day, next to daily refills of +200. The daily refill adds what tops a
  // balance under the team's limit back up to it (credits.rs
  // attempt_daily_refill), so the line and the ledger row both say "top up".
  it("names the daily top-up the same way in the refill line and the activity log", async () => {
    mocks.billing = { creditBalance: 800, creditLimit: 800, subscription: null };
    mocks.ledger = [
      { delta: -1, reason: "managed_ai_prompt", metadata: null, createdAt: "2026-10-29T09:00:00Z" },
      { delta: 200, reason: "auto_refill_daily", metadata: { creditLimit: 800, preRefillBalance: 600 }, createdAt: "2026-10-29T00:01:00Z" },
    ];
    await act(async () => root.render(<MemoryRouter><CreditsPanel /></MemoryRouter>));
    expect(container.querySelector('[data-testid="credits-starter-budget"]')?.textContent).toMatch(/^Tops back up to 800 /);
    const rows = [...container.querySelectorAll('[data-testid="credit-ledger-entry"]')];
    expect(rows[1]?.textContent).toContain("Daily top-up");
    expect(rows[1]?.textContent).toContain("+200 credits");
    expect(container.textContent).not.toMatch(/refill/i);
    expect(container.textContent).not.toMatch(/at 00:00|UTC/);

    // The graph's key names the same rows: credits added, never "Refill".
    await act(async () => radio("credits-activity-view-graph").click());
    expect(container.querySelector('[data-testid="credit-activity-graph"]')).not.toBeNull();
    expect(container.textContent).toContain("Added");
    expect(container.textContent).not.toMatch(/refill/i);
  });

  // Local drive 4: every turn was two rows at different times, "AI usage −1"
  // and "AI adjustment −13", each reading "Instafy AI · GPT-6 Luna · OpenAI ·
  // 66k tokens", with no chat named, and "−1 credits". The ledger keeps those
  // details; the person reads what each chat cost.
  it("shows one row per turn, named by its chat, without the model, vendor or tokens", async () => {
    const ai = (extra: Record<string, unknown>) => ({
      managedAiLabel: "Instafy AI", managedAiModelLabel: "GPT-6 Luna", managedAiProvider: "openai",
      usage: { input_tokens: 151556, cached_input_tokens: 76928, output_tokens: 200 }, ...extra,
    });
    const lisbon = "Plan 3 days in Lisbon for a first visit…";
    mocks.ledger = [
      { delta: -13, reason: "managed_ai_adjustment", metadata: ai({ promptId: "turn-lisbon" }),
        createdAt: "2026-10-29T09:52:53Z", chatName: lisbon },
      // A turn that failed and left nothing got its credit back: it cost nothing.
      { delta: 1, reason: "managed_ai_refund", metadata: ai({ promptId: "turn-failed" }),
        createdAt: "2026-10-29T10:08:17Z", chatName: "Compare the three latest Roborock…" },
      { delta: -1, reason: "managed_ai_prompt", metadata: ai({ promptId: "turn-failed" }),
        createdAt: "2026-10-29T10:07:52Z", chatName: "Compare the three latest Roborock…" },
      { delta: 1, reason: "auto_refill_daily", metadata: { creditLimit: 800, preRefillBalance: 799 },
        createdAt: "2026-10-29T10:06:09Z" },
      // A teammate's private chat: the controller names no chat.
      { delta: -3, reason: "managed_ai_prompt", metadata: ai({ promptId: "turn-teammate" }),
        createdAt: "2026-10-29T09:51:00Z" },
      { delta: -1, reason: "managed_ai_prompt", metadata: ai({ promptId: "turn-lisbon" }),
        createdAt: "2026-10-29T09:49:47Z", chatName: lisbon },
    ];
    await act(async () => root.render(<MemoryRouter><CreditsPanel /></MemoryRouter>));
    const rows = [...container.querySelectorAll('[data-testid="credit-ledger-entry"]')];
    expect(rows.map((row) => [
      row.querySelector("p")?.textContent,
      row.querySelector('[data-testid="credit-ledger-delta"]')?.textContent,
    ])).toEqual([
      ["Daily top-up", "+1 credit"],
      ["A chat", "-3 credits"],
      [lisbon, "-14 credits"],
    ]);
    // Sent at 09:49:47: the turn sits where it was sent, under the top-up.
    expect(rows[2]?.textContent).toContain(new Date("2026-10-29T09:49:47Z").toLocaleString());
    expect(container.textContent).not.toMatch(/AI usage|AI adjustment|AI refund|GPT|OpenAI|tokens|Instafy AI|1 credits/);
  });

  // The ledger is the team's: a chat of the same name in another space read
  // the same as this space's.
  it("names the space of a turn from another space beside its time", async () => {
    mocks.ledger = [
      { delta: -2, reason: "managed_ai_prompt", metadata: { promptId: "turn-other" },
        createdAt: "2026-10-29T10:00:00Z", chatName: "Plan 3 days in Lisbon", spaceName: "Last week's space" },
      { delta: -1, reason: "managed_ai_prompt", metadata: { promptId: "turn-here" },
        createdAt: "2026-10-29T09:00:00Z", chatName: "Plan 3 days in Lisbon" },
    ];
    await act(async () => root.render(<MemoryRouter><CreditsPanel /></MemoryRouter>));
    const captions = [...container.querySelectorAll('[data-testid="credit-ledger-entry"]')]
      .map((row) => row.querySelectorAll("p")[1]?.textContent);
    expect(captions).toEqual([
      `Last week's space · ${new Date("2026-10-29T10:00:00Z").toLocaleString()}`,
      new Date("2026-10-29T09:00:00Z").toLocaleString(),
    ]);
  });

  // A local drive, in a space of the person's own: "Team credits", "Shared
  // team balance" and "AI, runtime, and live access spend all land in this
  // shared ledger". Nobody shares that balance. A team's space keeps its words.
  it("says Credits and Balance in a personal space, with no team, shared ledger or live access", async () => {
    mocks.projectList = [{ id: "project-a", orgName: "Personal" }];
    mocks.ledger = [{ delta: -1, reason: "managed_ai_prompt", metadata: null, createdAt: "2026-10-29T09:00:00Z" }];
    await act(async () => root.render(<MemoryRouter><CreditsPanel /></MemoryRouter>));
    expect(container.querySelector('[data-testid="settings-title"]')?.textContent).toBe("Credits");
    expect(container.querySelector('[data-testid="credits-balance-label"]')?.textContent).toBe("Balance");
    expect(container.textContent).toContain("Recent balance activity");
    expect(container.textContent).not.toMatch(/team|shared|ledger|live access/i);
    // Plans and Usage say whose balance it is the same way (a plan made for
    // teams still says so).
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="section-plans"]')!.click());
    expect(container.textContent).toContain("Your balance tops back up daily (UTC) to the selected plan limit.");
    expect(container.textContent).not.toMatch(/shared|team-specific|your team/i);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="section-usage"]')!.click());
    expect(container.textContent).toContain("hosted runtimes all burn from the same balance.");
    expect(container.textContent).not.toMatch(/team|shared/i);

    await act(async () => root.unmount());
    root = createRoot(container);
    mocks.projectList = TEAM_SPACE;
    await act(async () => root.render(<MemoryRouter><CreditsPanel /></MemoryRouter>));
    expect(container.querySelector('[data-testid="settings-title"]')?.textContent).toBe("Team credits");
    expect(container.querySelector('[data-testid="credits-balance-label"]')?.textContent).toBe("Shared team balance");
    expect(container.textContent).toContain("AI, runtime, and live access spend all land in this shared ledger.");
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="section-plans"]')!.click());
    expect(container.textContent).toContain("Your shared balance tops back up daily (UTC)");
    expect(container.textContent).toContain("team-specific overrides may apply.");
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="section-usage"]')!.click());
    expect(container.textContent).toContain("hosted runtimes all burn from the same team balance.");
  });

  // Local drive 3: Activity showed only the newest 8 rows, with no way to see more.
  it("shows the newest 8 activity rows, then more of what it loaded on Show more", async () => {
    mocks.ledger = Array.from({ length: 30 }, (_, index) => ({
      delta: -1,
      reason: "managed_ai_prompt",
      metadata: null,
      createdAt: new Date(Date.UTC(2026, 9, 29, 12, 59 - index)).toISOString(),
    }));
    await act(async () => root.render(<MemoryRouter><CreditsPanel /></MemoryRouter>));
    const rows = () => container.querySelectorAll('[data-testid="credit-ledger-entry"]');
    const showMore = () => container.querySelector<HTMLButtonElement>('[data-testid="credits-activity-show-more"]');
    expect(rows()).toHaveLength(8);
    expect(showMore()?.textContent).toBe("Show more");

    await act(async () => showMore()!.click());
    expect(rows()).toHaveLength(28);
    // Focus moves to the first row it revealed.
    expect(document.activeElement).toBe(rows()[8]);
    // That row rounds only while its focus ring shows: rounded for good, it
    // would bend the ends of the divider under it.
    expect(rows()[8]?.className.split(/\s+/)).not.toContain("rounded-lg");
    expect(rows()[8]?.className).toContain("focus-visible:rounded-lg");

    await act(async () => showMore()!.click());
    expect(rows()).toHaveLength(30);
    expect(document.activeElement).toBe(rows()[28]);
    // Everything loaded is shown: the button goes.
    expect(showMore()).toBeNull();
  });
});
