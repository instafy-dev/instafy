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
    if (typeof window === "undefined") {
      return;
    }
    const intervalId = window.setInterval(() => {
      void refresh({ force: true, notifyOnError: false });
    }, 60_000);
    return () => window.clearInterval(intervalId);
  }, [activeProjectId, refresh]);

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

  useEffect(() => {
    if (activePanel === "credits") {
      void refreshLedger();
    }
  }, [activePanel, refreshLedger]);

  useEffect(() => {
    if (activePanel !== "credits") {
      return;
    }
    if (!runtimeControllerEnabled) {
      return;
    }
    if (!activeProjectId) {
      return;
    }
    if (typeof window === "undefined") {
      return;
    }
    const intervalId = window.setInterval(() => {
      void refresh({ force: true, notifyOnError: false });
    }, 5_000);
    return () => window.clearInterval(intervalId);
  }, [activePanel, activeProjectId, refresh]);

  useEffect(() => {
    if (activePanel !== "credits") {
      return;
    }
    if (!runtimeControllerEnabled) {
      return;
    }
    if (!activeProjectId) {
      return;
    }
    if (typeof window === "undefined") {
      return;
    }
    const intervalId = window.setInterval(() => {
      void refreshLedger({ force: true, notifyOnError: false });
    }, 10_000);
    return () => window.clearInterval(intervalId);
  }, [activePanel, activeProjectId, refreshLedger]);

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
