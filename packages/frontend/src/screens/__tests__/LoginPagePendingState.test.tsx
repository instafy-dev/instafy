// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "../LoginPage";

type Provider = "github" | "google";
type HookOptions = {
  setError: (value: string | null) => void;
  setPendingProvider: (value: Provider | null) => void;
  setAwaitingBrowser: (value: Provider | null) => void;
};

vi.hoisted(() => {
  vi.stubEnv("VITE_INSTAFY_ENABLE_GOOGLE_AUTH", "1");
});

const auth = vi.hoisted(() => ({
  loading: false,
  user: null,
  sendEmailOtp: vi.fn(),
  verifyEmailOtp: vi.fn(),
  signInWithPassword: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  updatePassword: vi.fn(),
  signInAnonymously: vi.fn(),
}));

const hook = vi.hoisted(() => ({
  options: null as HookOptions | null,
  handleGithubLogin: vi.fn(),
  handleGoogleLogin: vi.fn(),
}));

vi.mock("../../providers/AuthProvider", () => ({ useAuth: () => auth }));
vi.mock("../../lib/supabaseClient", () => ({ hasSupabaseConfig: true }));
vi.mock("../login/useNativeGithubAuth", () => ({
  OAUTH_REDIRECT_TARGET_KEY: "instafy.oauth.redirectTarget",
  OAUTH_PROVIDER_LABELS: { github: "GitHub", google: "Google" },
  useNativeGithubAuth: (options: HookOptions) => {
    hook.options = options;
    return {
      handleGithubLogin: hook.handleGithubLogin,
      handleGoogleLogin: hook.handleGoogleLogin,
      resetNativeAuthState: vi.fn(),
    };
  },
}));
vi.mock("../landing/LandingTentacleScene", () => ({ TentacleBackdrop: () => null }));

// The login page used to report a sign-in that was leaving for the provider as
// a success-styled box under the whole form. The pressed control now carries
// the pending state; only the desktop wait for the system browser gets words.
describe("LoginPage pending state", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = async (initialEntry = "/login") => {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[initialEntry]}>
          <LoginPage />
        </MemoryRouter>,
      );
    });
  };

  const buttonByText = (text: string) =>
    [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === text) as
      | HTMLButtonElement
      | undefined;

  const typeInto = async (input: HTMLInputElement, value: string) => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setValue?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    window.sessionStorage.clear();
    hook.options = null;
    hook.handleGithubLogin.mockReset();
    hook.handleGithubLogin.mockImplementation(() => hook.options?.setPendingProvider("github"));
    hook.handleGoogleLogin.mockReset();
    hook.handleGoogleLogin.mockImplementation(() => hook.options?.setPendingProvider("google"));
    auth.sendPasswordResetEmail.mockReset();
    auth.signInWithPassword.mockReset();
    auth.sendEmailOtp.mockReset();
    auth.verifyEmailOtp.mockReset();
    auth.updatePassword.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("shows a web provider redirect in the pressed button, with no status box", async () => {
    await render();
    // A typed email enables Continue, so the check below proves the press
    // disabled it rather than the empty field.
    await typeInto(container.querySelector('input[type="email"]') as HTMLInputElement, "dev@example.com");
    expect((container.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false);
    const github = buttonByText("Continue with GitHub");
    expect(github?.querySelector("svg")).not.toBeNull();

    await act(async () => github?.click());

    expect(hook.handleGithubLogin).toHaveBeenCalledTimes(1);
    expect(github?.getAttribute("data-pending")).toBe("true");
    expect(github?.disabled).toBe(false);
    expect(github?.querySelectorAll(".animate-spin")).toHaveLength(1);
    expect(github?.querySelector("svg")).toBeNull();
    expect(github?.textContent).toBe("Continue with GitHub");
    expect((container.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
    expect(buttonByText("Continue with Google")?.disabled).toBe(true);
    const guest = buttonByText("Continue as guest");
    if (guest) {
      expect(guest.disabled).toBe(true);
    }
    expect(container.querySelector('[data-testid="login-message"]')).toBeNull();
    expect(container.textContent).not.toContain("Redirecting");
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("names the provider under its button while the desktop app waits for the browser", async () => {
    await render();
    await act(async () => hook.options?.setAwaitingBrowser("github"));

    const statuses = container.querySelectorAll('[role="status"]');
    expect(statuses).toHaveLength(1);
    const handoff = container.querySelector('[data-testid="login-browser-handoff"]');
    expect(handoff).toBe(statuses[0]);
    expect(handoff?.textContent).toBe("Waiting for GitHub in your browser…");
    const github = buttonByText("Continue with GitHub");
    expect(handoff?.parentElement).toBe(github?.parentElement);
    expect(github?.disabled).toBe(false);
  });

  it("marks only the chosen account chip and ignores a second press", async () => {
    window.localStorage.setItem(
      "instafy.rememberedAccounts",
      JSON.stringify([{ email: "dev@example.com", displayName: "Dev", lastUsedAt: 1, provider: "github" }]),
    );
    await render();
    const chip = container.querySelector(
      'button[aria-label="Continue with GitHub as dev@example.com"]',
    ) as HTMLButtonElement;
    expect(chip).not.toBeNull();

    await act(async () => chip.click());
    expect(hook.handleGithubLogin).toHaveBeenCalledTimes(1);
    expect(chip.getAttribute("data-pending")).toBe("true");
    expect(chip.getAttribute("aria-disabled")).toBe("true");
    expect(chip.querySelectorAll(".animate-spin")).toHaveLength(1);

    await act(async () => chip.click());
    expect(hook.handleGithubLogin).toHaveBeenCalledTimes(1);
    const remove = container.querySelector('button[aria-label="Remove dev@example.com"]') as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
  });

  it("spins only the forgot-password control, then announces the outcome", async () => {
    let resolveReset: () => void = () => {};
    auth.sendPasswordResetEmail.mockImplementation(
      () => new Promise<void>((resolve) => { resolveReset = resolve; }),
    );
    await render();
    await typeInto(container.querySelector('input[type="email"]') as HTMLInputElement, "dev@example.com");
    await act(async () => (container.querySelector('button[type="submit"]') as HTMLButtonElement).click());

    const forgot = buttonByText("Forgot password?");
    await act(async () => forgot?.click());

    expect(forgot?.getAttribute("data-pending")).toBe("true");
    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit.getAttribute("data-pending")).toBeNull();
    expect(submit.textContent).toBe("Continue");
    expect(container.querySelectorAll(".animate-spin")).toHaveLength(1);

    await act(async () => resolveReset());
    const message = container.querySelector('[data-testid="login-message"]');
    expect(message?.getAttribute("role")).toBe("status");
    expect(message?.textContent).toContain("Password reset email sent");
    expect(buttonByText("Forgot password?")?.getAttribute("data-pending")).toBeNull();
  });

  it("marks the Google button, not GitHub, when Google is pressed", async () => {
    await render();
    const google = buttonByText("Continue with Google");
    await act(async () => google?.click());

    expect(hook.handleGoogleLogin).toHaveBeenCalledTimes(1);
    expect(google?.getAttribute("data-pending")).toBe("true");
    expect(google?.querySelectorAll(".animate-spin")).toHaveLength(1);
    const github = buttonByText("Continue with GitHub");
    expect(github?.getAttribute("data-pending")).toBeNull();
    expect(github?.disabled).toBe(true);
  });

  it("leaves the other account chips unmarked and dimmed", async () => {
    window.localStorage.setItem(
      "instafy.rememberedAccounts",
      JSON.stringify([
        { email: "dev@example.com", displayName: "Dev", lastUsedAt: 2, provider: "github" },
        { email: "ops@example.com", displayName: "Ops", lastUsedAt: 1, provider: "google" },
      ]),
    );
    await render();
    const devChip = container.querySelector(
      'button[aria-label="Continue with GitHub as dev@example.com"]',
    ) as HTMLButtonElement;
    const opsChip = container.querySelector(
      'button[aria-label="Continue with Google as ops@example.com"]',
    ) as HTMLButtonElement;

    await act(async () => opsChip.click());

    expect(hook.handleGoogleLogin).toHaveBeenCalledTimes(1);
    expect(opsChip.getAttribute("data-pending")).toBe("true");
    expect(opsChip.querySelectorAll(".animate-spin")).toHaveLength(1);
    expect(devChip.getAttribute("data-pending")).toBeNull();
    expect(devChip.getAttribute("data-disabled")).toBe("true");
    expect(devChip.querySelector(".animate-spin")).toBeNull();

    await act(async () => devChip.click());
    expect(hook.handleGithubLogin).not.toHaveBeenCalled();
  });

  it("shows the desktop browser wait on the account chooser and drops it on leaving", async () => {
    window.localStorage.setItem(
      "instafy.rememberedAccounts",
      JSON.stringify([{ email: "dev@example.com", displayName: "Dev", lastUsedAt: 1, provider: "github" }]),
    );
    await render();
    await act(async () => hook.options?.setAwaitingBrowser("github"));
    expect(container.querySelector('[data-testid="login-browser-handoff"]')?.textContent)
      .toBe("Waiting for GitHub in your browser…");

    await act(async () => buttonByText("Log in to another account")?.click());

    expect(container.querySelector('input[type="email"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="login-browser-handoff"]')).toBeNull();
  });

  it("signs in with a password once even if the form is submitted again while pending", async () => {
    auth.signInWithPassword.mockImplementation(() => new Promise<void>(() => {}));
    await render();
    await typeInto(container.querySelector('input[type="email"]') as HTMLInputElement, "dev@example.com");
    await act(async () => (container.querySelector('button[type="submit"]') as HTMLButtonElement).click());
    await typeInto(container.querySelector("#password") as HTMLInputElement, "correct horse");
    const form = (container.querySelector("#password") as HTMLInputElement).form as HTMLFormElement;

    // A pending submit button is no longer the form's default button, so Enter
    // in the single password field submits again; the handler must refuse.
    await act(async () => form.requestSubmit());
    await act(async () => form.requestSubmit());

    expect(auth.signInWithPassword).toHaveBeenCalledTimes(1);
    const cont = buttonByText("Continue");
    expect(cont?.getAttribute("data-pending")).toBe("true");
    expect(container.querySelectorAll(".animate-spin")).toHaveLength(1);
  });

  it("marks each email-code control while it runs and verifies a code once", async () => {
    let resolveSend: () => void = () => {};
    auth.sendEmailOtp.mockImplementation(() => new Promise<void>((resolve) => { resolveSend = resolve; }));
    auth.verifyEmailOtp.mockImplementation(() => new Promise<void>(() => {}));
    await render();
    await typeInto(container.querySelector('input[type="email"]') as HTMLInputElement, "dev@example.com");
    await act(async () => (container.querySelector('button[type="submit"]') as HTMLButtonElement).click());

    const emailCode = buttonByText("Email me a code instead");
    await act(async () => emailCode?.click());
    expect(emailCode?.getAttribute("data-pending")).toBe("true");
    expect(buttonByText("Continue")?.disabled).toBe(true);
    await act(async () => resolveSend());

    const resend = buttonByText("Resend email");
    await act(async () => resend?.click());
    expect(resend?.getAttribute("data-pending")).toBe("true");
    await act(async () => resolveSend());
    const message = container.querySelector('[data-testid="login-message"]');
    expect(message?.getAttribute("role")).toBe("status");
    expect(message?.textContent).toContain("Resent the verification email.");

    await typeInto(container.querySelector("#otp") as HTMLInputElement, "123456");
    const form = (container.querySelector("#otp") as HTMLInputElement).form as HTMLFormElement;
    await act(async () => form.requestSubmit());
    await act(async () => form.requestSubmit());
    expect(auth.verifyEmailOtp).toHaveBeenCalledTimes(1);
    expect(buttonByText("Continue")?.getAttribute("data-pending")).toBe("true");
  });

  it("updates a recovered password once and spins only Update password", async () => {
    auth.updatePassword.mockImplementation(() => new Promise<void>(() => {}));
    await render("/login?type=recovery");
    await typeInto(container.querySelector("#password") as HTMLInputElement, "new password 1");
    await typeInto(container.querySelector("#passwordConfirm") as HTMLInputElement, "new password 1");
    const form = (container.querySelector("#password") as HTMLInputElement).form as HTMLFormElement;

    await act(async () => form.requestSubmit());
    await act(async () => form.requestSubmit());

    expect(auth.updatePassword).toHaveBeenCalledTimes(1);
    const update = buttonByText("Update password");
    expect(update?.getAttribute("data-pending")).toBe("true");
    expect(container.querySelectorAll(".animate-spin")).toHaveLength(1);
    expect(container.querySelector('[data-testid="login-message"]')).toBeNull();
  });

  it("announces errors as alerts", async () => {
    await render();
    await act(async () => hook.options?.setError("GitHub login is not available."));
    const error = container.querySelector('[data-testid="login-error"]');
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.textContent).toContain("GitHub login is not available.");
  });
});
