import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  decideWebSessionAddress,
  readStoredSessionUser,
  supabaseAuthStorageKey,
  UNREADABLE_SESSION_STORAGE,
  unverifiedJwtClaims,
  withoutSessionUrlParameters,
  type StoredSessionUser,
} from "../sessionUrlParameters";

const BASE = "https://prod.instafy.dev";

function base64Url(text: string): string {
  const binary = String.fromCharCode(...new TextEncoder().encode(text));
  return btoa(binary).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** Shaped like a Supabase access token, with a signature nothing checks. */
function fakeJwt(payload: unknown): string {
  return `${base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${base64Url(JSON.stringify(payload))}.c2ln`;
}

describe("withoutSessionUrlParameters", () => {
  it("leaves an address without session parameters alone", () => {
    for (const path of [
      "/studio",
      "/studio?projectId=p1&panel=settings",
      "/studio?projectId=p1#section",
      "/login?type=recovery",
      "/login?mode=recovery&redirect=%2Fstudio",
      "/invite?token=invite-token",
      "/cli/login?cliState=s&cliCallbackUrl=http%3A%2F%2F127.0.0.1%3A4000%2Fcallback",
    ]) {
      expect(withoutSessionUrlParameters(`${BASE}${path}`)).toBeNull();
    }
  });

  it("removes session parameters from the query and keeps the others", () => {
    expect(withoutSessionUrlParameters(`${BASE}/login?error_description=x&redirect=%2Fstudio`)).toBe(
      `${BASE}/login?redirect=%2Fstudio`,
    );
    expect(withoutSessionUrlParameters(`${BASE}/studio?projectId=p1&code=attacker-code`)).toBe(
      `${BASE}/studio?projectId=p1`,
    );
    expect(withoutSessionUrlParameters(`${BASE}/login?access_token=a&refresh_token=b`)).toBe(`${BASE}/login`);
  });

  it("re-encodes the remaining query once it removes something", () => {
    expect(withoutSessionUrlParameters(`${BASE}/login?redirect=/studio&q=a%20b&code=x`)).toBe(
      `${BASE}/login?redirect=%2Fstudio&q=a+b`,
    );
  });

  it("matches keys more broadly than auth-js: decoded, trimmed and in any case", () => {
    for (const query of ["%61ccess_token=a", "ERROR_DESCRIPTION=x", "%20code%20=x", "Error=access_denied"]) {
      expect(withoutSessionUrlParameters(`${BASE}/login?${query}`)).toBe(`${BASE}/login`);
    }
  });

  it("drops a fragment that carries any session parameter", () => {
    expect(withoutSessionUrlParameters(`${BASE}/studio?projectId=p1#error_description=x`)).toBe(
      `${BASE}/studio?projectId=p1`,
    );
    expect(
      withoutSessionUrlParameters(`${BASE}/login#access_token=a&refresh_token=b&expires_in=3600&token_type=bearer`),
    ).toBe(`${BASE}/login`);
    // auth-js reads the whole fragment as parameters, so a hash-router shape
    // still counts.
    expect(withoutSessionUrlParameters(`${BASE}/studio#/route?a=1&error_description=x`)).toBe(`${BASE}/studio`);
  });

  it("returns null for something that is not an address", () => {
    expect(withoutSessionUrlParameters("not a url")).toBeNull();
  });
});

describe("supabaseAuthStorageKey", () => {
  it("names the key after the first label of the project's hostname", () => {
    expect(supabaseAuthStorageKey("http://127.0.0.1:54321")).toBe("sb-127-auth-token");
    expect(supabaseAuthStorageKey("https://abc.supabase.co")).toBe("sb-abc-auth-token");
    expect(supabaseAuthStorageKey("  HTTPS://ABC.Supabase.CO/  ")).toBe("sb-abc-auth-token");
    expect(supabaseAuthStorageKey("https://supabase.example.test/project/")).toBe("sb-supabase-auth-token");
  });

  // The page reads the stored session under this key before the client
  // starts. A key that drifted from supabase-js's would find nobody signed in
  // and let a link in the address replace the session.
  it("matches the key the installed supabase-js stores the session under", () => {
    for (const url of [
      "http://127.0.0.1:54321",
      "https://abc.supabase.co",
      "  HTTPS://ABC.Supabase.CO/  ",
      "https://supabase.example.test/project",
    ]) {
      const client = createClient(url, "anon-key", {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      expect(supabaseAuthStorageKey(url)).toBe((client as unknown as { storageKey: string }).storageKey);
    }
  });

  it("gives no key for anything but an http or https address", () => {
    for (const url of [null, undefined, "", "   ", "abc.supabase.co", "ftp://abc.supabase.co", "https://"]) {
      expect(supabaseAuthStorageKey(url)).toBeNull();
    }
  });
});

describe("unverifiedJwtClaims", () => {
  it("reads the subject and email without checking the signature", () => {
    expect(
      unverifiedJwtClaims(fakeJwt({ sub: "user-1", email: "me@example.test", role: "authenticated" })),
    ).toEqual({ sub: "user-1", email: "me@example.test" });
    // Payloads of every length, whatever padding they would have needed.
    for (const sub of ["a", "ab", "abc"]) {
      expect(unverifiedJwtClaims(fakeJwt({ sub }))?.sub).toBe(sub);
    }
  });

  it("decodes a UTF-8 email from the URL-safe alphabet", () => {
    for (const email of ["þóra@exämple.test", "ÿvonne@exämple.test"]) {
      const token = fakeJwt({ sub: "user-1", email });
      // Chosen to encode with a "-" or a "_", which atob rejects.
      expect(token.split(".")[1]).toMatch(/[-_]/);
      expect(unverifiedJwtClaims(token)).toEqual({ sub: "user-1", email });
    }
  });

  it("gives null for a token it cannot read", () => {
    const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = base64Url(JSON.stringify({ sub: "user-1" }));
    for (const token of [
      "",
      "not-a-jwt",
      `${header}.${payload}`,
      `${header}.${payload}.c2ln.extra`,
      `${header}.!!!.c2ln`,
      `${header}.${base64Url("not json")}.c2ln`,
    ]) {
      expect(unverifiedJwtClaims(token)).toBeNull();
    }
  });

  it("gives null for a payload that is not an object", () => {
    for (const payload of [42, "user-1", null, true]) {
      expect(unverifiedJwtClaims(fakeJwt(payload))).toBeNull();
    }
  });

  it("leaves out claims that are not strings", () => {
    expect(unverifiedJwtClaims(fakeJwt({ sub: 42, email: { address: "me@example.test" } }))).toEqual({
      sub: undefined,
      email: undefined,
    });
  });
});

describe("readStoredSessionUser", () => {
  const KEY = "sb-127-auth-token";
  const storageWith = (value: string | null): Pick<Storage, "getItem"> => ({
    getItem: (key) => (key === KEY ? value : null),
  });
  // Shaped like what auth-js stores.
  const storedSession = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      access_token: fakeJwt({ sub: "user-1", email: "me@example.test" }),
      refresh_token: "refresh-1",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: 1_900_000_000,
      user: { id: "user-1", email: "me@example.test", aud: "authenticated" },
      ...overrides,
    });

  it("reads who the stored session belongs to", () => {
    expect(readStoredSessionUser(storageWith(storedSession()), KEY)).toEqual({
      id: "user-1",
      email: "me@example.test",
    });
  });

  it("takes the id and email from the token when the stored user lacks them", () => {
    expect(readStoredSessionUser(storageWith(storedSession({ user: undefined })), KEY)).toEqual({
      id: "user-1",
      email: "me@example.test",
    });
    expect(readStoredSessionUser(storageWith(storedSession({ user: { aud: "authenticated" } })), KEY)).toEqual({
      id: "user-1",
      email: "me@example.test",
    });
    expect(
      readStoredSessionUser(
        storageWith(storedSession({ access_token: fakeJwt({ sub: "user-1" }), user: { id: "user-1" } })),
        KEY,
      ),
    ).toEqual({ id: "user-1", email: null });
  });

  // auth-js refreshes such a session rather than dropping it, so the person
  // is still signed in.
  it("counts a session whose access token has expired", () => {
    expect(readStoredSessionUser(storageWith(storedSession({ expires_at: 1 })), KEY)?.id).toBe("user-1");
  });

  it("finds nobody when no session auth-js would use is stored", () => {
    const throwing: Pick<Storage, "getItem"> = {
      getItem: () => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    };
    expect(readStoredSessionUser(storageWith(storedSession({ refresh_token: undefined })), KEY)).toBeNull();
    expect(readStoredSessionUser(storageWith(storedSession({ expires_at: undefined })), KEY)).toBeNull();
    expect(readStoredSessionUser(storageWith(storedSession({ access_token: undefined })), KEY)).toBeNull();
    expect(readStoredSessionUser(storageWith("{not json"), KEY)).toBeNull();
    expect(readStoredSessionUser(storageWith("null"), KEY)).toBeNull();
    expect(readStoredSessionUser(throwing, KEY)).toBeNull();
    expect(readStoredSessionUser(storageWith(null), KEY)).toBeNull();
    expect(readStoredSessionUser(storageWith(storedSession()), "sb-abc-auth-token")).toBeNull();
    expect(readStoredSessionUser(storageWith(storedSession()), null)).toBeNull();
    expect(readStoredSessionUser(null, KEY)).toBeNull();
    // Neither the stored user nor the token names anyone.
    expect(readStoredSessionUser(storageWith(storedSession({ access_token: "not-a-jwt", user: {} })), KEY)).toBeNull();
  });
});

const me: StoredSessionUser = { id: "6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b", email: "me@example.test" };
const myToken = fakeJwt({ sub: me.id, email: me.email });
const otherToken = fakeJwt({ sub: "0a9b8c7d-6e5f-4a3b-8c1d-0e9f8a7b6c5d", email: "other@example.test" });
const nothingToDo = { cleaned: null, deferredCode: null, otherAccountLink: null, ownAccountLink: null };

function decide(
  path: string,
  {
    signedInUser,
    hasCodeVerifier = false,
  }: { signedInUser: StoredSessionUser | typeof UNREADABLE_SESSION_STORAGE | null; hasCodeVerifier?: boolean },
) {
  return decideWebSessionAddress({ href: `${BASE}${path}`, signedInUser, hasCodeVerifier });
}

describe("decideWebSessionAddress when signed out", () => {
  const signedOut = { signedInUser: null };

  it("leaves an OAuth return and an emailed sign-in link for the client to read", () => {
    expect(decide("/login?code=oauth-code&redirect=%2Fstudio", { ...signedOut, hasCodeVerifier: true })).toEqual(
      nothingToDo,
    );
    expect(
      decide(
        `/login?mode=recovery#access_token=${otherToken}&refresh_token=r&expires_in=3600&token_type=bearer&type=recovery`,
        signedOut,
      ),
    ).toEqual(nothingToDo);
    expect(decide("/studio?projectId=p1#section", signedOut)).toEqual(nothingToDo);
  });

  // Nothing shows them, and auth-js answers one by deleting the PKCE verifier
  // that a sign-in in another tab may still need.
  it("removes error parameters from the query and keeps the others", () => {
    expect(
      decide(
        "/login?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid&redirect=%2Fstudio",
        signedOut,
      ),
    ).toEqual({ ...nothingToDo, cleaned: `${BASE}/login?redirect=%2Fstudio` });
    expect(decide("/login?ERROR_DESCRIPTION=x", signedOut)).toEqual({ ...nothingToDo, cleaned: `${BASE}/login` });
  });

  it("drops a fragment that carries an error", () => {
    expect(
      decide(
        "/login?redirect=%2Fstudio#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid",
        signedOut,
      ),
    ).toEqual({ ...nothingToDo, cleaned: `${BASE}/login?redirect=%2Fstudio` });
  });

  it("does nothing with something that is not an address", () => {
    for (const signedInUser of [null, me, UNREADABLE_SESSION_STORAGE] as const) {
      expect(decideWebSessionAddress({ href: "not a url", signedInUser, hasCodeVerifier: true })).toEqual(nothingToDo);
    }
  });
});

describe("decideWebSessionAddress when signed in", () => {
  const signedIn = { signedInUser: me };

  it("leaves an address without session parameters alone", () => {
    expect(decide("/studio?projectId=p1#section", signedIn)).toEqual(nothingToDo);
    expect(decide("/login?redirect=%2Fstudio", signedIn)).toEqual(nothingToDo);
    // Where switching to the account of a password reset link lands.
    expect(decide("/login?mode=recovery", signedIn)).toEqual(nothingToDo);
  });

  it("removes errors from the fragment and the query and keeps the other parameters", () => {
    expect(decide("/studio?projectId=p1#error=access_denied&error_description=x", signedIn)).toEqual({
      ...nothingToDo,
      cleaned: `${BASE}/studio?projectId=p1`,
    });
    expect(decide("/studio?projectId=p1&error_description=x&error_code=otp_expired", signedIn)).toEqual({
      ...nothingToDo,
      cleaned: `${BASE}/studio?projectId=p1`,
    });
  });

  // A link that failed cannot say whose it was. Left in place, the reset form
  // would change the password of the account that is signed in.
  it("takes the reset marker away from a reset link that expired", () => {
    expect(
      decide(
        "/login?mode=recovery#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid",
        signedIn,
      ),
    ).toEqual({ ...nothingToDo, cleaned: `${BASE}/login` });
    expect(decide("/login?type=recovery&redirect=%2Fstudio&error_code=otp_expired", signedIn)).toEqual({
      ...nothingToDo,
      cleaned: `${BASE}/login?redirect=%2Fstudio`,
    });
  });

  // A failed explicit exchange leaves the session alone, where auth-js
  // reading the code from the address would remove it.
  it("hands back a code this browser can redeem, to be exchanged explicitly", () => {
    expect(decide("/login?code=oauth-code&redirect=%2Fstudio", { ...signedIn, hasCodeVerifier: true })).toEqual({
      ...nothingToDo,
      cleaned: `${BASE}/login?redirect=%2Fstudio`,
      deferredCode: "oauth-code",
    });
  });

  it("strips a code without a stored verifier, or with an error, and exchanges nothing", () => {
    expect(decide("/login?code=oauth-code&redirect=%2Fstudio", signedIn)).toEqual({
      ...nothingToDo,
      cleaned: `${BASE}/login?redirect=%2Fstudio`,
    });
    expect(
      decide("/login?code=oauth-code&error=server_error&redirect=%2Fstudio", { ...signedIn, hasCodeVerifier: true }),
    ).toEqual({ ...nothingToDo, cleaned: `${BASE}/login?redirect=%2Fstudio` });
  });

  // The stored session may be dead (signed out elsewhere) or too old for a
  // password change, so the link's session is handed back to replace it once
  // the server confirms whose it is.
  it("hands back the person's own sign-in link and leaves the address where it is", () => {
    expect(
      decide(
        `/studio?projectId=p1#access_token=${myToken}&refresh_token=my-refresh&token_type=bearer&type=magiclink`,
        signedIn,
      ),
    ).toEqual({
      ...nothingToDo,
      cleaned: `${BASE}/studio?projectId=p1`,
      ownAccountLink: { userId: me.id, accessToken: myToken, refreshToken: "my-refresh" },
    });
  });

  it("keeps the reset form for the person's own recovery link and hands it back, however its id is cased", () => {
    for (const token of [myToken, fakeJwt({ sub: me.id.toUpperCase() })]) {
      expect(
        decide(
          `/login?mode=recovery#access_token=${token}&refresh_token=r&expires_in=3600&token_type=bearer&type=recovery`,
          signedIn,
        ),
      ).toEqual({
        ...nothingToDo,
        cleaned: `${BASE}/login?mode=recovery`,
        ownAccountLink: { userId: me.id, accessToken: token, refreshToken: "r" },
      });
    }
  });

  it("adds the reset marker when only the fragment said recovery", () => {
    expect(
      decide(`/login?redirect=%2Fstudio#access_token=${myToken}&refresh_token=r&type=recovery`, signedIn),
    ).toEqual({
      ...nothingToDo,
      cleaned: `${BASE}/login?redirect=%2Fstudio&mode=recovery`,
      ownAccountLink: { userId: me.id, accessToken: myToken, refreshToken: "r" },
    });
  });

  // A reset email returns to the site's root when the address it names is not
  // allowed.
  it("moves the person's own recovery link from the site's root to the reset form", () => {
    expect(
      decide(`/#access_token=${myToken}&refresh_token=r&expires_in=3600&token_type=bearer&type=recovery`, signedIn),
    ).toEqual({
      ...nothingToDo,
      cleaned: `${BASE}/login?mode=recovery`,
      ownAccountLink: { userId: me.id, accessToken: myToken, refreshToken: "r" },
    });
  });

  it("removes the person's own token that has no refresh token, and hands nothing back", () => {
    expect(decide(`/studio?projectId=p1#access_token=${myToken}&expires_in=3600`, signedIn)).toEqual({
      ...nothingToDo,
      cleaned: `${BASE}/studio?projectId=p1`,
    });
  });

  // auth-js would check such a token with the server and end the session when
  // that fails. Handed back, it replaces the session only once the server
  // confirms it is the account's (adoptOwnAccountLink), and changes nothing
  // otherwise.
  it("hands back a forged token naming the signed-in account as that account's, for the server to check", () => {
    const forged = fakeJwt({ sub: me.id });
    expect(
      decide(`/studio#access_token=${forged}&refresh_token=attacker-refresh&expires_in=3600&token_type=bearer`, signedIn),
    ).toEqual({
      ...nothingToDo,
      cleaned: `${BASE}/studio`,
      ownAccountLink: { userId: me.id, accessToken: forged, refreshToken: "attacker-refresh" },
    });
  });

  // Left in place, the reset form would change the password of the account
  // that is signed in, not the one the link was for.
  it("holds another account's recovery link and takes its reset marker away", () => {
    expect(
      decide(
        `/login?mode=recovery#access_token=${otherToken}&refresh_token=other-refresh&expires_in=3600&token_type=bearer&type=recovery`,
        signedIn,
      ),
    ).toEqual({
      cleaned: `${BASE}/login`,
      deferredCode: null,
      otherAccountLink: {
        accessToken: otherToken,
        refreshToken: "other-refresh",
        email: "other@example.test",
        recovery: true,
      },
      ownAccountLink: null,
    });
  });

  it("holds another account's sign-in link as a plain switch", () => {
    expect(
      decide(`/studio?projectId=p1#access_token=${otherToken}&refresh_token=other-refresh&type=magiclink`, signedIn),
    ).toEqual({
      cleaned: `${BASE}/login?projectId=p1`,
      deferredCode: null,
      otherAccountLink: {
        accessToken: otherToken,
        refreshToken: "other-refresh",
        email: "other@example.test",
        recovery: false,
      },
      ownAccountLink: null,
    });
  });

  // The login page is where the person chooses whether to switch.
  it("moves to the login page with another account's link, keeping the other query parameters", () => {
    for (const [path, cleaned] of [
      ["/", `${BASE}/login`],
      ["/studio?projectId=p", `${BASE}/login?projectId=p`],
    ]) {
      expect(decide(`${path}#access_token=${otherToken}&refresh_token=other-refresh`, signedIn)).toEqual({
        ...nothingToDo,
        cleaned,
        otherAccountLink: {
          accessToken: otherToken,
          refreshToken: "other-refresh",
          email: "other@example.test",
          recovery: false,
        },
      });
    }
  });

  it("treats a token it cannot read, or one that names nobody, as another account's", () => {
    for (const token of ["not-a-jwt", fakeJwt({ role: "anon" })]) {
      expect(decide(`/login#access_token=${token}&refresh_token=r`, signedIn)).toEqual({
        ...nothingToDo,
        cleaned: `${BASE}/login`,
        otherAccountLink: { accessToken: token, refreshToken: "r", email: null, recovery: false },
      });
    }
  });

  it("removes another account's token that has no refresh token, and holds nothing", () => {
    expect(decide(`/login?mode=recovery#access_token=${otherToken}&type=recovery`, signedIn)).toEqual({
      ...nothingToDo,
      cleaned: `${BASE}/login`,
    });
    // With nothing to choose, the address stays where it is.
    expect(decide(`/studio?projectId=p1#access_token=${otherToken}`, signedIn)).toEqual({
      ...nothingToDo,
      cleaned: `${BASE}/studio?projectId=p1`,
    });
  });

  it("removes only the recovery markers, so an extension embed keeps its mode", () => {
    const decision = decide(`/login?mode=extension&type=recovery#access_token=${otherToken}&refresh_token=r`, signedIn);
    expect(decision.cleaned).toBe(`${BASE}/login?mode=extension`);
    expect(decision.otherAccountLink).toMatchObject({ accessToken: otherToken, recovery: true });
    expect(decide("/login?mode=extension#error=access_denied&error_description=x", signedIn)).toEqual({
      ...nothingToDo,
      cleaned: `${BASE}/login?mode=extension`,
    });
  });

  it("reads the parameters the way auth-js does, the query's over the fragment's", () => {
    const decision = decide(
      `/login?access_token=${otherToken}&refresh_token=query-refresh#access_token=${myToken}&refresh_token=fragment-refresh`,
      signedIn,
    );
    expect(decision.cleaned).toBe(`${BASE}/login`);
    expect(decision.otherAccountLink).toMatchObject({ accessToken: otherToken, refreshToken: "query-refresh" });
    expect(decision.ownAccountLink).toBeNull();
  });
});

// Storage the page cannot read or write tells nobody apart, so the address is
// handled as it is for someone signed in, and no token counts as theirs.
describe("decideWebSessionAddress when storage cannot be used", () => {
  const unreadable = { signedInUser: UNREADABLE_SESSION_STORAGE } as const;

  it("leaves an address without session parameters alone", () => {
    expect(decide("/studio?projectId=p1#section", unreadable)).toEqual(nothingToDo);
    expect(decide("/login?mode=recovery&redirect=%2Fstudio", unreadable)).toEqual(nothingToDo);
  });

  it("holds a token pair as another account's link, whichever account it names", () => {
    for (const [token, email] of [
      [myToken, "me@example.test"],
      [otherToken, "other@example.test"],
      [fakeJwt({ role: "anon" }), null],
      ["not-a-jwt", null],
    ] as const) {
      expect(decide(`/studio?projectId=p1#access_token=${token}&refresh_token=r`, unreadable)).toEqual({
        ...nothingToDo,
        cleaned: `${BASE}/login?projectId=p1`,
        otherAccountLink: { accessToken: token, refreshToken: "r", email, recovery: false },
      });
    }
  });

  it("takes the reset marker away from a recovery link it holds", () => {
    expect(
      decide(
        `/login?mode=recovery#access_token=${myToken}&refresh_token=r&expires_in=3600&token_type=bearer&type=recovery`,
        unreadable,
      ),
    ).toEqual({
      ...nothingToDo,
      cleaned: `${BASE}/login`,
      otherAccountLink: { accessToken: myToken, refreshToken: "r", email: "me@example.test", recovery: true },
    });
  });

  it("removes errors, and the reset marker of a link that expired", () => {
    expect(
      decide(
        "/login?mode=recovery#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid",
        unreadable,
      ),
    ).toEqual({ ...nothingToDo, cleaned: `${BASE}/login` });
    expect(decide("/studio?projectId=p1&error_description=x&error_code=otp_expired", unreadable)).toEqual({
      ...nothingToDo,
      cleaned: `${BASE}/studio?projectId=p1`,
    });
  });

  // Such storage holds no PKCE verifier either, so a code cannot be this
  // browser's; even offered one, nothing is exchanged.
  it("strips a code and hands nothing back to exchange", () => {
    for (const hasCodeVerifier of [false, true]) {
      expect(decide("/login?code=oauth-code&redirect=%2Fstudio", { ...unreadable, hasCodeVerifier })).toEqual({
        ...nothingToDo,
        cleaned: `${BASE}/login?redirect=%2Fstudio`,
      });
    }
  });
});
