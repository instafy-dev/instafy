import { createClient, type SupabaseClient } from "@supabase/supabase-js";

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

export const supabase: SupabaseClient = hasSupabaseConfig
  ? createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: {
        persistSession: true
      }
    })
  : (noopClient as unknown as SupabaseClient);

if (typeof window !== "undefined" && hasSupabaseConfig) {
  (window as typeof window & { __INSTAFY_SUPABASE__?: SupabaseClient }).__INSTAFY_SUPABASE__ =
    supabase;
}
