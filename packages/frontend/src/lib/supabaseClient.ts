import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolveSupabaseFlowType } from "../auth/pkce";
import { withoutSessionUrlParameters } from "../auth/sessionUrlParameters";
import { isInsideDesktopShell } from "./desktopShell";

export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
export const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const hasSupabaseConfig = Boolean(supabaseUrl && supabaseAnonKey);

if (!hasSupabaseConfig) {
  // eslint-disable-next-line no-console
  console.warn(
    "Supabase environment variables are missing. Local operations will use a no-op client. Add them to your .env file for real calls."
  );
}

const noopFrom = {
  upsert: async () => ({ data: null, error: null }),
  insert: async () => ({ data: null, error: null }),
  select: () => noopFrom,
  eq: () => noopFrom,
  order: () => noopFrom,
  limit: () => noopFrom,
  maybeSingle: async () => ({ data: null, error: null })
};

const noopClient = {
  from: () => noopFrom,
  functions: {
    invoke: async () => ({ data: null, error: { message: "Supabase env not configured" } })
  }
};

// The desktop shell never receives a sign-in through the page's address:
// OAuth returns through instafy://auth (useNativeGithubAuth) and email links
// open in the system browser. Yet a link can open the app at an address that
// carries #access_token=... or #error_description=..., and a client reading it
// would replace or end the session. So on desktop the client never reads the
// address, and the session parameters are removed from it first, before
// anything else sees them. That includes a same-origin frame inside the
// shell, which shares its session. The web keeps reading it: OAuth returns
// and email links land there.
const desktopShell = typeof window !== "undefined" && isInsideDesktopShell();
if (desktopShell) {
  const cleaned = withoutSessionUrlParameters(window.location.href);
  if (cleaned) {
    try {
      window.history.replaceState(window.history.state, "", cleaned);
    } catch {
      // The client below ignores the address either way.
    }
  }
}

// PKCE by default; implicit ONLY for a load whose URL already carries a
// legacy hash-token callback. auth-js wipes the stored session when a
// PKCE-configured client meets an implicit-shaped URL, so mid-rollout URLs
// (in-flight sign-ins, recovery emails in inboxes) must be consumed by an
// implicit-mode client for that one load. See src/auth/pkce.ts. The desktop
// shell is always PKCE, since its address never carries a sign-in.
const flowType = desktopShell
  ? "pkce"
  : resolveSupabaseFlowType(typeof window === "undefined" ? null : window.location.hash);

export const supabase: SupabaseClient = hasSupabaseConfig
  ? createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: {
        persistSession: true,
        flowType,
        // Always a boolean: auth-js keeps an explicit undefined, which would
        // also turn detection off on the web.
        detectSessionInUrl: !desktopShell
      }
    })
  : (noopClient as unknown as SupabaseClient);

if (typeof window !== "undefined" && hasSupabaseConfig) {
  (window as typeof window & { __INSTAFY_SUPABASE__?: SupabaseClient }).__INSTAFY_SUPABASE__ =
    supabase;
}
