// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adoptOwnAccountLink,
  dropOtherAccountLink,
  holdOtherAccountLink,
  readOtherAccountLink,
  switchToOtherAccountLink,
  useOtherAccountLink,
} from "../otherAccountLink";
import type { OtherAccountLink, OwnAccountLink } from "../sessionUrlParameters";

const SUPABASE_URL = "https://abc.supabase.co";

const link: OtherAccountLink = {
  accessToken: "link-access-token",
  refreshToken: "link-refresh-token",
  email: "other@example.test",
  recovery: false,
};
const recoveryLink: OtherAccountLink = { ...link, recovery: true };

const ownLink: OwnAccountLink = {
  userId: "8f14e45f-ceea-467f-a0e6-1b2c3d4e5f60",
  accessToken: "own-access-token",
  refreshToken: "own-refresh-token",
};

afterEach(() => {
  dropOtherAccountLink();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fakeClient({ setSessionError = null }: { setSessionError?: unknown } = {}) {
  const calls: string[] = [];
  const client = {
    auth: {
      signOut: vi.fn(async (options: { scope: "local" }) => {
        calls.push(`signOut:${options.scope}`);
        return { error: null };
      }),
      setSession: vi.fn(async (tokens: { access_token: string; refresh_token: string }) => {
        calls.push(`setSession:${tokens.access_token}`);
        return { error: setSessionError };
      }),
    },
  };
  return { client, calls };
}

function answering(status: number, calls: string[] = []) {
  return vi.fn<typeof fetch>(async () => {
    calls.push("fetch");
    return new Response(null, { status });
  });
}

function unreachable() {
  return vi.fn<typeof fetch>(async () => {
    throw new TypeError("Failed to fetch");
  });
}

describe("the held link", () => {
  it("is held, read and dropped", () => {
    expect(readOtherAccountLink()).toBeNull();
    holdOtherAccountLink(link);
    expect(readOtherAccountLink()).toBe(link);
    dropOtherAccountLink();
    expect(readOtherAccountLink()).toBeNull();
    dropOtherAccountLink();
    expect(readOtherAccountLink()).toBeNull();
  });

  it("keeps the link's tokens out of storage", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    holdOtherAccountLink(link);
    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe("useOtherAccountLink", () => {
  let container: HTMLDivElement;
  let root: Root;
  let seen: Array<OtherAccountLink | null>;

  function Probe() {
    seen.push(useOtherAccountLink());
    return null;
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    seen = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  // The Supabase client holds the link while it loads, before any page renders.
  it("shows a link held before the page mounted, and follows it being held and dropped", async () => {
    holdOtherAccountLink(link);
    await act(async () => root.render(createElement(Probe)));
    expect(seen.at(-1)).toBe(link);

    await act(async () => dropOtherAccountLink());
    expect(seen.at(-1)).toBeNull();

    await act(async () => holdOtherAccountLink(recoveryLink));
    expect(seen.at(-1)).toBe(recoveryLink);

    await act(async () => holdOtherAccountLink(null));
    expect(seen.at(-1)).toBeNull();
  });
});

describe("switchToOtherAccountLink", () => {
  it.each([401, 403])(
    "calls the link expired when the server refuses it with %i, and leaves the account signed in",
    async (status) => {
      const { client } = fakeClient();
      const outcome = await switchToOtherAccountLink(link, {
        client,
        supabaseUrl: SUPABASE_URL,
        anonKey: "anon-key",
        signedIn: true,
        fetchImpl: answering(status),
      });

      expect(outcome).toBe("expired");
      expect(client.auth.signOut).not.toHaveBeenCalled();
      expect(client.auth.setSession).not.toHaveBeenCalled();
    },
  );

  // These answers say nothing about the link, which may still work on a retry.
  it.each([429, 500, 503])(
    "calls the server unavailable when it answers %i, and leaves the account signed in",
    async (status) => {
      const { client } = fakeClient();
      const outcome = await switchToOtherAccountLink(link, {
        client,
        supabaseUrl: SUPABASE_URL,
        anonKey: "anon-key",
        signedIn: true,
        fetchImpl: answering(status),
      });

      expect(outcome).toBe("unavailable");
      expect(client.auth.signOut).not.toHaveBeenCalled();
      expect(client.auth.setSession).not.toHaveBeenCalled();
    },
  );

  it("calls the server unavailable when it cannot be reached, and leaves the account signed in", async () => {
    const { client } = fakeClient();
    const outcome = await switchToOtherAccountLink(link, {
      client,
      supabaseUrl: SUPABASE_URL,
      anonKey: "anon-key",
      signedIn: true,
      fetchImpl: unreachable(),
    });

    expect(outcome).toBe("unavailable");
    expect(client.auth.signOut).not.toHaveBeenCalled();
    expect(client.auth.setSession).not.toHaveBeenCalled();
  });

  it("signs the current account out on this browser only once the server accepts the link, then signs in", async () => {
    const { client, calls } = fakeClient();
    const outcome = await switchToOtherAccountLink(link, {
      client,
      supabaseUrl: SUPABASE_URL,
      anonKey: "anon-key",
      signedIn: true,
      fetchImpl: answering(200, calls),
    });

    expect(outcome).toBe("switched");
    expect(calls).toEqual(["fetch", "signOut:local", "setSession:link-access-token"]);
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(client.auth.setSession).toHaveBeenCalledWith({
      access_token: "link-access-token",
      refresh_token: "link-refresh-token",
    });
  });

  it("signs nobody out when nobody is signed in", async () => {
    const { client, calls } = fakeClient();
    const outcome = await switchToOtherAccountLink(link, {
      client,
      supabaseUrl: SUPABASE_URL,
      anonKey: "anon-key",
      signedIn: false,
      fetchImpl: answering(200, calls),
    });

    expect(outcome).toBe("switched");
    expect(calls).toEqual(["fetch", "setSession:link-access-token"]);
    expect(client.auth.signOut).not.toHaveBeenCalled();
  });

  it("says this browser is signed out when the session cannot be set after the current account left", async () => {
    const { client, calls } = fakeClient({ setSessionError: new Error("Invalid Refresh Token: Refresh Token Not Found") });
    holdOtherAccountLink(link);
    const outcome = await switchToOtherAccountLink(link, {
      client,
      supabaseUrl: SUPABASE_URL,
      anonKey: "anon-key",
      signedIn: true,
      fetchImpl: answering(200, calls),
    });

    expect(outcome).toBe("signedOut");
    expect(calls).toEqual(["fetch", "signOut:local", "setSession:link-access-token"]);
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    // The session this page started with has ended, so the link must not
    // wait for whoever signs in next.
    expect(readOtherAccountLink()).toBeNull();
  });

  it("fails when nobody is signed in and the session cannot be set", async () => {
    const { client, calls } = fakeClient({ setSessionError: new Error("Invalid Refresh Token: Refresh Token Not Found") });
    const outcome = await switchToOtherAccountLink(link, {
      client,
      supabaseUrl: SUPABASE_URL,
      anonKey: "anon-key",
      signedIn: false,
      fetchImpl: answering(200, calls),
    });

    expect(outcome).toBe("failed");
    expect(calls).toEqual(["fetch", "setSession:link-access-token"]);
    expect(client.auth.signOut).not.toHaveBeenCalled();
  });

  it("asks the project's auth server with the anon key and the link's token, keeping a path in the project URL", async () => {
    for (const [supabaseUrl, expected] of [
      [SUPABASE_URL, "https://abc.supabase.co/auth/v1/user"],
      [`${SUPABASE_URL}/`, "https://abc.supabase.co/auth/v1/user"],
      ["http://127.0.0.1:54321", "http://127.0.0.1:54321/auth/v1/user"],
      ["https://example.test/supabase", "https://example.test/supabase/auth/v1/user"],
    ] as const) {
      const fetchImpl = answering(401);
      await switchToOtherAccountLink(link, {
        client: fakeClient().client,
        supabaseUrl,
        anonKey: "anon-key",
        signedIn: true,
        fetchImpl,
      });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe(expected);
      expect(init?.method ?? "GET").toBe("GET");
      expect(init?.headers).toEqual({ apikey: "anon-key", Authorization: "Bearer link-access-token" });
    }
  });

  it("uses the page's fetch when none is given", async () => {
    const fetchMock = answering(401);
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await switchToOtherAccountLink(link, {
      client: fakeClient().client,
      supabaseUrl: SUPABASE_URL,
      anonKey: "anon-key",
      signedIn: true,
    });

    expect(outcome).toBe("expired");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("adoptOwnAccountLink", () => {
  // The auth server answers a token it accepts with that token's user.
  function accepting(body: string) {
    return vi.fn<typeof fetch>(async () => new Response(body, { status: 200 }));
  }

  it("puts the link's session in place when the server says the token is the signed-in account's, in any case", async () => {
    const id = ownLink.userId;
    for (const [linkId, serverId] of [
      [id, id],
      [id, id.toUpperCase()],
      [id.toUpperCase(), id],
    ]) {
      const { client } = fakeClient();
      const adopted = await adoptOwnAccountLink(
        { ...ownLink, userId: linkId },
        {
          client,
          supabaseUrl: SUPABASE_URL,
          anonKey: "anon-key",
          fetchImpl: accepting(JSON.stringify({ id: serverId, email: "me@example.test" })),
        },
      );

      expect(adopted, `link ${linkId}, server ${serverId}`).toBe(true);
      expect(client.auth.setSession).toHaveBeenCalledTimes(1);
      expect(client.auth.setSession).toHaveBeenCalledWith({
        access_token: "own-access-token",
        refresh_token: "own-refresh-token",
      });
      expect(client.auth.signOut).not.toHaveBeenCalled();
    }
  });

  // Only the token's unchecked claim made this the signed-in account's link, so a
  // forged token gets here too: short of the server naming that account, its
  // session must stay as it is.
  it.each<[string, () => typeof fetch]>([
    ["names another account", () => accepting(JSON.stringify({ id: "5d41402a-bc4b-4a76-b971-9d911017c592" }))],
    ["names no account", () => accepting(JSON.stringify({ email: "me@example.test" }))],
    ["answers with something other than JSON", () => accepting("<!doctype html><title>Bad gateway</title>")],
    ["answers with an empty body", () => accepting("")],
    ["refuses the token with 401", () => answering(401)],
    ["refuses the token with 403", () => answering(403)],
    ["fails with 500", () => answering(500)],
    ["cannot be reached", unreachable],
  ])("leaves the stored session alone when the server %s", async (_, makeFetch) => {
    const { client } = fakeClient();
    const adopted = await adoptOwnAccountLink(ownLink, {
      client,
      supabaseUrl: SUPABASE_URL,
      anonKey: "anon-key",
      fetchImpl: makeFetch(),
    });

    expect(adopted).toBe(false);
    expect(client.auth.setSession).not.toHaveBeenCalled();
    expect(client.auth.signOut).not.toHaveBeenCalled();
  });

  it("never signs the account out, even when the link's session cannot be set", async () => {
    const { client } = fakeClient({ setSessionError: new Error("Invalid Refresh Token: Refresh Token Not Found") });
    const adopted = await adoptOwnAccountLink(ownLink, {
      client,
      supabaseUrl: SUPABASE_URL,
      anonKey: "anon-key",
      fetchImpl: accepting(JSON.stringify({ id: ownLink.userId })),
    });

    expect(adopted).toBe(false);
    expect(client.auth.setSession).toHaveBeenCalledTimes(1);
    expect(client.auth.signOut).not.toHaveBeenCalled();
  });

  it("asks the auth server with the same address and headers as a switch", async () => {
    for (const supabaseUrl of [
      SUPABASE_URL,
      `${SUPABASE_URL}/`,
      "http://127.0.0.1:54321",
      "https://example.test/supabase",
    ]) {
      const switchFetch = answering(401);
      await switchToOtherAccountLink(link, {
        client: fakeClient().client,
        supabaseUrl,
        anonKey: "anon-key",
        signedIn: true,
        fetchImpl: switchFetch,
      });
      const adoptFetch = answering(401);
      await adoptOwnAccountLink(
        { userId: ownLink.userId, accessToken: link.accessToken, refreshToken: link.refreshToken },
        { client: fakeClient().client, supabaseUrl, anonKey: "anon-key", fetchImpl: adoptFetch },
      );

      expect(switchFetch).toHaveBeenCalledTimes(1);
      expect(adoptFetch).toHaveBeenCalledTimes(1);
      expect(adoptFetch.mock.calls[0]).toEqual(switchFetch.mock.calls[0]);
    }
  });

  it("uses the page's fetch when none is given", async () => {
    const fetchMock = accepting(JSON.stringify({ id: ownLink.userId }));
    vi.stubGlobal("fetch", fetchMock);
    const { client } = fakeClient();

    const adopted = await adoptOwnAccountLink(ownLink, {
      client,
      supabaseUrl: SUPABASE_URL,
      anonKey: "anon-key",
    });

    expect(adopted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
