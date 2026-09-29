// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  OAUTH_REDIRECT_TARGET_KEY: "instafy.oauth.redirectTarget",
  OAUTH_PROVIDER_LABELS: { github: "GitHub", google: "Google" },
  useNativeGithubAuth: () => ({
    handleGithubLogin: vi.fn(),
    handleGoogleLogin: vi.fn(),
    resetNativeAuthState: vi.fn(),
  }),
}));
vi.mock("../landing/LandingTentacleScene", () => ({ TentacleBackdrop: () => null }));

function Destination() {
  const location = useLocation();
  return <p data-testid="destination">{location.pathname}{location.search}</p>;
}

const friendlyCredentialsError =
  "That email and password don't match. New here, or no password yet? We'll email you a code.";

describe("LoginPage sign-up and password alternatives", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = async () => {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/login?redirect=%2Fstudio%3FprojectId%3Dproject-1"]}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/studio" element={<Destination />} />
          </Routes>
        </MemoryRouter>,
      );
    });
  };
  const button = (text: string) => {
    const found = [...container.querySelectorAll("button")].find((el) => el.textContent?.trim() === text);
    if (!found) throw new Error(`Missing button: ${text}`);
    return found;
  };
  const click = async (text: string) => { await act(async () => button(text).click()); };
  const type = async (id: string, value: string) => {
    const input = container.querySelector(`#${id}`) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const enterSignupEmail = async () => {
    await click("Create account");
    expect(container.querySelector("h1")?.textContent).toBe("Create your account");
    expect(document.activeElement).toBe(container.querySelector("#email"));
    await type("email", "New.User@example.com");
  };
  const enterPassword = async () => {
    await type("email", "user@example.com");
    await click("Continue");
    await type("password", "some password");
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetAllMocks();
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

  it.each([false, true])("Create account skips password with remembered accounts=%s", async (remembered) => {
    if (remembered) {
      localStorage.setItem("instafy.rememberedAccounts", JSON.stringify([
        { email: "returning@example.com", displayName: "Returning", provider: "email", lastUsedAt: Date.now() },
      ]));
    }
    await render();
    await enterSignupEmail();
    await click("Send verification code");
    expect(auth.sendEmailOtp).toHaveBeenCalledExactlyOnceWith("new.user@example.com");
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
    expect(container.querySelector("#password")).toBeNull();
    expect(container.querySelector("h1")?.textContent).toBe("Check your inbox");
    expect(document.activeElement).toBe(container.querySelector("#otp"));
    expect(container.textContent).not.toContain("Continue with password");
  });

  it("sends once on repeated Enter and keeps the pressed button pending", async () => {
    let resolveSend: () => void = () => {};
    auth.sendEmailOtp.mockImplementation(() => new Promise<void>((resolve) => { resolveSend = resolve; }));
    await render();
    await enterSignupEmail();
    const form = (container.querySelector("#email") as HTMLInputElement).form!;
    await act(async () => { form.requestSubmit(); form.requestSubmit(); });
    expect(auth.sendEmailOtp).toHaveBeenCalledTimes(1);
    expect(button("Send verification code").getAttribute("data-pending")).toBe("true");
    expect(button("Already have an account? Log in").disabled).toBe(true);
    expect(button("Continue with GitHub").disabled).toBe(true);
    expect(container.querySelectorAll(".animate-spin")).toHaveLength(1);
    await act(async () => resolveSend());
    expect(container.querySelector("#otp")).not.toBeNull();
  });

  it("stays in sign-up after a send failure, and allows retrying and editing email", async () => {
    auth.sendEmailOtp.mockRejectedValueOnce(new Error("Unable to send code."));
    await render();
    await enterSignupEmail();
    await click("Send verification code");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Unable to send code.");
    expect(container.querySelector("h1")?.textContent).toBe("Create your account");
    expect(button("Send verification code").disabled).toBe(false);
    await click("Send verification code");
    await click("Use a different email");
    expect(container.querySelector("h1")?.textContent).toBe("Create your account");
    await type("email", "corrected@example.com");
    await click("Send verification code");
    expect(auth.sendEmailOtp).toHaveBeenLastCalledWith("corrected@example.com");
    await click("Resend email");
    expect(auth.sendEmailOtp).toHaveBeenLastCalledWith("corrected@example.com");
  });

  it.each(["123456", "12345678"])("verifies a %s code and preserves the destination", async (code) => {
    await render();
    await enterSignupEmail();
    await click("Send verification code");
    expect(container.querySelector("#otp")?.hasAttribute("maxlength")).toBe(false);
    await type("otp", code);
    await click("Continue");
    expect(auth.verifyEmailOtp).toHaveBeenCalledExactlyOnceWith("new.user@example.com", code);
    expect(container.querySelector("h1")?.textContent).toBe("Set a password");
    expect(container.querySelector('[data-testid="destination"]')).toBeNull();
    await click("Skip for now");
    expect(container.querySelector('[data-testid="destination"]')?.textContent).toBe("/studio?projectId=project-1");
    expect(JSON.parse(localStorage.getItem("instafy.rememberedAccounts")!)[0].email).toBe("new.user@example.com");
    expect(auth.updatePassword).not.toHaveBeenCalled();
  });

  const verifySignup = async () => {
    auth.verifyEmailOtp.mockImplementation(async () => {
      auth.user = { id: "new-user", email: "new.user@example.com", user_metadata: {} };
    });
    await render();
    await enterSignupEmail();
    await click("Send verification code");
    await type("otp", "12345678");
    await click("Continue");
  };

  it("holds a session published before verification resolves, then offers password setup", async () => {
    sessionStorage.setItem("instafy.oauth.redirectTarget", "/studio?projectId=older-project");
    let resolveVerify: () => void = () => {};
    auth.verifyEmailOtp.mockImplementation(() => new Promise<void>((resolve) => { resolveVerify = resolve; }));
    await render();
    await enterSignupEmail();
    await click("Send verification code");
    await type("otp", "12345678");
    await click("Continue");
    auth.user = { id: "new-user", email: "new.user@example.com", user_metadata: {} };
    await render();
    expect(container.querySelector('[data-testid="destination"]')).toBeNull();
    expect(container.querySelector("#otp")).not.toBeNull();
    await act(async () => resolveVerify());
    expect(container.querySelector("h1")?.textContent).toBe("Set a password");
    expect(document.activeElement).toBe(container.querySelector("#password"));
    await render();
    expect(container.querySelector('[data-testid="destination"]')).toBeNull();
    expect(sessionStorage.getItem("instafy.oauth.redirectTarget")).not.toBeNull();
    await click("Skip for now");
    expect(sessionStorage.getItem("instafy.oauth.redirectTarget")).toBeNull();
    expect(auth.updatePassword).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="destination"]')?.textContent).toBe("/studio?projectId=project-1");
  });

  it("saves once, blocks skipping while pending, and then continues to the original destination", async () => {
    sessionStorage.setItem("instafy.oauth.redirectTarget", "/studio?projectId=older-project");
    let resolveUpdate: () => void = () => {};
    auth.updatePassword.mockImplementation(() => new Promise<void>((resolve) => { resolveUpdate = resolve; }));
    await verifySignup();
    expect(container.textContent).not.toContain("Continue as guest");
    expect(container.querySelector("#password")?.getAttribute("autocomplete")).toBe("new-password");
    await type("password", "new password 1");
    await type("passwordConfirm", "new password 1");
    const form = (container.querySelector("#password") as HTMLInputElement).form!;
    await act(async () => { form.requestSubmit(); form.requestSubmit(); });
    expect(auth.updatePassword).toHaveBeenCalledExactlyOnceWith("new password 1");
    expect(button("Save password").getAttribute("data-pending")).toBe("true");
    expect(button("Skip for now").disabled).toBe(true);
    expect(container.querySelector('[data-testid="destination"]')).toBeNull();
    await act(async () => resolveUpdate());
    expect(sessionStorage.getItem("instafy.oauth.redirectTarget")).toBeNull();
    expect(container.querySelector('[data-testid="destination"]')?.textContent).toBe("/studio?projectId=project-1");
  });

  it.each([
    ["short", "short", "Use at least 8 characters."],
    ["new password 1", "different password", "Passwords do not match."],
  ])("validates password setup before updating (%s)", async (password, confirmation, message) => {
    await verifySignup();
    await type("password", password);
    await type("passwordConfirm", confirmation);
    await click("Save password");
    expect(auth.updatePassword).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(container.querySelector('[role="alert"]')?.closest("form")).not.toBeNull();
    expect(container.querySelector('[data-testid="destination"]')).toBeNull();
  });

  it.each(["retry", "skip"])("keeps password setup usable after a failed save: %s", async (next) => {
    auth.updatePassword.mockRejectedValueOnce(new Error("{}"));
    await verifySignup();
    await type("password", "new password 1");
    await type("passwordConfirm", "new password 1");
    await click("Save password");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Unable to save password right now. Try again.");
    expect(container.querySelector("h1")?.textContent).toBe("Set a password");
    expect(button("Skip for now").disabled).toBe(false);
    await click(next === "retry" ? "Save password" : "Skip for now");
    expect(auth.updatePassword).toHaveBeenCalledTimes(next === "retry" ? 2 : 1);
    expect(container.querySelector('[data-testid="destination"]')).not.toBeNull();
  });

  it.each([
    ["weak_password", "Choose a stronger password."],
    ["same_password", "Choose a different password from your current one."],
  ])("explains the password policy error %s", async (code, message) => {
    auth.updatePassword.mockRejectedValue({ code, message: "Server detail" });
    await verifySignup();
    await type("password", "new password 1");
    await type("passwordConfirm", "new password 1");
    await click("Save password");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(container.querySelector('[data-testid="destination"]')).toBeNull();
  });

  it("does not update a password if the verified session has ended", async () => {
    await verifySignup();
    auth.user = null;
    await render();
    await type("password", "new password 1");
    await type("passwordConfirm", "new password 1");
    await click("Save password");
    expect(auth.updatePassword).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Your session ended");
  });

  it("keeps existing email-code login free of the signup password step", async () => {
    await render();
    await enterPassword();
    await click("Email me a code instead");
    await type("otp", "12345678");
    await click("Continue");
    expect(container.querySelector('[data-testid="destination"]')).not.toBeNull();
    expect(auth.updatePassword).not.toHaveBeenCalled();
  });

  it("keeps verification errors on the code step for retry", async () => {
    auth.verifyEmailOtp.mockRejectedValueOnce(new Error("Code expired. Request a new one."));
    await render();
    await enterSignupEmail();
    await click("Send verification code");
    await type("otp", "12345678");
    await click("Continue");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Code expired");
    expect(container.querySelector('[data-testid="destination"]')).toBeNull();
    await click("Resend email");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect((container.querySelector("#otp") as HTMLInputElement).value).toBe("");
  });

  it("can switch back to the existing password login path", async () => {
    await render();
    await enterSignupEmail();
    await click("Already have an account? Log in");
    await enterPassword();
    await click("Continue");
    expect(auth.signInWithPassword).toHaveBeenCalledExactlyOnceWith("user@example.com", "some password");
    expect(auth.sendEmailOtp).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="destination"]')).not.toBeNull();
  });

  it.each([
    { code: "invalid_credentials", message: "Server wording can change" },
    new Error("Invalid login credentials"),
  ])("uses account-neutral copy for invalid credentials: %s", async (error) => {
    auth.signInWithPassword.mockRejectedValue(error);
    await render();
    await enterPassword();
    await click("Continue");
    const alert = container.querySelector('[data-testid="login-error"]');
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent).toBe(friendlyCredentialsError);
    expect(alert?.closest("form")).not.toBeNull();
    // The code alternative takes primary visual weight after a mismatch.
    expect(button("Email me a code instead").className).toContain("bg-primary-600");
    expect(button("Continue").className).not.toContain("bg-primary-600");
    await click("Email me a code instead");
    expect(auth.sendEmailOtp).toHaveBeenCalledExactlyOnceWith("user@example.com");
    expect(container.querySelector("#otp")).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("does not expose other provider errors or misclassify an explicit error code", async () => {
    auth.signInWithPassword.mockRejectedValue({ code: "unexpected_failure", message: "Invalid login credentials" });
    await render();
    await enterPassword();
    await click("Continue");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Unable to sign in right now. Try again.");
    expect(button("Continue").className).toContain("bg-primary-600");
  });
});
