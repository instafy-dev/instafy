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
    expect(container.textContent).not.toContain("Log in to Instafy");

    auth.loading = false;
    await render();

    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[data-octo-motion="idle"]')).not.toBeNull();
    expect(container.querySelector("animate, animateTransform")).toBeNull();
    expect(container.textContent).toContain("Log in to Instafy");
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

  it("sits on the flat paper canvas with the dot grid and the crew logo", async () => {
    auth.loading = false;
    await render();

    const page = container.querySelector('[data-testid="login-page"]') as HTMLElement;
    expect(page.className).toContain("bg-[var(--marketing-canvas)]");
    expect(page.className).not.toContain("bg-gradient");
    // The document takes the same paper so overscroll matches the page.
    expect(document.documentElement.classList.contains("marketing-canvas")).toBe(true);

    // A full-bleed decorative grid behind the card from sm up; phones keep
    // plain paper. No glow and no artwork remain.
    const grid = container.querySelector('[data-testid="login-dot-grid"]') as HTMLElement;
    expect(grid).not.toBeNull();
    expect(grid.getAttribute("aria-hidden")).toBe("true");
    expect(grid.classList.contains("marketing-dot-grid")).toBe(true);
    expect(grid.classList.contains("hidden")).toBe(true);
    expect(grid.classList.contains("sm:block")).toBe(true);
    expect(grid.classList.contains("absolute")).toBe(true);
    expect(grid.classList.contains("inset-0")).toBe(true);
    expect(container.querySelector('[data-testid="login-ambient-glow"]')).toBeNull();
    expect(container.querySelector("[class*='landing-tentacles']")).toBeNull();

    // The 48px card logo sits on a flat surface, so its nodes take the crew colours.
    const mark = container.querySelector("svg.octo-mark") as SVGSVGElement;
    expect(mark.getAttribute("data-octo-colorway")).toBe("crew");
    expect(mark.classList.contains("octo-mark--crew")).toBe(true);
    expect(mark.classList.contains("octo-mark--crew-hidpi")).toBe(false);

    await act(async () => root.unmount());
    expect(document.documentElement.classList.contains("marketing-canvas")).toBe(false);
    root = createRoot(container);
  });

  it("keeps extension embeds on plain paper without the dot grid", async () => {
    auth.loading = false;
    await render("/login?mode=extension");

    expect(container.querySelector('[data-testid="login-page"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="login-dot-grid"]')).toBeNull();
  });
});
