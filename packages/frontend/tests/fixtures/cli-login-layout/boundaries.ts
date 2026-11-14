/** The session and the Supabase settings the page reads are inert: no account, network or CLI is used. */
export const cliLoginLayoutBoundaries: Record<string, string> = {
  "/src/providers/AuthProvider.tsx": `export function useAuth() { return window.__cliLoginLayout.auth; }`,
  "/src/lib/supabaseClient.ts": `
    export const supabaseUrl = "https://supabase.example.test";
    export const supabaseAnonKey = "inert-review-anon-key";
  `,
};
