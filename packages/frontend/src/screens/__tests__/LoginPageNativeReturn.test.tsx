// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPendingNativeAuthAttempt,
  writeSignInReturnPath,
  writePendingNativeAuthAttempt,
} from "../../auth/nativeAuth";
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

vi.mock("../../providers/AuthProvider", () => ({ useAuth: () => auth }));
vi.mock("../../lib/supabaseClient", () => ({ hasSupabaseConfig: true }));
vi.mock("../login/useNativeGithubAuth", () => ({
  OAUTH_PROVIDER_LABELS: { github: "GitHub", google: "Google" },
  useNativeGithubAuth: () => ({
    handleGithubLogin: vi.fn(),
    handleGoogleLogin: vi.fn(),
    resetNativeAuthState: vi.fn(),
  }),
}));

function Destination() {
  const location = useLocation();
  return <p data-testid="destination">{location.pathname}{location.search}</p>;
}

// Android can end the app while the provider's sign-in sheet is open. The deep
// link then starts a new process at the app's start page, /studio, which
// RequireAuth sends to /login?redirect=/studio before the code is exchanged.
describe("LoginPage after a native sign-in returns in a new process", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = async (entry: string) => {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/studio" element={<Destination />} />
            <Route path="/invite" element={<Destination />} />
            <Route path="/spaces/:id" element={<Destination />} />
          </Routes>
        </MemoryRouter>,
      );
    });
  };
  const signInCompletes = async (entry: string) => {
    await render(entry);
    auth.user = { id: "user-1", email: "user@example.com", user_metadata: {} };
    await render(entry);
    return container.querySelector('[data-testid="destination"]')?.textContent;
  };
  const startedFrom = (target: string) => {
    writeSignInReturnPath(target, { durable: true });
    writePendingNativeAuthAttempt(createPendingNativeAuthAttempt("google"));
    window.sessionStorage.clear();
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    auth.user = null;
    window.localStorage.clear();
    window.sessionStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("lands on the page the sign-in started from, not the start page's bounce", async () => {
    startedFrom("/invite?token=T");

    expect(await signInCompletes("/login?redirect=%2Fstudio")).toBe("/invite?token=T");
  });

  it("keeps a destination the person asked for since", async () => {
    startedFrom("/invite?token=T");

    expect(await signInCompletes("/login?redirect=%2Fspaces%2Fabc")).toBe("/spaces/abc");
  });

  it("ignores a kept destination once no sign-in is pending", async () => {
    writeSignInReturnPath("/invite?token=T", { durable: true });
    window.sessionStorage.clear();

    expect(await signInCompletes("/login?redirect=%2Fstudio")).toBe("/studio");
  });
});
