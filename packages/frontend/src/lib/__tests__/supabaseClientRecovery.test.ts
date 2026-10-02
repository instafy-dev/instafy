// @vitest-environment jsdom

import { createBrowserRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createClient = vi.hoisted(() => vi.fn());
vi.mock("@supabase/supabase-js", () => ({ createClient }));

describe("Supabase recovery callback bootstrap", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("VITE_SUPABASE_URL", "https://project.example.test");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "test-anon-key");
    createClient.mockReset();
    createClient.mockReturnValue({ auth: {} });
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    window.history.replaceState(null, "", "/");
    delete (window as typeof window & { __INSTAFY_SUPABASE__?: unknown }).__INSTAFY_SUPABASE__;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("routes a root recovery callback before the SDK consumes its hash and the router starts", async () => {
    const hash = "#access_token=test-access&refresh_token=test-refresh&type=recovery";
    const historyState = { idx: 0, key: "initial" };
    window.history.replaceState(historyState, "", `/${hash}`);
    createClient.mockImplementation(() => {
      expect(window.location.pathname).toBe("/login");
      expect(window.location.search).toBe("?mode=recovery");
      expect(window.location.hash).toBe(hash);
      expect(window.history.state).toEqual(historyState);
      // Auth initialization may consume the hash and emit PASSWORD_RECOVERY
      // before AuthProvider subscribes. The route must survive that ordering.
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
      return { auth: {} };
    });

    await import("../supabaseClient");
    expect(createClient).toHaveBeenCalledExactlyOnceWith(
      "https://project.example.test",
      "test-anon-key",
      { auth: { persistSession: true, flowType: "implicit" } },
    );
    const router = createBrowserRouter([{ path: "*", element: null }]);
    try {
      expect(router.state.location.pathname).toBe("/login");
      expect(router.state.location.search).toBe("?mode=recovery");
      expect(router.state.location.hash).toBe("");
    } finally {
      router.dispose();
    }
  });

  it.each([
    { path: "/?mode=recovery", flowType: "pkce" },
    { path: "/login?code=test-code", flowType: "pkce" },
    { path: "/login?mode=extension#access_token=test-access&refresh_token=test-refresh&type=signup", flowType: "implicit" },
    { path: "/login?mode=recovery#access_token=test-access&refresh_token=test-refresh&type=recovery", flowType: "implicit" },
  ])("preserves other routes and their auth flow: $path", async ({ path, flowType }) => {
    window.history.replaceState(null, "", path);
    const replaceState = vi.spyOn(window.history, "replaceState");

    await import("../supabaseClient");

    expect(replaceState).not.toHaveBeenCalled();
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(path);
    expect(createClient).toHaveBeenCalledWith(
      "https://project.example.test",
      "test-anon-key",
      { auth: { persistSession: true, flowType } },
    );
  });
});
