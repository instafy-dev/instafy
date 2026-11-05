// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryRouter,
  MemoryRouter,
  Route,
  RouterProvider,
  Routes,
  useLocation,
} from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSignInReturnPath, writeSignInReturnPath } from "../../auth/nativeAuth";
import { dropOtherAccountLink, holdOtherAccountLink, readOtherAccountLink } from "../../auth/otherAccountLink";
import type { OtherAccountLink } from "../../auth/sessionUrlParameters";
import { LoginPage } from "../LoginPage";

const auth = vi.hoisted(() => ({
  loading: false,
  user: null as { id: string; email: string; user_metadata: Record<string, unknown> } | null,
  sendEmailOtp: vi.fn(),
  verifyEmailOtp: vi.fn(),
  signInWithPassword: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  updatePassword: vi.fn(),
  signInAnonymously: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  client: { auth: {} },
  switchToOtherAccountLink: vi.fn(),
  // Whether a session survives a full load; false where storage is blocked.
  sessionPersists: true,
}));

vi.mock("../../providers/AuthProvider", () => ({ useAuth: () => auth }));
vi.mock("../../lib/supabaseClient", () => ({
  hasSupabaseConfig: true,
  supabase: mocks.client,
  supabaseUrl: "https://project.supabase.co",
  supabaseAnonKey: "anon-key",
  get sessionPersistsAcrossLoads() {
    return mocks.sessionPersists;
  },
}));
// The page reads the real store; only the round trip to the auth server is replaced.
vi.mock("../../auth/otherAccountLink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../auth/otherAccountLink")>()),
  switchToOtherAccountLink: mocks.switchToOtherAccountLink,
}));
vi.mock("../login/useNativeGithubAuth", () => ({
  OAUTH_PROVIDER_LABELS: { github: "GitHub", google: "Google" },
  useNativeGithubAuth: () => ({
    handleGithubLogin: vi.fn(),
    handleGoogleLogin: vi.fn(),
    resetNativeAuthState: vi.fn(),
  }),
}));

function StudioDestination() {
  const location = useLocation();
  return <p data-testid="studio-destination">{location.pathname}{location.search}</p>;
}

const SIGNED_IN_USER = { id: "user-a", email: "a@example.com", user_metadata: {} };
const LOGIN_FOR_PROJECT = "/login?redirect=%2Fstudio%3FprojectId%3Dproject-1";

function linkFor(overrides: Partial<OtherAccountLink> = {}): OtherAccountLink {
  return {
    accessToken: "access-token-b",
    refreshToken: "refresh-token-b",
    email: "b@example.com",
    recovery: false,
    ...overrides,
  };
}

describe("LoginPage holding another account's link", () => {
  let container: HTMLDivElement;
  let root: Root;
  const assign = vi.fn();

  const render = async (initialEntry = LOGIN_FOR_PROJECT) => {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/studio" element={<StudioDestination />} />
          </Routes>
        </MemoryRouter>,
      );
    });
  };

  const renderSignedIn = async (initialEntry?: string) => {
    auth.user = SIGNED_IN_USER;
    await render(initialEntry);
  };

  const buttonByText = (text: string) =>
    [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === text);

  const press = async (text: string) => {
    const button = buttonByText(text);
    if (!button) throw new Error(`Missing button: ${text}`);
    await act(async () => button.click());
  };

  const title = () => container.querySelector("h1")?.textContent;
  const description = () => container.querySelector("h1 + p")?.textContent;
  const destination = () => container.querySelector('[data-testid="studio-destination"]')?.textContent ?? null;
  const choices = () =>
    [...(container.querySelector('[data-testid="login-other-account-link"]')?.querySelectorAll("button") ?? [])]
      .map((button) => button.textContent?.trim());
  const notice = () => container.querySelector('[data-testid="login-other-account-link-error"]');
  // Where the one full load went, as a path; it must stay on this origin.
  const assignedTo = () => {
    expect(assign).toHaveBeenCalledTimes(1);
    const url = new URL(String(assign.mock.calls[0][0]));
    expect(url.origin).toBe(window.location.origin);
    return `${url.pathname}${url.search}${url.hash}`;
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    auth.loading = false;
    auth.user = null;
    mocks.switchToOtherAccountLink.mockReset();
    mocks.switchToOtherAccountLink.mockResolvedValue("switched");
    mocks.sessionPersists = true;
    assign.mockReset();
    // jsdom cannot navigate and its Location members cannot be redefined, so
    // the page gets a location that records where a full load would go.
    const { href, origin, pathname, search, hash } = window.location;
    vi.stubGlobal("location", { href, origin, pathname, search, hash, assign });
    window.localStorage.clear();
    window.sessionStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    dropOtherAccountLink();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("asks before leaving the signed-in account instead of continuing to the workspace", async () => {
    holdOtherAccountLink(linkFor());
    // The session finishes restoring after the first render, as on a real load.
    auth.loading = true;
    await render();
    auth.loading = false;
    auth.user = SIGNED_IN_USER;
    await render();

    expect(title()).toBe("Switch accounts?");
    expect(description()).toBe("This link is for b@example.com. You're signed in as a@example.com.");
    expect(choices()).toEqual(["Switch accounts", "Stay signed in"]);
    expect(container.querySelector('input[type="email"]')).toBeNull();
    expect(destination()).toBeNull();
    expect(mocks.switchToOtherAccountLink).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("calls a password reset link what it is", async () => {
    holdOtherAccountLink(linkFor({ recovery: true }));
    await renderSignedIn("/login");

    expect(title()).toBe("Switch accounts?");
    expect(description())
      .toBe("This password reset link is for b@example.com. You're signed in as a@example.com.");
  });

  it("speaks of another account when the link does not name one", async () => {
    holdOtherAccountLink(linkFor({ email: null }));
    await renderSignedIn();

    expect(description()).toBe("This link is for another account. You're signed in as a@example.com.");
  });

  it("drops the link and continues to the intended workspace when the person stays signed in", async () => {
    holdOtherAccountLink(linkFor());
    await renderSignedIn();

    await press("Stay signed in");

    expect(readOtherAccountLink()).toBeNull();
    expect(destination()).toBe("/studio?projectId=project-1");
    expect(mocks.switchToOtherAccountLink).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("switches the signed-in browser with a full load of the intended workspace", async () => {
    const link = linkFor();
    holdOtherAccountLink(link);
    await renderSignedIn();

    await press("Switch accounts");

    expect(mocks.switchToOtherAccountLink).toHaveBeenCalledTimes(1);
    expect(mocks.switchToOtherAccountLink).toHaveBeenCalledWith(link, {
      client: mocks.client,
      supabaseUrl: "https://project.supabase.co",
      anonKey: "anon-key",
      signedIn: true,
    });
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assignedTo()).toBe("/studio?projectId=project-1");
  });

  it("forgets where an earlier sign-in meant to go once it switches", async () => {
    writeSignInReturnPath("/studio?projectId=earlier", { durable: true });
    holdOtherAccountLink(linkFor());
    await renderSignedIn();

    await press("Switch accounts");

    expect(assignedTo()).toBe("/studio?projectId=project-1");
    expect(readSignInReturnPath()).toBeNull();
  });

  // An emailed link that asked for no redirect lands on /login, in a tab that
  // may still keep where an earlier, unrelated sign-in meant to go.
  it("goes to Studio, not where an earlier sign-in meant to go, when the address names nowhere", async () => {
    writeSignInReturnPath("/invite?token=earlier-invite", { durable: false });
    holdOtherAccountLink(linkFor());
    await renderSignedIn("/login");

    await press("Switch accounts");

    expect(assignedTo()).toBe("/studio");
    expect(readSignInReturnPath()).toBeNull();
  });

  // Unlike the router, a full load follows any address it is given, so after a
  // switch only a path on this origin is followed.
  it.each([
    ["a javascript: address", "javascript:alert(1)"],
    ["a protocol-relative address on another host", "//evil.example"],
    ["a backslashed path that browsers read as another host", "/\\evil.example"],
    ["another site", "https://evil.example/x"],
    ["the login page", "/login?mode=x"],
    // The router matches these to the login page too, where mode=recovery
    // would open the reset form for the account just switched to.
    ["the login page in another case", "/Login?mode=recovery"],
    ["the login page with a trailing slash", "/login/?mode=recovery"],
    ["the login page behind a doubled slash", "//login?mode=recovery"],
    // The router decodes each segment before it matches.
    ["the login page with an encoded letter", "/%6Cogin?mode=recovery"],
    ["the login page encoded throughout", "/%6C%6F%67%69%6E/?mode=recovery"],
    ["a path with a malformed escape", "/%E0%A4%A?mode=recovery"],
    ["an address that does not parse", "http://[::1"],
  ])("lands on Studio after switching instead of following %s", async (_kind, redirect) => {
    holdOtherAccountLink(linkFor());
    await renderSignedIn(`/login?redirect=${encodeURIComponent(redirect)}`);

    await press("Switch accounts");

    expect(assign).toHaveBeenCalledTimes(1);
    expect(assignedTo()).toBe("/studio");
  });

  // These resolve to a path that starts with //. Followed as that path, a full
  // load would read it as another host; followed as the resolved address, it
  // stays here.
  it.each([
    ["a dot segment before a doubled slash", "/.//evil.example/phish"],
    ["two dot segments before a doubled slash", "/..//evil.example/phish"],
    ["this site's own address with a doubled slash", "http://localhost:3000//evil.example/phish"],
  ])("stays on this site after switching with %s", async (_kind, redirect) => {
    holdOtherAccountLink(linkFor());
    await renderSignedIn(`/login?redirect=${encodeURIComponent(redirect)}`);

    await press("Switch accounts");

    expect(assignedTo()).toBe("//evil.example/phish");
  });

  it("moves within the app after switching where a full load would lose the session", async () => {
    // Storage is blocked, so the new session lives only in this page.
    mocks.sessionPersists = false;
    holdOtherAccountLink(linkFor());
    await renderSignedIn();

    await press("Switch accounts");

    expect(assign).not.toHaveBeenCalled();
    expect(readOtherAccountLink()).toBeNull();
    expect(destination()).toBe("/studio?projectId=project-1");
  });

  it.each([
    ["the query", "/invite?mode=recovery&token=abc&type=recovery", "/invite?token=abc"],
    ["a repeat of the key", "/invite?mode=x&mode=recovery&token=abc", "/invite?token=abc"],
    ["the fragment", "/studio?projectId=p1#type=recovery", "/studio?projectId=p1"],
  ])("takes the reset marker out of %s after a switch that is not a reset", async (_where, redirect, expected) => {
    holdOtherAccountLink(linkFor());
    await renderSignedIn(`/login?redirect=${encodeURIComponent(redirect)}`);

    await press("Switch accounts");

    expect(assignedTo()).toBe(expected);
  });

  // With a data router, as in the app, navigation is asynchronous: the page is
  // still mounted when the link goes and the new account arrives, which is
  // when its usual signed-in redirect could take over.
  describe("where storage is blocked, under the app's data router", () => {
    const renderDataRouter = async (initialEntry: string) => {
      const router = createMemoryRouter(
        [
          { path: "/login", element: <LoginPage /> },
          { path: "/studio", element: <StudioDestination /> },
        ],
        { initialEntries: [initialEntry] },
      );
      await act(async () => {
        root.render(<RouterProvider router={router} />);
      });
      return router;
    };

    beforeEach(() => {
      mocks.sessionPersists = false;
      // The switch brings in the link's account, as AuthProvider would.
      mocks.switchToOtherAccountLink.mockImplementation(async () => {
        auth.user = { id: "user-b", email: "b@example.com", user_metadata: {} };
        return "switched";
      });
    });

    it("opens the reset form for a password reset link", async () => {
      holdOtherAccountLink(linkFor({ recovery: true }));
      auth.user = SIGNED_IN_USER;
      const router = await renderDataRouter(LOGIN_FOR_PROJECT);

      await press("Switch accounts");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(`${router.state.location.pathname}${router.state.location.search}`).toBe("/login?mode=recovery");
      expect(title()).toBe("Reset your password");
    });

    it("goes where the switch decided, not to a redirect that names the reset form", async () => {
      holdOtherAccountLink(linkFor());
      auth.user = SIGNED_IN_USER;
      const router = await renderDataRouter(
        `/login?redirect=${encodeURIComponent("/login?mode=recovery")}`,
      );

      await press("Switch accounts");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(router.state.location.pathname).toBe("/studio");
      expect(assign).not.toHaveBeenCalled();
    });
  });

  it("follows a redirect to another page of this site after switching", async () => {
    holdOtherAccountLink(linkFor());
    await renderSignedIn(`/login?redirect=${encodeURIComponent("/invite?token=abc")}`);

    await press("Switch accounts");

    expect(assign).toHaveBeenCalledTimes(1);
    expect(assignedTo()).toBe("/invite?token=abc");
  });

  it("opens the reset form after switching to a password reset link", async () => {
    holdOtherAccountLink(linkFor({ recovery: true }));
    await renderSignedIn();

    await press("Switch accounts");

    expect(mocks.switchToOtherAccountLink).toHaveBeenCalledWith(
      expect.objectContaining({ recovery: true }),
      expect.objectContaining({ signedIn: true }),
    );
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assignedTo()).toBe("/login?mode=recovery");
  });

  it("switches once and holds Stay signed in while the switch is in flight", async () => {
    let settle: (outcome: "switched") => void = () => {};
    mocks.switchToOtherAccountLink.mockImplementation(
      () => new Promise((resolve) => { settle = resolve; }),
    );
    holdOtherAccountLink(linkFor());
    await renderSignedIn();

    await press("Switch accounts");
    expect(buttonByText("Switch accounts")?.getAttribute("data-pending")).toBe("true");
    expect(buttonByText("Stay signed in")?.disabled).toBe(true);
    await press("Switch accounts");
    expect(mocks.switchToOtherAccountLink).toHaveBeenCalledTimes(1);

    await act(async () => settle("switched"));
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("keeps both controls busy after switching, until the full load replaces the page", async () => {
    holdOtherAccountLink(linkFor());
    await renderSignedIn();

    await press("Switch accounts");
    expect(assign).toHaveBeenCalledTimes(1);

    const switchAccounts = buttonByText("Switch accounts");
    expect(switchAccounts?.getAttribute("data-pending") === "true" || switchAccounts?.disabled === true).toBe(true);
    expect(buttonByText("Stay signed in")?.disabled).toBe(true);
    await press("Switch accounts");
    expect(mocks.switchToOtherAccountLink).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("says the link has expired, leaving Stay signed in, which still leads to the workspace", async () => {
    mocks.switchToOtherAccountLink.mockResolvedValue("expired");
    holdOtherAccountLink(linkFor());
    await renderSignedIn();

    await press("Switch accounts");

    expect(notice()?.getAttribute("role")).toBe("alert");
    expect(notice()?.textContent).toContain("This link has expired or was already used. Ask for a new one.");
    expect(choices()).toEqual(["Stay signed in"]);
    expect(buttonByText("Stay signed in")?.disabled).toBe(false);
    expect(assign).not.toHaveBeenCalled();
    expect(destination()).toBeNull();

    // The server refused the link before anything changed, so staying still leads where it always did.
    await press("Stay signed in");
    expect(readOtherAccountLink()).toBeNull();
    expect(notice()).toBeNull();
    expect(destination()).toBe("/studio?projectId=project-1");
  });

  it("keeps Switch accounts when Instafy cannot be reached, and pressing it again retries", async () => {
    mocks.switchToOtherAccountLink.mockResolvedValueOnce("unavailable");
    const link = linkFor();
    holdOtherAccountLink(link);
    await renderSignedIn();

    await press("Switch accounts");

    expect(notice()?.getAttribute("role")).toBe("alert");
    expect(notice()?.textContent).toContain("Couldn't reach Instafy. Try again.");
    expect(choices()).toEqual(["Switch accounts", "Stay signed in"]);
    expect(buttonByText("Stay signed in")?.disabled).toBe(false);
    expect(assign).not.toHaveBeenCalled();
    expect(destination()).toBeNull();

    await press("Switch accounts");

    expect(mocks.switchToOtherAccountLink).toHaveBeenCalledTimes(2);
    expect(mocks.switchToOtherAccountLink).toHaveBeenLastCalledWith(link, expect.objectContaining({ signedIn: true }));
    expect(notice()).toBeNull();
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assignedTo()).toBe("/studio?projectId=project-1");
  });

  it("lets the link go and says so on the login form when the switch signed out and then failed", async () => {
    // The switch signed the current account out before the link failed, so the
    // provider reports nobody signed in by the time the page hears back. The
    // link must not wait there for whoever signs in next.
    mocks.switchToOtherAccountLink.mockImplementation(async () => {
      auth.user = null;
      return "signedOut";
    });
    holdOtherAccountLink(linkFor());
    await renderSignedIn();

    await press("Switch accounts");

    expect(readOtherAccountLink()).toBeNull();
    expect(container.querySelector('[data-testid="login-other-account-link"]')).toBeNull();
    expect(container.querySelector('[data-testid="login-error"]')?.textContent)
      .toContain("You're signed out here, but this link couldn't sign you in. Ask for a new link, or log in.");
    expect(title()).toBe("Log in to Instafy");
    expect(container.querySelector('input[type="email"]')).not.toBeNull();
    expect(assign).not.toHaveBeenCalled();
    expect(destination()).toBeNull();
  });

  it("offers a signed-out page the link without naming a current account", async () => {
    const link = linkFor();
    holdOtherAccountLink(link);
    await render("/login");

    expect(description()).toBe("This link is for b@example.com.");
    expect(container.textContent).not.toContain("You're signed in as");
    expect(choices()).toEqual(["Continue with this link", "Not now"]);

    await press("Continue with this link");

    expect(mocks.switchToOtherAccountLink).toHaveBeenCalledWith(link, expect.objectContaining({ signedIn: false }));
    expect(assignedTo()).toBe("/studio");
  });

  it("returns a signed-out page to the login form on Not now", async () => {
    holdOtherAccountLink(linkFor());
    await render("/login");

    await press("Not now");

    expect(readOtherAccountLink()).toBeNull();
    expect(title()).toBe("Log in to Instafy");
    expect(container.querySelector('input[type="email"]')).not.toBeNull();
    expect(mocks.switchToOtherAccountLink).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("says the link couldn't sign a signed-out page in, and Not now opens the login form", async () => {
    mocks.switchToOtherAccountLink.mockResolvedValue("failed");
    const link = linkFor();
    holdOtherAccountLink(link);
    await render("/login");

    await press("Continue with this link");

    expect(mocks.switchToOtherAccountLink).toHaveBeenCalledWith(link, expect.objectContaining({ signedIn: false }));
    expect(notice()?.getAttribute("role")).toBe("alert");
    expect(notice()?.textContent).toContain("This link couldn't sign you in. Ask for a new one.");
    expect(choices()).toEqual(["Not now"]);
    expect(assign).not.toHaveBeenCalled();

    await press("Not now");
    expect(readOtherAccountLink()).toBeNull();
    expect(notice()).toBeNull();
    expect(title()).toBe("Log in to Instafy");
    expect(container.querySelector('input[type="email"]')).not.toBeNull();
  });
});
