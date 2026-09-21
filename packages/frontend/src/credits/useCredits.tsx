import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import type { BillingState } from "../types";
import { useWorkspaceUi } from "../workspace/useWorkspace";
import {
  fetchCreditLedger,
  fetchCreditSnapshot,
  type CreditLedgerEntry,
  type CreditSnapshot
} from "./creditService";
import { cloneBillingState } from "./defaults";
import { useStatus } from "../status/useStatus";
import { useBilling } from "./BillingProvider";
import { useProject } from "../projects/useProject";
import { runtimeControllerEnabled } from "../sdk/instafy";
import { isPollingActive, useGatedInterval } from "../runtime/pollingGate";

/**
 * Window event that says the credit balance or plan changed server-side
 * (published by the controller as credits.updated and forwarded by the sync
 * hook). The provider refreshes the snapshot on it, and the ledger too while
 * the Credits panel is open, so the gated timers below are only a fallback.
 */
export const CREDITS_UPDATED_EVENT = "instafy:credits-updated";

// Every tab keeps one status refresh per minute while the user is active,
// one per five minutes once idle and none while hidden. The Credits panel
// adds a faster loop only while it is open and the user is active.
const STATUS_ACTIVE_MS = 60_000;
const STATUS_IDLE_MS = 300_000;
const PANEL_STATUS_ACTIVE_MS = 15_000;
const LEDGER_FALLBACK_ACTIVE_MS = 60_000;

interface CreditsContextValue {
  billing: BillingState;
  isLoading: boolean;
  /** True once a snapshot has loaded for the active project — before that the
   * billing numbers are placeholder zeros, not a real balance. */
  hasLoaded: boolean;
  controllerEnabled: boolean;
  lastError: string | null;
  refresh: (options?: { force?: boolean; notifyOnError?: boolean }) => Promise<void>;
  ledger: CreditLedgerEntry[];
  ledgerLoading: boolean;
  ledgerError: string | null;
  refreshLedger: (options?: { force?: boolean; notifyOnError?: boolean }) => Promise<void>;
}

const CreditsContext = createContext<CreditsContextValue | null>(null);

function mergeSnapshotIntoBilling(current: BillingState, snapshot: CreditSnapshot): BillingState {
  return {
    ...current,
    creditBalance: snapshot.balance,
    creditLimit: snapshot.creditLimit ?? current.creditLimit,
    lastCreditBurnAt: snapshot.lastBurnAt ?? current.lastCreditBurnAt,
    lastCreditRefillAt: snapshot.lastRefillAt ?? current.lastCreditRefillAt,
    subscription:
      snapshot.subscription === undefined ? current.subscription : snapshot.subscription
  };
}

export function CreditsProvider({ children }: { children: ReactNode }) {
  const { activePanel } = useWorkspaceUi();
  const { activeProjectId } = useProject();
  const { billing, setBilling } = useBilling();
  const { showStatus } = useStatus();

  const [isLoading, setIsLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const snapshotInFlightRef = useRef(false);
  const lastSnapshotProjectRef = useRef<string | null>(null);
  const activeProjectIdRef = useRef<string | null>(activeProjectId ?? null);
  activeProjectIdRef.current = activeProjectId ?? null;
  const [ledger, setLedger] = useState<CreditLedgerEntry[]>([]);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const ledgerInFlightRef = useRef(false);
  const lastLedgerProjectRef = useRef<string | null>(null);

  const applyBilling = useCallback(
    (updater: (current: BillingState) => BillingState) => {
      setBilling((current) => {
        const draft = cloneBillingState(current);
        const updated = updater(draft);
        return cloneBillingState(updated);
      });
    },
    [setBilling]
  );

  useEffect(() => {
    lastSnapshotProjectRef.current = null;
    lastLedgerProjectRef.current = null;
    setHasLoaded(false);
  }, [activeProjectId]);

  const refresh = useCallback(
    async (options?: { force?: boolean; notifyOnError?: boolean }) => {
      if (!activeProjectId) {
        return;
      }
      if (snapshotInFlightRef.current) {
        return;
      }
      if (!options?.force && lastSnapshotProjectRef.current === activeProjectId) {
        return;
      }
      const notifyOnError = options?.notifyOnError ?? Boolean(options?.force);
      const projectAtStart = activeProjectId;
      snapshotInFlightRef.current = true;
      setIsLoading(true);
      setLastError(null);
      try {
        const response = await fetchCreditSnapshot(activeProjectId);
        // The user may have switched projects while this request was in
        // flight — a stale snapshot must not be applied to the new project.
        if (activeProjectIdRef.current !== projectAtStart) {
          return;
        }
        if (response.success && response.snapshot) {
          applyBilling((current) => mergeSnapshotIntoBilling(current, response.snapshot as CreditSnapshot));
          lastSnapshotProjectRef.current = activeProjectId;
          setHasLoaded(true);
        } else if (!response.success) {
          const errorMessage = response.error ?? "Unable to load credits";
          setLastError(errorMessage);
          if (notifyOnError) {
            showStatus(errorMessage, "error", 4000);
          }
        }
      } catch (error) {
        if (notifyOnError) {
          const message = error instanceof Error ? error.message : "Unable to load credits";
          showStatus(message, "error", 4000);
        }
        setLastError(error instanceof Error ? error.message : String(error));
      } finally {
        snapshotInFlightRef.current = false;
        setIsLoading(false);
      }
    },
    [activeProjectId, applyBilling, showStatus]
  );

  useEffect(() => {
    if (activePanel === "credits") {
      void refresh();
    }
  }, [activePanel, refresh]);

  useEffect(() => {
    if (!runtimeControllerEnabled) {
      return;
    }
    if (!activeProjectId) {
      return;
    }
    void refresh({ force: true, notifyOnError: false });
  }, [activeProjectId, refresh]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const activePanelRef = useRef(activePanel);
  activePanelRef.current = activePanel;

  useGatedInterval(
    () => {
      if (!runtimeControllerEnabled) {
        return;
      }
      void refreshRef.current({ force: true, notifyOnError: false });
    },
    STATUS_ACTIVE_MS,
    { idleMs: STATUS_IDLE_MS }
  );

  // While the Credits panel is open the balance refreshes every 15 s, but
  // only while the user is active; idle ticks and the wake run into idle are
  // skipped, and the 60 s loop above stays the slow path.
  useGatedInterval(
    () => {
      if (!runtimeControllerEnabled || activePanelRef.current !== "credits" || !isPollingActive()) {
        return;
      }
      void refreshRef.current({ force: true, notifyOnError: false });
    },
    PANEL_STATUS_ACTIVE_MS
  );

  const refreshLedger = useCallback(
    async (options?: { force?: boolean; notifyOnError?: boolean }) => {
      if (!activeProjectId) {
        return;
      }
      if (ledgerInFlightRef.current) {
        return;
      }
      if (!options?.force && lastLedgerProjectRef.current === activeProjectId) {
        return;
      }
      const notifyOnError = options?.notifyOnError ?? Boolean(options?.force);
      ledgerInFlightRef.current = true;
      setLedgerLoading(true);
      setLedgerError(null);
      try {
        const response = await fetchCreditLedger(activeProjectId, 100);
        if (response.success && response.entries) {
          setLedger(response.entries);
          lastLedgerProjectRef.current = activeProjectId;
        } else if (!response.success) {
          const message = response.error ?? "Unable to load credit activity.";
          setLedgerError(message);
          if (notifyOnError) {
            showStatus(message, "error", 4000);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to load credit activity.";
        setLedgerError(message);
        if (notifyOnError) {
          showStatus(message, "error", 4000);
        }
      } finally {
        ledgerInFlightRef.current = false;
        setLedgerLoading(false);
      }
    },
    [activeProjectId, showStatus]
  );

  const refreshLedgerRef = useRef(refreshLedger);
  refreshLedgerRef.current = refreshLedger;

  // The ledger only changes when the balance does, so a new snapshot is the
  // trigger for a ledger refetch while the panel is open. Opening the panel
  // loads it once per project; a later balance change forces a refetch.
  const snapshotKey = `${billing.creditBalance}|${billing.lastCreditBurnAt ?? ""}|${billing.lastCreditRefillAt ?? ""}`;
  const lastLedgerSnapshotKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (activePanel !== "credits") {
      return;
    }
    if (!hasLoaded) {
      // The first snapshot is still on its way; load the ledger once and
      // start keying changes only from a real balance, so opening the panel
      // costs one ledger request rather than two.
      lastLedgerSnapshotKeyRef.current = null;
      void refreshLedger();
      return;
    }
    const snapshotChanged =
      lastLedgerSnapshotKeyRef.current !== null && lastLedgerSnapshotKeyRef.current !== snapshotKey;
    lastLedgerSnapshotKeyRef.current = snapshotKey;
    void refreshLedger(snapshotChanged ? { force: true, notifyOnError: false } : undefined);
  }, [activePanel, hasLoaded, refreshLedger, snapshotKey]);

  // Fallback for ledger rows with no net balance effect: once a minute while
  // active, slower while idle, never while hidden or with the panel closed.
  useGatedInterval(
    () => {
      if (!runtimeControllerEnabled || activePanelRef.current !== "credits") {
        return;
      }
      void refreshLedgerRef.current({ force: true, notifyOnError: false });
    },
    LEDGER_FALLBACK_ACTIVE_MS
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handleCreditsUpdated = () => {
      void refreshRef.current({ force: true, notifyOnError: false });
      if (activePanelRef.current === "credits") {
        void refreshLedgerRef.current({ force: true, notifyOnError: false });
      }
    };
    window.addEventListener(CREDITS_UPDATED_EVENT, handleCreditsUpdated);
    return () => window.removeEventListener(CREDITS_UPDATED_EVENT, handleCreditsUpdated);
  }, []);

  const value = useMemo<CreditsContextValue>(
    () => ({
      billing,
      isLoading,
      hasLoaded,
      controllerEnabled: runtimeControllerEnabled,
      lastError,
      refresh,
      ledger,
      ledgerLoading,
      ledgerError,
      refreshLedger
    }),
    [billing, isLoading, hasLoaded, lastError, refresh, ledger, ledgerLoading, ledgerError, refreshLedger]
  );

  return <CreditsContext.Provider value={value}>{children}</CreditsContext.Provider>;
}

export function useCredits(): CreditsContextValue {
  const context = useContext(CreditsContext);
  if (!context) {
    throw new Error("useCredits must be used within a CreditsProvider");
  }
  return context;
}

export function formatCreditReminder(balance?: number | null) {
  if (balance === undefined || balance === null) {
    return "";
  }
  if (balance <= 0) {
    return "No credits remain—refill to keep generating.";
  }
  if (balance <= 2) {
    return `Only ${balance} credit${balance === 1 ? "" : "s"} left—refill soon.`;
  }
  return `${balance} credits remaining.`;
}
