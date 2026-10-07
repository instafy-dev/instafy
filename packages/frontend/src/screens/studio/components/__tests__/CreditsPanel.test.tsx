// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreditsPanel } from "../CreditsPanel";

const mocks = vi.hoisted(() => ({ checkout: vi.fn(), portal: vi.fn(), planChange: vi.fn(), showStatus: vi.fn() }));
vi.mock("../../../../credits/useCredits", () => ({ CREDITS_UPDATED_EVENT: "credits-updated", useCredits: () => ({
  billing: { creditBalance: 1000, creditLimit: 2000, subscription: null }, controllerEnabled: false,
  hasLoaded: true, lastError: null, ledger: [], ledgerError: null, refresh: async () => {},
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
});
