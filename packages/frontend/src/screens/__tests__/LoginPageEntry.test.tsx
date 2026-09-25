// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "../LoginPage";

const auth = vi.hoisted(() => ({
  loading: true,
  user: null as { id: string; email: string; user_metadata: Record<string, unknown> } | null,
  sendEmailOtp: vi.fn(),
  verifyEmailOtp: vi.fn(),
  signInWithPassword: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  updatePassword: vi.fn(),
  signInAnonymously: vi.fn(),
}));

vi.mock("../../providers/AuthProvider", () => ({ useAuth: () => auth }));
vi.mock("../login/useNativeGithubAuth", () => ({
  OAUTH_REDIRECT_TARGET_KEY: "instafy.oauth.redirectTarget",
  OAUTH_PROVIDER_LABELS: { github: "GitHub", google: "Google" },
  useNativeGithubAuth: () => ({
    handleGithubLogin: vi.fn(),
    handleGoogleLogin: vi.fn(),
    resetNativeAuthState: vi.fn(),
  }),
}));
vi.mock("../landing/LandingTentacleScene", () => ({ TentacleBackdrop: () => null }));

function StudioDestination() {
  const location = useLocation();
  return <p data-testid="studio-destination">{location.pathname}{location.search}</p>;
}

describe("LoginPage entry handoff", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = async (initialEntry = "/login?redirect=%2Fstudio%3FprojectId%3Dproject-1") => {
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

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    auth.loading = true;
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

  it("withholds the login form until session restoration finishes, then focuses email", async () => {
    await render();
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.querySelector('[data-octo-motion="thinking"]')?.getAttribute("data-octo-animated"))
      .toBe("true");
    expect(container.textContent).not.toContain("Instafy");
    expect(container.querySelector('input[type="email"]')).toBeNull();
    expect(container.textContent).not.toContain("Log in or sign up");

    auth.loading = false;
    await render();

    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[data-octo-motion="idle"]')).not.toBeNull();
    expect(container.querySelector("animate, animateTransform")).toBeNull();
    expect(container.textContent).toContain("Log in or sign up");
    expect(document.activeElement).toBe(container.querySelector('input[type="email"]'));
  });

  it("continues a restored session to the intended workspace without showing the login form", async () => {
    await render();
    auth.loading = false;
    auth.user = { id: "user-1", email: "returning@example.com", user_metadata: {} };
    await render();

    expect(container.querySelector('[data-testid="studio-destination"]')?.textContent)
      .toBe("/studio?projectId=project-1");
    expect(container.querySelector('input[type="email"]')).toBeNull();
  });

  it("keeps password recovery available for a signed-in session", async () => {
    auth.loading = false;
    auth.user = { id: "user-1", email: "returning@example.com", user_metadata: {} };
    await render("/login?type=recovery");

    expect(container.textContent).toContain("Reset your password");
    expect(container.querySelector('[data-testid="studio-destination"]')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
    // The heading and description already say what to do; no notice repeats it.
    expect(container.querySelector('[data-testid="login-message"]')).toBeNull();
  });
});
