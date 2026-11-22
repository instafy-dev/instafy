import { hasSupabaseConfig, supabase } from "../../lib/supabaseClient";

let watching = false;
let lastUserId: string | null | undefined;

/**
 * Calls `onViewerChange` once the person signed in to Studio changes, so the
 * logins kept for one person (claudeCodeLoginsStore.ts) never name another's.
 * The store loads this module with the controller client, once a list is
 * first asked for.
 */
export function watchClaudeCodeLoginsViewer(onViewerChange: () => void): void {
  if (watching || !hasSupabaseConfig) {
    return;
  }
  watching = true;
  try {
    supabase.auth.onAuthStateChange((_event, session) => {
      const userId = session?.user?.id ?? null;
      if (lastUserId !== undefined && userId !== lastUserId) {
        onViewerChange();
      }
      lastUserId = userId;
    });
  } catch {
    // A client without auth keeps no per-person list to protect.
  }
}
