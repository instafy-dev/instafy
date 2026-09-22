/**
 * Window event that says the credit balance or plan changed server-side
 * (published by the controller as credits.updated and forwarded by the sync
 * hook). The provider refreshes the snapshot on it, and the ledger too while
 * the Credits panel is open, so its gated timers are only a fallback. The
 * controller event is a bare signal; listeners refetch /credits/status.
 */
export const CREDITS_UPDATED_EVENT = "instafy:credits-updated";

export interface CreditsUpdatedEventDetail {
  projectId?: string | null;
}
