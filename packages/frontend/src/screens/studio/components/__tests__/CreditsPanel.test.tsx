// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreditsPanel } from "../CreditsPanel";

type LedgerRow = { delta: number; reason: string; metadata: Record<string, unknown> | null; createdAt: string };
const mocks = vi.hoisted(() => ({ checkout: vi.fn(), portal: vi.fn(), planChange: vi.fn(), showStatus: vi.fn(),
  billing: { creditBalance: 1000, creditLimit: 2000, subscription: null }, ledger: [] as LedgerRow[] }));
vi.mock("../../../../credits/useCredits", () => ({ CREDITS_UPDATED_EVENT: "credits-updated", useCredits: () => ({
  billing: mocks.billing, controllerEnabled: false,
  hasLoaded: true, lastError: null, ledger: mocks.ledger, ledgerError: null, refresh: async () => {},
}) }));
vi.mock("../../../../credits/creditService", () => ({ fetchCreditPolicy: vi.fn() }));
vi.mock("../../../../credits/checkoutService", () => ({ requestCheckoutSession: mocks.checkout,
  requestBillingPortalSession: mocks.portal, requestPlanChange: mocks.planChange }));
vi.mock("../../../../projects/useProjects", () => ({ useProjects: () => ({ activeProjectId: "project-a" }) }));
vi.mock("../../../../status/useStatus", () => ({ useStatus: () => ({ showStatus: mocks.showStatus }) }));
vi.mock("../SettingsShell", () => ({ SettingsShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

describe("Credits display choices", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.billing = { creditBalance: 1000, creditLimit: 2000, subscription: null };
    mocks.ledger = [];
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
  it("shows the balance as a number of credits and one line for the daily refill", async () => {
    mocks.billing = { creditBalance: 897, creditLimit: 800, subscription: null };
    await act(async () => root.render(<MemoryRouter><CreditsPanel /></MemoryRouter>));
    const row = container.querySelector('[data-testid="credits-balance-row"]');
    expect(row?.textContent).toBe("897credits");
    expect(row?.textContent).not.toContain("/");
    expect(row?.textContent).not.toContain("800");
    const refill = container.querySelector('[data-testid="credits-starter-budget"]');
    expect(refill?.textContent).toBe("Tops back up to 800 credits every day at 00:00 UTC");
    // The refill names the team's own limit, which the payment checks read.
    expect(container.querySelector('[data-testid="credits-limit"]')?.textContent).toBe("800");
    expect(container.textContent).not.toMatch(/resets to|soft cap|managed AI/i);

    await act(async () => radio("credits-amount-view-usd").click());
    expect(row?.textContent).toBe("$0.90");
    expect(refill?.textContent).toBe("Tops back up to $0.80 every day at 00:00 UTC");
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

    // The graph's key names the same rows: credits added, never "Refill".
    await act(async () => radio("credits-activity-view-graph").click());
    expect(container.querySelector('[data-testid="credit-activity-graph"]')).not.toBeNull();
    expect(container.textContent).toContain("Added");
    expect(container.textContent).not.toMatch(/refill/i);
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
