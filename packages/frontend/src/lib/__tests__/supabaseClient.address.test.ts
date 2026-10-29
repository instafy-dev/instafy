// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthChangeEvent, SupabaseClient } from "@supabase/supabase-js";
import { supabaseAuthStorageKey } from "../../auth/sessionUrlParameters";

// Drives the real supabase-js and auth-js the app ships, so an upgrade that
// changes how the client reads its address fails here rather than in a
// signed-in Desktop window.

const SUPABASE_URL = "http://127.0.0.1:54321";
const STORAGE_KEY = "sb-127-auth-token";
const VERIFIER_KEY = `${STORAGE_KEY}-code-verifier`;

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
// Still stored, but its access token has expired and the server no longer
// takes its refresh token (signed out elsewhere), so auth-js removes it while
// it starts up.
const deadSession = {
  ...signedInSession,
  access_token: fakeJwt({ sub: "signed-in-user", exp: nowSeconds - 60 }),
  expires_at: nowSeconds - 60,
};
const otherAccessToken = fakeJwt({ sub: "someone-else", email: "someone-else@example.com", exp: nowSeconds + 3600 });
// A sign-in result in a link's fragment, the way emailed links carry it.
const otherAccountTokens = `access_token=${otherAccessToken}&refresh_token=other-refresh&expires_in=3600&token_type=bearer`;

type AuthRequest = { method: string; url: URL; headers: Headers; body: unknown };
type Responder = (request: AuthRequest) => Response;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sessionResponse(userId: string): Response {
  return jsonResponse(200, {
    access_token: fakeJwt({ sub: userId, exp: nowSeconds + 3600 }),
    refresh_token: `${userId}-refresh`,
    token_type: "bearer",
    expires_in: 3600,
    user: { id: userId, aud: "authenticated" },
  });
}

function claimsOf(token: string): { sub?: string; email?: string } {
  try {
    const payload = token.split(".")[1] ?? "";
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { sub?: string; email?: string };
  } catch {
    return {};
  }
}

// The auth server a hostile link hopes for: any token is good for the account
// its claims name, and any code signs someone else in. A client that acted on
// its address would really lose or switch its session here.
const permissiveServer: Responder = ({ method, url, headers }) => {
  if (method === "GET" && url.pathname === "/auth/v1/user") {
    const { sub, email } = claimsOf((headers.get("authorization") ?? "").replace(/^Bearer /i, ""));
    return sub
      ? jsonResponse(200, { id: sub, aud: "authenticated", email })
      : jsonResponse(403, { code: "bad_jwt", msg: "invalid JWT" });
  }
  if (method === "POST" && url.pathname === "/auth/v1/token") {
    return sessionResponse("someone-else");
  }
  return jsonResponse(404, { code: "not_found", msg: "Not found" });
};

function refusingRefreshTokens(respond: Responder): Responder {
  return (request) =>
    request.method === "POST" && request.url.searchParams.get("grant_type") === "refresh_token"
      ? jsonResponse(400, { code: "refresh_token_not_found", msg: "Invalid Refresh Token: Refresh Token Not Found" })
      : respond(request);
}

type AuthEvent = { event: AuthChangeEvent; userId: string | null };

let client: SupabaseClient | null = null;

async function loadClient({
  address,
  desktop = false,
  signedIn = true,
  storedSession = signedInSession,
  codeVerifier = true,
  respond = permissiveServer,
  supabaseUrl = SUPABASE_URL,
}: {
  address: string;
  desktop?: boolean;
  signedIn?: boolean;
  storedSession?: typeof signedInSession;
  codeVerifier?: boolean;
  respond?: Responder;
  supabaseUrl?: string;
}) {
  vi.resetModules();
  vi.stubEnv("VITE_SUPABASE_URL", supabaseUrl);
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-key");
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init.method ?? "GET").toUpperCase();
    requests.push(`${method} ${url.pathname}${url.search}`);
    const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : null;
    return respond({ method, url, headers: new Headers(init.headers), body });
  });
  const events: AuthEvent[] = [];
  const setSessionTokens: string[] = [];
  // The real client, listened to from the moment it exists: it acts on its
  // address while it initializes, before the module that creates it returns.
  // The page may also set a session on it right away (adoptOwnAccountLink).
  vi.doMock("@supabase/supabase-js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@supabase/supabase-js")>();
    const createClient = (...args: Parameters<typeof actual.createClient>) => {
      const created = actual.createClient(...args);
      created.auth.onAuthStateChange((event, session) => {
        events.push({ event, userId: session?.user?.id ?? null });
      });
      const setSession = created.auth.setSession.bind(created.auth);
      created.auth.setSession = (tokens) => {
        setSessionTokens.push(tokens.access_token);
        return setSession(tokens);
      };
      return created;
    };
    return { ...actual, createClient };
  });
  window.history.replaceState(null, "", address);
  if (signedIn) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(storedSession));
  }
  if (codeVerifier) {
    window.localStorage.setItem(VERIFIER_KEY, JSON.stringify("verifier-from-an-earlier-sign-in"));
  }
  if (desktop) {
    (window as { instafyDesktop?: unknown }).instafyDesktop = {};
  }
  const module = await import("../supabaseClient");
  client = module.supabase;
  await client.auth.initialize();
  // Waits behind whatever the client still has queued, such as an explicit
  // code exchange, the way the app's first getSession does.
  const { data } = await client.auth.getSession();
  // Some events are dispatched on a timer.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stored = window.localStorage.getItem(STORAGE_KEY);
  const storedAtEnd = stored ? (JSON.parse(stored) as { access_token?: string; user?: { id?: string } }) : null;
  return {
    events,
    requests,
    setSessionTokens,
    storedUserId: storedAtEnd?.user?.id ?? null,
    storedAccessToken: storedAtEnd?.access_token ?? null,
    sessionUserId: data.session?.user?.id ?? null,
    hasVerifier: window.localStorage.getItem(VERIFIER_KEY) !== null,
    address: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    readsAddress: (client.auth as unknown as { detectSessionInUrl: boolean }).detectSessionInUrl,
    storageKey: (client.auth as unknown as { storageKey: string }).storageKey,
  };
}

type LoadedClient = Awaited<ReturnType<typeof loadClient>>;

// The session the page started with is still stored and still the one the app
// gets, and every event the client emitted was about it: nothing signed it
// out, and nothing signed anyone else in.
function expectSessionKept(result: LoadedClient) {
  expect(result.storedUserId).toBe("signed-in-user");
  expect(result.storedAccessToken).toBe(signedInSession.access_token);
  expect(result.sessionUserId).toBe("signed-in-user");
  expect(result.events).toContainEqual({ event: "INITIAL_SESSION", userId: "signed-in-user" });
  expect(result.events.filter(({ userId }) => userId !== "signed-in-user")).toEqual([]);
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
  vi.doUnmock("@supabase/supabase-js");
  vi.doUnmock("@capacitor/core");
  vi.doUnmock("../desktopShell");
  vi.doUnmock("../frameContext");
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Addresses a link can open the app at, none of which may end or replace the
// session where no sign-in returns through the address.
const hostileAddresses = [
  ["an error in the fragment", "/studio#error_description=signed+out+by+a+link", "/studio"],
  ["an error in the query", "/studio?projectId=p1&error_description=x", "/studio?projectId=p1"],
  ["another account's tokens", `/login#${otherAccountTokens}`, "/login"],
  ["an error inside a hash-router fragment", "/studio#/route?a=1&error_description=x", "/studio"],
  ["a code next to a stored verifier", "/login?code=code-from-a-link&redirect=%2Fstudio", "/login?redirect=%2Fstudio"],
] as const;

describe("the Supabase client in the desktop shell", () => {
  for (const [label, address, cleaned] of hostileAddresses) {
    it(`keeps the session when the app opens at an address with ${label}`, async () => {
      const result = await loadClient({ desktop: true, address });

      expectSessionKept(result);
      expect(result.requests).toEqual([]);
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

describe("the Supabase client in the mobile apps", () => {
  for (const [label, address, cleaned] of hostileAddresses) {
    it(`keeps the session when the app opens at an address with ${label}`, async () => {
      vi.doMock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true } }));

      const result = await loadClient({ address });

      expectSessionKept(result);
      expect(result.requests).toEqual([]);
      expect(result.address).toBe(cleaned);
      expect(result.readsAddress).toBe(false);
    });
  }
});

describe("the Supabase client in a frame inside an Instafy page", () => {
  // A site preview that navigated itself to the app shares the page's storage
  // and session, and no sign-in completes inside a frame.
  const inSameOriginFrame = () =>
    vi.doMock("../frameContext", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../frameContext")>()),
      hasSameOriginAncestor: () => true,
    }));

  for (const [label, address, cleaned] of hostileAddresses) {
    it(`keeps the session when the frame opens at an address with ${label}`, async () => {
      inSameOriginFrame();

      const result = await loadClient({ address });

      expectSessionKept(result);
      expect(result.requests).toEqual([]);
      expect(result.address).toBe(cleaned);
      expect(result.readsAddress).toBe(false);
    });
  }

  it("does not sign in from a link even when signed out", async () => {
    inSameOriginFrame();

    const result = await loadClient({ signedIn: false, address: `/login#${otherAccountTokens}` });
    const { readOtherAccountLink } = await import("../../auth/otherAccountLink");

    expect(result.requests).toEqual([]);
    expect(result.storedUserId).toBeNull();
    expect(result.sessionUserId).toBeNull();
    expect(result.address).toBe("/login");
    expect(result.readsAddress).toBe(false);
    expect(readOtherAccountLink()).toBeNull();
  });
});

describe("the Supabase client on the web", () => {
  it("still reads its address while signed out, which OAuth returns and email links rely on", async () => {
    const result = await loadClient({ desktop: false, signedIn: false, address: "/login?redirect=%2Fstudio#section" });

    expect(result.readsAddress).toBe(true);
    expect(result.address).toBe("/login?redirect=%2Fstudio#section");
  });

  // Signed in, everything an address could carry is handled before the client
  // starts, so it never reads one: not even an address that changes while it
  // starts up.
  it("does not read its address while signed in", async () => {
    const result = await loadClient({ desktop: false, address: "/login?redirect=%2Fstudio#section" });

    expect(result.readsAddress).toBe(false);
    expect(result.address).toBe("/login?redirect=%2Fstudio#section");
    expect(result.storedUserId).toBe("signed-in-user");
  });

  for (const supabaseUrl of [SUPABASE_URL, "https://abcdefghijklmnopqrst.supabase.co", "https://auth.example.test/supabase"]) {
    it(`looks for the signed-in account where supabase-js stores it for ${supabaseUrl}`, async () => {
      const result = await loadClient({ supabaseUrl, signedIn: false, codeVerifier: false, address: "/studio" });

      expect(result.storageKey).toBe(supabaseAuthStorageKey(supabaseUrl));
    });
  }
});

describe("the Supabase client on the web, signed in", () => {
  const addresses = [
    ["an error in the fragment", "/studio#error_description=signed+out+by+a+link", "/studio"],
    ["an error in the query next to another parameter", "/studio?projectId=p1&error_description=x", "/studio?projectId=p1"],
    ["an error inside a hash-router fragment", "/studio#/route?a=1&error_description=x", "/studio"],
    ["a code next to a provider's error", "/login?code=code-from-a-link&error=access_denied&redirect=%2Fstudio", "/login?redirect=%2Fstudio"],
    ["another account's tokens", `/login#${otherAccountTokens}`, "/login"],
    ["another account's password reset link", `/login?mode=recovery#${otherAccountTokens}&type=recovery`, "/login"],
    // Whose it was cannot be told, so the reset form must not open for the
    // account signed in here.
    [
      "an expired password reset link",
      "/login?mode=recovery#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
      "/login",
    ],
  ] as const;

  for (const [label, address, cleaned] of addresses) {
    it(`keeps the session when the page opens at an address with ${label}`, async () => {
      const result = await loadClient({ address });

      expectSessionKept(result);
      expect(result.requests).toEqual([]);
      expect(result.hasVerifier).toBe(true);
      expect(result.address).toBe(cleaned);
      expect(result.readsAddress).toBe(false);
    });
  }

  it("holds another account's link for the person to choose", async () => {
    await loadClient({ address: `/login#${otherAccountTokens}` });
    const { readOtherAccountLink } = await import("../../auth/otherAccountLink");

    expect(readOtherAccountLink()).toEqual({
      accessToken: otherAccessToken,
      refreshToken: "other-refresh",
      email: "someone-else@example.com",
      recovery: false,
    });
  });

  // The link belongs to the moment it was opened, not to whoever signs in next.
  it("drops the held link once the session ends after start-up", async () => {
    await loadClient({ address: `/login#${otherAccountTokens}` });
    const { readOtherAccountLink } = await import("../../auth/otherAccountLink");
    expect(readOtherAccountLink()).not.toBeNull();

    await client!.auth.signOut({ scope: "local" });

    expect(readOtherAccountLink()).toBeNull();
  });

  // A dead session that start-up removes leaves the link as the way back in.
  it("keeps the held link when start-up removes a dead stored session", async () => {
    const result = await loadClient({
      address: `/login#${otherAccountTokens}`,
      storedSession: deadSession,
      respond: refusingRefreshTokens(permissiveServer),
    });
    const { readOtherAccountLink } = await import("../../auth/otherAccountLink");

    expect(result.storedUserId).toBeNull();
    expect(readOtherAccountLink()).toMatchObject({ refreshToken: "other-refresh" });
  });

  it("holds another account's password reset link as one, without the reset form", async () => {
    const result = await loadClient({ address: `/login?mode=recovery#${otherAccountTokens}&type=recovery` });
    const { readOtherAccountLink } = await import("../../auth/otherAccountLink");

    expect(result.address).toBe("/login");
    expect(readOtherAccountLink()).toEqual({
      accessToken: otherAccessToken,
      refreshToken: "other-refresh",
      email: "someone-else@example.com",
      recovery: true,
    });
  });

  it("moves another account's link that lands on the home page to the login page, and holds it", async () => {
    const result = await loadClient({ address: `/#${otherAccountTokens}` });
    const { readOtherAccountLink } = await import("../../auth/otherAccountLink");

    expectSessionKept(result);
    expect(result.requests).toEqual([]);
    expect(result.address).toBe("/login");
    expect(readOtherAccountLink()).toEqual({
      accessToken: otherAccessToken,
      refreshToken: "other-refresh",
      email: "someone-else@example.com",
      recovery: false,
    });
  });

  it("keeps the session and the reset form for a forged token that names the signed-in account", async () => {
    const forged = fakeJwt({ sub: "signed-in-user", exp: nowSeconds + 3600 });
    const checkedWith: (string | null)[] = [];

    const result = await loadClient({
      address: `/login?mode=recovery#access_token=${forged}&refresh_token=forged-refresh&expires_in=3600&token_type=bearer&type=recovery`,
      // The server refuses a forged token, and auth-js reading one from the
      // address would answer that by removing the session.
      respond: ({ headers }) => {
        checkedWith.push(headers.get("authorization"));
        return jsonResponse(401, { code: "bad_jwt", msg: "invalid JWT" });
      },
    });
    const { readOtherAccountLink } = await import("../../auth/otherAccountLink");

    expectSessionKept(result);
    expect(result.requests).toEqual(["GET /auth/v1/user"]);
    expect(checkedWith).toEqual([`Bearer ${forged}`]);
    expect(result.setSessionTokens).toEqual([]);
    expect(result.address).toBe("/login?mode=recovery");
    expect(readOtherAccountLink()).toBeNull();
  });

  it("puts the person's own reset link in place of a session that died, and keeps the reset form", async () => {
    const ownRecoveryToken = fakeJwt({ sub: "signed-in-user", exp: nowSeconds + 3600 });

    const result = await loadClient({
      storedSession: deadSession,
      address: `/login?mode=recovery#access_token=${ownRecoveryToken}&refresh_token=recovery-refresh&expires_in=3600&token_type=bearer&type=recovery`,
      respond: refusingRefreshTokens(permissiveServer),
    });
    const { readOtherAccountLink } = await import("../../auth/otherAccountLink");

    // The page's check of the link, auth-js failing to refresh the dead
    // session while it starts up, and setSession's own check of the link.
    expect(result.requests).toEqual([
      "GET /auth/v1/user",
      "POST /auth/v1/token?grant_type=refresh_token",
      "GET /auth/v1/user",
    ]);
    expect(result.events).toContainEqual({ event: "SIGNED_OUT", userId: null });
    expect(result.setSessionTokens).toEqual([ownRecoveryToken]);
    expect(result.storedUserId).toBe("signed-in-user");
    expect(result.storedAccessToken).toBe(ownRecoveryToken);
    expect(result.events).toContainEqual({ event: "SIGNED_IN", userId: "signed-in-user" });
    expect(result.address).toBe("/login?mode=recovery");
    expect(readOtherAccountLink()).toBeNull();
  });

  it("exchanges an OAuth return's code explicitly, and a failed exchange keeps the session and the verifier", async () => {
    const bodies: unknown[] = [];

    const result = await loadClient({
      address: "/login?code=junk",
      respond: ({ body }) => {
        bodies.push(body);
        return jsonResponse(400, {
          code: "bad_code_verifier",
          msg: "code challenge does not match previously saved code verifier",
        });
      },
    });

    expect(result.requests).toEqual(["POST /auth/v1/token?grant_type=pkce"]);
    expect(bodies).toEqual([{ auth_code: "junk", code_verifier: "verifier-from-an-earlier-sign-in" }]);
    expectSessionKept(result);
    expect(result.hasVerifier).toBe(true);
    expect(result.address).toBe("/login");
  });

  it("signs in as the account an explicit exchange returns", async () => {
    const result = await loadClient({ address: "/login?code=junk", respond: () => sessionResponse("someone-else") });

    expect(result.requests).toEqual(["POST /auth/v1/token?grant_type=pkce"]);
    expect(result.storedUserId).toBe("someone-else");
    expect(result.sessionUserId).toBe("someone-else");
    expect(result.events).toContainEqual({ event: "SIGNED_IN", userId: "someone-else" });
  });

  it("still exchanges an OAuth return's code when start-up removes a dead session, with the verifier put back", async () => {
    const bodies: unknown[] = [];

    const result = await loadClient({
      storedSession: deadSession,
      address: "/login?code=c1&redirect=%2Fstudio",
      respond: refusingRefreshTokens(({ body }) => {
        bodies.push(body);
        return sessionResponse("oauth-user");
      }),
    });

    // auth-js removes the stored verifier along with the dead session, before
    // the exchange that needs it.
    expect(result.requests).toEqual([
      "POST /auth/v1/token?grant_type=refresh_token",
      "POST /auth/v1/token?grant_type=pkce",
    ]);
    expect(result.events).toContainEqual({ event: "SIGNED_OUT", userId: null });
    expect(bodies).toEqual([{ auth_code: "c1", code_verifier: "verifier-from-an-earlier-sign-in" }]);
    expect(result.storedUserId).toBe("oauth-user");
    expect(result.sessionUserId).toBe("oauth-user");
    expect(result.events).toContainEqual({ event: "SIGNED_IN", userId: "oauth-user" });
    expect(result.address).toBe("/login?redirect=%2Fstudio");
  });
});

describe("the Supabase client on the web, signed out", () => {
  it("completes an OAuth return from its address", async () => {
    const bodies: unknown[] = [];

    const result = await loadClient({
      signedIn: false,
      address: "/login?code=c1&redirect=%2Fstudio",
      respond: ({ body }) => {
        bodies.push(body);
        return sessionResponse("oauth-user");
      },
    });

    expect(result.requests).toEqual(["POST /auth/v1/token?grant_type=pkce"]);
    expect(bodies).toEqual([{ auth_code: "c1", code_verifier: "verifier-from-an-earlier-sign-in" }]);
    expect(result.storedUserId).toBe("oauth-user");
    expect(result.sessionUserId).toBe("oauth-user");
    expect(result.address).toBe("/login?redirect=%2Fstudio");
  });

  it("consumes a password reset link from its address", async () => {
    const recoveryToken = fakeJwt({ sub: "recovering-user", exp: nowSeconds + 3600 });

    const result = await loadClient({
      signedIn: false,
      codeVerifier: false,
      address: `/login?mode=recovery#access_token=${recoveryToken}&refresh_token=recovery-refresh&expires_in=3600&token_type=bearer&type=recovery`,
    });
    const { readOtherAccountLink } = await import("../../auth/otherAccountLink");

    expect(result.requests).toEqual(["GET /auth/v1/user"]);
    expect(result.storedUserId).toBe("recovering-user");
    expect(result.sessionUserId).toBe("recovering-user");
    expect(result.events).toContainEqual({ event: "PASSWORD_RECOVERY", userId: "recovering-user" });
    expect(result.address).toBe("/login?mode=recovery");
    expect(readOtherAccountLink()).toBeNull();
  });

  // auth-js answers an error in the address by deleting the PKCE verifier,
  // which may belong to a sign-in another tab has in progress.
  const refusals = [
    ["in the query", "/login?error=access_denied&error_description=x", "/login"],
    [
      "in the query and the fragment",
      "/login?redirect=%2Fstudio&error=access_denied&error_code=access_denied&error_description=x#error=access_denied&error_code=access_denied&error_description=x",
      "/login?redirect=%2Fstudio",
    ],
  ] as const;

  for (const [label, address, cleaned] of refusals) {
    it(`removes a provider's refusal ${label} and keeps the verifier`, async () => {
      const result = await loadClient({ signedIn: false, address });

      expect(result.address).toBe(cleaned);
      expect(result.hasVerifier).toBe(true);
      expect(result.requests).toEqual([]);
      expect(result.events.map(({ event }) => event)).not.toContain("SIGNED_OUT");
    });
  }
});

// Last in the file: auth-js checks once whether storage can be written and
// keeps the answer for as long as it is loaded, which is the whole file.
describe("the Supabase client on the web, where storage cannot be written", () => {
  it("holds a token link instead of consuming it", async () => {
    // Where nothing can be written, no session was ever stored either.
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    });

    const result = await loadClient({ signedIn: false, codeVerifier: false, address: `/login#${otherAccountTokens}` });
    const { readOtherAccountLink } = await import("../../auth/otherAccountLink");

    expect(result.requests).toEqual([]);
    expect(result.setSessionTokens).toEqual([]);
    expect(result.sessionUserId).toBeNull();
    expect(result.events.filter(({ userId }) => userId !== null)).toEqual([]);
    expect(result.address).toBe("/login");
    expect(readOtherAccountLink()).toEqual({
      accessToken: otherAccessToken,
      refreshToken: "other-refresh",
      email: "someone-else@example.com",
      recovery: false,
    });
  });
});
