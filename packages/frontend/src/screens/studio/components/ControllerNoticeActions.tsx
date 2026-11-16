import { createContext, useContext, type ReactNode } from "react";
import type { ControllerConversationNoticeAction } from "./controllerConversationNotice";

export type ControllerNoticeActionsContextValue = {
  /** Opens the Machines page, where runtimes actually live. */
  onOpenMachines: () => void;
  /**
   * Opens the self-host dialog: the copyable `instafy runtime start` command,
   * plus a real Start button inside the desktop app. This is the only way a
   * self-hosted runtime comes into existence, so it is the only honest answer
   * to "no self-hosted runtime was online".
   */
  onShowSelfHostHelp: () => void;
  /** Opens the credits page, for a run refused because the team is out. */
  onOpenCredits: () => void;
  /** Re-runs a schedule. Owner-only — the controller refuses anyone else. */
  onRunAutomation: (automationId: string) => void;
  /** Who is reading, so an owner-only action knows whether to render. */
  viewerUserId: string | null;
  /**
   * Whether the reader can change this space, so a notice tells only someone
   * who can to start, reconnect or stop a machine in Machines
   * (`resolveControllerConversationNoticeContent`).
   */
  canChangeSpace: boolean;
};

/**
 * Supplied by StudioLayout, around every chat it shows. Nullable on purpose:
 * the notice card also renders in thread previews and in tests that mock
 * neither the workspace tabs nor the runtime provider. With no provider the
 * card simply shows no button rather than throwing on mount or on click.
 */
const ControllerNoticeActionsContext = createContext<ControllerNoticeActionsContextValue | null>(
  null,
);

export function ControllerNoticeActionsProvider({
  value,
  children,
}: {
  value: ControllerNoticeActionsContextValue | null;
  children: ReactNode;
}) {
  return (
    <ControllerNoticeActionsContext.Provider value={value}>
      {children}
    </ControllerNoticeActionsContext.Provider>
  );
}

export function useControllerNoticeActions(): ControllerNoticeActionsContextValue | null {
  return useContext(ControllerNoticeActionsContext);
}

/** Resolves the handler for a resolved action, or null when it cannot run. */
export function resolveControllerNoticeActionHandler(
  action: ControllerConversationNoticeAction | null,
  actions: ControllerNoticeActionsContextValue | null,
): (() => void) | null {
  if (!action || !actions) {
    return null;
  }
  if (action.kind === "run_automation") {
    const { automationId } = action;
    const run = actions.onRunAutomation;
    return automationId && typeof run === "function" ? () => run(automationId) : null;
  }
  const handler =
    action.kind === "desktop_runtime_help"
      ? actions.onShowSelfHostHelp
      : action.kind === "open_credits"
        ? actions.onOpenCredits
        : actions.onOpenMachines;
  // A half-populated context (a test mock, a provider mid-refactor) must not
  // ship a button that looks live and does nothing.
  return typeof handler === "function" ? handler : null;
}
