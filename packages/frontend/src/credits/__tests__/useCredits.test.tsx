// @vitest-environment jsdom
import { act, type Context, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingState } from "../../types";
import { installPollingGate, POLLING_IDLE_AFTER_MS } from "../../runtime/pollingGate";
import * as billingModule from "../BillingProvider";
import { CREDITS_UPDATED_EVENT, CreditsProvider, useCredits } from "../useCredits";

const mocks = vi.hoisted(() => ({
  fetchCreditSnapshot: vi.fn(),
  fetchCreditLedger: vi.fn(),
  activePanel: "chat" as string,
  activeProjectId: "project-1" as string | null,
}));

vi.mock("../creditService", () => ({
  fetchCreditSnapshot: mocks.fetchCreditSnapshot,
  fetchCreditLedger: mocks.fetchCreditLedger,
}));

vi.mock("../../sdk/instafy", () => ({ runtimeControllerEnabled: true }));

vi.mock("../../workspace/useWorkspace", () => ({
  useWorkspaceUi: () => ({ activePanel: mocks.activePanel }),
}));

vi.mock("../../projects/useProject", () => ({
  useProject: () => ({ activeProjectId: mocks.activeProjectId }),
}));

// The real hook hands out a stable showStatus; a fresh mock per render would
// re-create the provider's refresh callback and loop its project effect.
const showStatus = vi.fn();
vi.mock("../../status/useStatus", () => ({
  useStatus: () => ({ showStatus }),
}));

// A minimal billing store so the snapshot merge changes the state the
// provider keys its ledger refetch on.
vi.mock("../BillingProvider", async () => {
  const { createContext, useContext, useMemo, useState } = await import("react");
  const initial = {
    creditBalance: 0,
    creditLimit: 0,
    lastCreditBurnAt: null,
    lastCreditRefillAt: null,
    subscription: null,
  };
  const BillingContext = createContext<unknown>(null);
  function BillingProvider({ children }: { children: ReactNode }) {
    // The real provider hands out a stable setter; a fresh function on every
    // render would re-create the provider's refresh callbacks and loop.
    const [billing, setBilling] = useState(initial);
    const value = useMemo(() => ({ billing, setBilling }), [billing]);
    return <BillingContext.Provider value={value}>{children}</BillingContext.Provider>;
  }
  return { BillingContext, BillingProvider, useBilling: () => useContext(BillingContext) };
});

const { BillingProvider } = billingModule as unknown as {
  BillingContext: Context<{ billing: BillingState } | null>;
  BillingProvider: (props: { children: ReactNode }) => ReactElement;
};

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

function touch() {
  window.dispatchEvent(new Event("pointerdown"));
}

function snapshot(balance: number) {
  return {
    success: true,
    snapshot: { balance, creditLimit: 100, lastBurnAt: null, lastRefillAt: null, subscription: null },
  };
}

function Probe() {
  const { billing, ledger } = useCredits();
  return <div data-balance={billing.creditBalance} data-ledger={ledger.length} data-testid="probe" />;
}

describe("useCredits timers", () => {
  let container: HTMLDivElement;
  let root: Root;

  function render() {
    return act(async () => {
      root.render(
        <BillingProvider>
          <CreditsProvider>
            <Probe />
          </CreditsProvider>
        </BillingProvider>,
      );
      await Promise.resolve();
    });
  }

  async function advance(ms: number) {
    await act(async () => {
      vi.advanceTimersByTime(ms);
      await Promise.resolve();
    });
  }

  function balance(): string | null {
    return container.querySelector("[data-testid=probe]")?.getAttribute("data-balance") ?? null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    installPollingGate();
    setVisibility("visible");
    touch();
    mocks.activePanel = "chat";
    mocks.activeProjectId = "project-1";
    mocks.fetchCreditSnapshot.mockReset();
    mocks.fetchCreditSnapshot.mockResolvedValue(snapshot(100));
    mocks.fetchCreditLedger.mockReset();
    mocks.fetchCreditLedger.mockResolvedValue({ success: true, entries: [] });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    setVisibility("visible");
    vi.useRealTimers();
  });

  it("fetches the status once a minute while visible and not at all while hidden", async () => {
    await render();
    expect(mocks.fetchCreditSnapshot).toHaveBeenCalledTimes(1);
    expect(balance()).toBe("100");
    await advance(59_999);
    expect(mocks.fetchCreditSnapshot).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(mocks.fetchCreditSnapshot).toHaveBeenCalledTimes(2);

    await act(async () => setVisibility("hidden"));
    await advance(300_000);
    expect(mocks.fetchCreditSnapshot).toHaveBeenCalledTimes(2);

    await act(async () => setVisibility("visible"));
    expect(mocks.fetchCreditSnapshot).toHaveBeenCalledTimes(3);
    expect(mocks.fetchCreditLedger).not.toHaveBeenCalled();
  });

  it("refreshes the status every 15 s while the Credits panel is open and the user is active, never while idle", async () => {
    mocks.activePanel = "credits";
    await render();
    expect(mocks.fetchCreditSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.fetchCreditLedger).toHaveBeenCalledTimes(1);

    await advance(15_000);
    expect(mocks.fetchCreditSnapshot).toHaveBeenCalledTimes(2);
    await advance(15_000);
    expect(mocks.fetchCreditSnapshot).toHaveBeenCalledTimes(3);
    await advance(15_000);
    expect(mocks.fetchCreditSnapshot).toHaveBeenCalledTimes(4);

    await advance(POLLING_IDLE_AFTER_MS);
    const atIdle = mocks.fetchCreditSnapshot.mock.calls.length;
    await advance(200_000);
    expect(mocks.fetchCreditSnapshot).toHaveBeenCalledTimes(atIdle);

    await act(async () => touch());
    expect(mocks.fetchCreditSnapshot).toHaveBeenCalledTimes(atIdle + 1);
    await advance(15_000);
    expect(mocks.fetchCreditSnapshot).toHaveBeenCalledTimes(atIdle + 2);
  });

  it("refetches the ledger when the snapshot balance changes and not otherwise", async () => {
    mocks.activePanel = "credits";
    await render();
    expect(mocks.fetchCreditLedger).toHaveBeenCalledTimes(1);

    await advance(15_000);
    expect(mocks.fetchCreditSnapshot).toHaveBeenCalledTimes(2);
    expect(mocks.fetchCreditLedger).toHaveBeenCalledTimes(1);

    mocks.fetchCreditSnapshot.mockResolvedValue(snapshot(90));
    await advance(15_000);
    expect(balance()).toBe("90");
    expect(mocks.fetchCreditLedger).toHaveBeenCalledTimes(2);

    await advance(15_000);
    expect(mocks.fetchCreditLedger).toHaveBeenCalledTimes(2);
  });

  it("refetches the ledger once a minute as a fallback while the panel is open", async () => {
    mocks.activePanel = "credits";
    await render();
    expect(mocks.fetchCreditLedger).toHaveBeenCalledTimes(1);
    await advance(59_999);
    expect(mocks.fetchCreditLedger).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(mocks.fetchCreditLedger).toHaveBeenCalledTimes(2);
  });

  it("does not touch the ledger while the panel is closed", async () => {
    await render();
    await advance(120_000);
    expect(mocks.fetchCreditLedger).not.toHaveBeenCalled();
  });

  it("forces both fetches on the credits-updated event when the panel is open, only the status otherwise", async () => {
    await render();
    expect(mocks.fetchCreditSnapshot).toHaveBeenCalledTimes(1);
    await act(async () => {
      window.dispatchEvent(new Event(CREDITS_UPDATED_EVENT));
      await Promise.resolve();
    });
    expect(mocks.fetchCreditSnapshot).toHaveBeenCalledTimes(2);
    expect(mocks.fetchCreditLedger).not.toHaveBeenCalled();

    mocks.activePanel = "credits";
    await render();
    expect(mocks.fetchCreditLedger).toHaveBeenCalledTimes(1);
    await act(async () => {
      window.dispatchEvent(new Event(CREDITS_UPDATED_EVENT));
      await Promise.resolve();
    });
    expect(mocks.fetchCreditSnapshot).toHaveBeenCalledTimes(3);
    expect(mocks.fetchCreditLedger).toHaveBeenCalledTimes(2);
  });

  it("loads the ledger again after switching projects", async () => {
    mocks.activePanel = "credits";
    await render();
    expect(mocks.fetchCreditLedger).toHaveBeenCalledTimes(1);
    expect(mocks.fetchCreditLedger).toHaveBeenLastCalledWith("project-1", 100);

    mocks.activeProjectId = "project-2";
    await render();
    expect(mocks.fetchCreditSnapshot).toHaveBeenLastCalledWith("project-2");
    expect(mocks.fetchCreditLedger.mock.calls.some(([projectId]) => projectId === "project-2")).toBe(true);
  });
});
