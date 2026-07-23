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
import { useWorkspaceStore } from "../store";
import { cloneBillingState } from "./defaults";
import type { BillingState } from "../types";

interface BillingContextValue {
  billing: BillingState;
  setBilling: (updater: (current: BillingState) => BillingState) => void;
}

const BillingContext = createContext<BillingContextValue | null>(null);

function billingStatesEqual(a: BillingState, b: BillingState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function BillingProvider({ children }: { children: ReactNode }) {
  const updateBilling = useWorkspaceStore((store) => store.updateBilling);
  const [billing, setBillingState] = useState<BillingState>(() =>
    cloneBillingState(useWorkspaceStore.getState().state.billing)
  );
  const billingRef = useRef<BillingState>(billing);

  useEffect(() => {
    billingRef.current = billing;
  }, [billing]);

  useEffect(() => {
    const unsubscribe = useWorkspaceStore.subscribe(
      (store) => store.state.billing,
      (next) => {
        const normalized = cloneBillingState(next);
        if (billingStatesEqual(normalized, billingRef.current)) {
          return;
        }
        billingRef.current = normalized;
        setBillingState(normalized);
      }
    );
    return unsubscribe;
  }, []);

  const setBilling = useCallback(
    (updater: (current: BillingState) => BillingState) => {
      const draft = cloneBillingState(billingRef.current);
      const updated = cloneBillingState(updater(draft));
      billingRef.current = updated;
      setBillingState(updated);
      updateBilling(() => cloneBillingState(updated));
    },
    [updateBilling]
  );

  const value = useMemo<BillingContextValue>(
    () => ({ billing, setBilling }),
    [billing, setBilling]
  );

  return <BillingContext.Provider value={value}>{children}</BillingContext.Provider>;
}

export function useBilling(): BillingContextValue {
  const context = useContext(BillingContext);
  if (!context) {
    throw new Error("useBilling must be used within a BillingProvider");
  }
  return context;
}
