import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolveSupabaseFlowType } from "../auth/pkce";

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

// PKCE by default; implicit ONLY for a load whose URL already carries a
// legacy hash-token callback. auth-js wipes the stored session when a
// PKCE-configured client meets an implicit-shaped URL, so mid-rollout URLs
// (in-flight sign-ins, recovery emails in inboxes) must be consumed by an
// implicit-mode client for that one load. See src/auth/pkce.ts.
const flowType = resolveSupabaseFlowType(
  typeof window === "undefined" ? null : window.location.hash,
);

export const supabase: SupabaseClient = hasSupabaseConfig
  ? createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: {
        persistSession: true,
        flowType
      }
    })
  : (noopClient as unknown as SupabaseClient);

if (typeof window !== "undefined" && hasSupabaseConfig) {
  (window as typeof window & { __INSTAFY_SUPABASE__?: SupabaseClient }).__INSTAFY_SUPABASE__ =
    supabase;
}
