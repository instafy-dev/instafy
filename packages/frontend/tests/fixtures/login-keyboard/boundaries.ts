/** Login state transitions are real; authentication/native service boundaries are inert. */
export const loginKeyboardBoundaries: Record<string, string> = {
  "/src/desktop/updates/client.ts": `export const desktopUpdaterBridgeAvailable = () => false; export const readDesktopUpdaterStatus = async () => null;`,
  "/src/providers/AuthProvider.tsx": `
    const subscribe = (listener) => { window.__loginKeyboardReview.listeners.add(listener); return () => window.__loginKeyboardReview.listeners.delete(listener); };
    const snapshot = () => window.__loginKeyboardReview.auth;
    export function useAuth() { return window.__loginKeyboardReview.hooks.useSyncExternalStore(subscribe, snapshot, snapshot); }
  `,
  "/src/lib/supabaseClient.ts": `export const hasSupabaseConfig = true;`,
  "/src/screens/login/useNativeGithubAuth.ts": `
    const noop = () => {};
    export const OAUTH_PROVIDER_LABELS = { github: "GitHub", google: "Google" };
    export function useNativeGithubAuth() { return { handleGithubLogin: noop, handleGoogleLogin: noop, resetNativeAuthState: noop }; }
  `,
};
