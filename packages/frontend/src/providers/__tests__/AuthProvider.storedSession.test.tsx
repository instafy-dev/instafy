// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost:5173/"}

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

// supabase-js keeps the session under sb-<ref>-auth-token and, when it starts,
// renews one whose access token has expired. In a page it can read storage
// after this provider has started, so the fake reads it only when the
// provider asks, and the provider must leave it there until then.
const STORAGE_KEY = "sb-127-auth-token";
const seen = vi.hoisted(() => ({ stored: undefined as string | null | undefined }));

vi.mock("../../lib/supabaseClient", () => ({
  hasSupabaseConfig: true,
  supabase: {
    auth: {
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      getSession: async () => {
        seen.stored = window.localStorage.getItem(STORAGE_KEY);
        return { data: { session: null }, error: null };
      },
    },
  },
}));
vi.mock("../../notifications/notificationLifecycle", () => ({ changeNotificationSession: async () => {} }));
vi.mock("../../notifications/notificationActions", () => ({ installNotificationActionListeners: () => () => {} }));

import { AuthProvider } from "../AuthProvider";

afterEach(() => {
  window.localStorage.clear();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe("AuthProvider's stored session", () => {
  it("is left for the client to renew when its access token has expired, on a development build too", async () => {
    expect(import.meta.env.DEV).toBe(true);
    const stored = JSON.stringify({ access_token: "a", refresh_token: "r", expires_at: Math.floor(Date.now() / 1000) - 3600 });
    window.localStorage.setItem(STORAGE_KEY, stored);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<AuthProvider>{null}</AuthProvider>));
    act(() => root.unmount());

    expect(seen.stored).toBe(stored);
  });
});
