import type { ReactNode } from "react";
import { RuntimeStateProvider } from "./RuntimeStateProvider";
import { RuntimeOperationsProvider } from "./RuntimeOperationsProvider";

export function RuntimeProvider({ children }: { children: ReactNode }) {
  return (
    <RuntimeStateProvider>
      <RuntimeOperationsProvider>{children}</RuntimeOperationsProvider>
    </RuntimeStateProvider>
  );
}
