// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// Drives the real supabase-js and auth-js the app ships, so an upgrade that
// changes how the client reads its address fails here rather than in a
// signed-in Desktop window.

const SUPABASE_URL = "http://127.0.0.1:54321";
const STORAGE_KEY = "sb-127-auth-token";

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.c2ln`;
}

const nowSeconds = Math.floor(Date.now() / 1000);
const signedInSession = {
  access_token: fakeJwt({ sub: "signed-in-user", exp: nowSeconds + 3600 }),
  refresh_token: "signed-in-refresh",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: nowSeconds + 3600,
  user: { id: "signed-in-user", aud: "authenticated" },
};
const otherAccessToken = fakeJwt({ sub: "someone-else", exp: nowSeconds + 3600 });

const fetchMock = vi.fn(
  async () =>
    new Response(JSON.stringify({ id: "someone-else", aud: "authenticated" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
);

let client: SupabaseClient | null = null;

async function loadClient({ desktop, address }: { desktop: boolean; address: string }) {
  vi.resetModules();
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE_URL);
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-key");
  vi.stubGlobal("fetch", fetchMock);
  window.history.replaceState(null, "", address);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(signedInSession));
  window.localStorage.setItem(`${STORAGE_KEY}-code-verifier`, JSON.stringify("verifier-from-an-earlier-sign-in"));
  if (desktop) {
    (window as { instafyDesktop?: unknown }).instafyDesktop = {};
  }
  const events: string[] = [];
  const module = await import("../supabaseClient");
  client = module.supabase;
  client.auth.onAuthStateChange((event) => {
    events.push(event);
  });
  await client.auth.initialize();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return {
    events,
    storedUserId: stored ? (JSON.parse(stored) as { user?: { id?: string } }).user?.id ?? null : null,
    address: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    readsAddress: (client.auth as unknown as { detectSessionInUrl: boolean }).detectSessionInUrl,
  };
}

afterEach(async () => {
  if (client) {
    await client.auth.stopAutoRefresh();
    (client.auth as unknown as { broadcastChannel?: { close(): void } | null }).broadcastChannel?.close();
  }
  client = null;
  delete (window as { instafyDesktop?: unknown }).instafyDesktop;
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  fetchMock.mockClear();
  vi.doUnmock("../desktopShell");
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the Supabase client in the desktop shell", () => {
  const hostileAddresses = [
    ["an error in the fragment", "/studio#error_description=signed+out+by+a+link", "/studio"],
    ["an error in the query", "/studio?projectId=p1&error_description=x", "/studio?projectId=p1"],
    [
      "another account's tokens",
      `/login#access_token=${otherAccessToken}&refresh_token=r&expires_in=3600&token_type=bearer`,
      "/login",
    ],
    ["an error inside a hash-router fragment", "/studio#/route?a=1&error_description=x", "/studio"],
    ["a code next to a stored verifier", "/login?code=code-from-a-link&redirect=%2Fstudio", "/login?redirect=%2Fstudio"],
  ] as const;

  for (const [label, address, cleaned] of hostileAddresses) {
    it(`keeps the session when the app opens at an address with ${label}`, async () => {
      const result = await loadClient({ desktop: true, address });

      expect(result.storedUserId).toBe("signed-in-user");
      expect(result.events).not.toContain("SIGNED_OUT");
      expect(result.events).not.toContain("SIGNED_IN");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.address).toBe(cleaned);
      expect(result.readsAddress).toBe(false);
    });
  }

  it("leaves an ordinary address alone", async () => {
    const result = await loadClient({ desktop: true, address: "/studio?projectId=p1#section" });

    expect(result.address).toBe("/studio?projectId=p1#section");
    expect(result.storedUserId).toBe("signed-in-user");
  });

  // Only the main frame gets the preload bridge, but a same-origin frame
  // inside the shell (an Instafy page a site preview navigated to) shares its
  // session. isInsideDesktopShell decides; its own test covers the frames.
  it("treats a same-origin frame inside the shell the same way", async () => {
    vi.doMock("../desktopShell", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../desktopShell")>()),
      isInsideDesktopShell: () => true,
    }));

    const result = await loadClient({ desktop: false, address: "/studio#error_description=x" });

    expect(result.storedUserId).toBe("signed-in-user");
    expect(result.readsAddress).toBe(false);
    expect(result.address).toBe("/studio");
  });
});

describe("the Supabase client on the web", () => {
  it("still reads its address, which OAuth returns and email links rely on", async () => {
    const result = await loadClient({ desktop: false, address: "/login?redirect=%2Fstudio#section" });

    expect(result.readsAddress).toBe(true);
    expect(result.address).toBe("/login?redirect=%2Fstudio#section");
    expect(result.storedUserId).toBe("signed-in-user");
  });
});
