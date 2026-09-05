import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { useLocation, useNavigate } from "react-router-dom";
import { Eye, EyeClosed, NavArrowLeft, Xmark } from "iconoir-react";
import { Button, IconButton } from "../components/Button";
import { Heading } from "../components/Heading";
import { GitHubIcon } from "../components/IntegrationIcons";
import { Input } from "../components/Input";
import { OctoMark } from "../components/OctoMark";
import { EntryLoadingScreen } from "../components/EntryLoadingScreen";
import { Text } from "../components/Text";
import { TextLink } from "../components/TextLink";
import { ToggleIconButton } from "../components/ToggleIconButton";
import { hasSupabaseConfig } from "../lib/supabaseClient";
import { showBackToLanding as computeShowBackToLanding } from "../lib/desktopShell";
import { AppVersionLabel } from "../components/AppVersionLabel";
import { useAuth } from "../providers/AuthProvider";
import { OAUTH_REDIRECT_TARGET_KEY, useNativeGithubAuth } from "./login/useNativeGithubAuth";
import { GoogleIcon } from "../components/IntegrationIcons";
import {
  deriveRememberedAccountProviderFromUser,
  normalizeEmail,
  parseRememberedAccounts,
  removeRememberedAccount,
  type RememberedAccount,
  upsertRememberedAccount,
} from "./login/rememberedAccounts";
import { theme } from "../styles/theme";
import { applyPageMeta } from "../utils/seo";
import { TentacleBackdrop } from "./landing/LandingTentacleScene";

type LoginStep = "chooseAccount" | "email" | "password" | "otp" | "recovery";

const REMEMBERED_ACCOUNTS_KEY = "instafy.rememberedAccounts";

function readLocalStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalStorage(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore storage failures
  }
}

function removeLocalStorage(key: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore storage failures
  }
}

function parseRecoveryMode(hash: string, search: string): boolean {
  const trimmedHash = hash.startsWith("#") ? hash.slice(1) : hash;
  const hashParams = new URLSearchParams(trimmedHash);
  const searchParams = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);

  const mode = (
    hashParams.get("type") ??
    searchParams.get("type") ??
    searchParams.get("mode") ??
    ""
  ).toLowerCase();
  return mode === "recovery";
}

function buildInitials(value: string): string {
  const parts = value
    .trim()
    .split(/\s+/g)
    .filter(Boolean);
  if (parts.length === 0) {
    return "?";
  }
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function readRememberedAccounts(): RememberedAccount[] {
  return parseRememberedAccounts(readLocalStorage(REMEMBERED_ACCOUNTS_KEY));
}

function writeRememberedAccounts(accounts: RememberedAccount[]) {
  if (accounts.length === 0) {
    removeLocalStorage(REMEMBERED_ACCOUNTS_KEY);
    return;
  }
  writeLocalStorage(REMEMBERED_ACCOUNTS_KEY, JSON.stringify(accounts.slice(0, 5)));
}

function OrDivider() {
  return (
    <div className="my-6 flex items-center gap-4 text-xs font-semibold text-slate-500 dark:text-slate-400">
      <div className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
      <span className="tracking-widest">OR</span>
      <div className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
    </div>
  );
}

// Google OAuth ships dark: the button renders only once the provider is
// configured in the Supabase dashboard AND this flag is flipped in the build.
// Rendering it earlier would offer a button whose click can only produce
// "provider is not enabled".
const GOOGLE_AUTH_ENABLED =
  (import.meta.env.VITE_INSTAFY_ENABLE_GOOGLE_AUTH ?? "").trim() === "1";

export function LoginPage() {
  const {
    loading,
    user,
    sendEmailOtp,
    verifyEmailOtp,
    signInWithPassword,
    sendPasswordResetEmail,
    updatePassword,
    signInAnonymously,
  } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const embedMode = useMemo(() => {
    try {
      const params = new URLSearchParams(location.search);
      return (params.get("mode") ?? "").toLowerCase();
    } catch {
      return "";
    }
  }, [location.search]);
  const isExtensionEmbed = embedMode.startsWith("extension");
  const isNativeApp = Capacitor.isNativePlatform();
  const showBackToLanding = computeShowBackToLanding({ isNativeApp, isExtensionEmbed });
  const recoveryMode = useMemo(
    () => parseRecoveryMode(location.hash ?? "", location.search ?? ""),
    [location.hash, location.search],
  );

  const redirectTarget = useMemo(() => {
    try {
      const params = new URLSearchParams(location.search);
      const redirect = params.get("redirect");
      if (redirect && redirect.trim().length > 0) {
        return redirect;
      }
    } catch {
      // ignore malformed URLs
    }
    if (typeof window !== "undefined") {
      try {
        const storedRedirect = window.sessionStorage?.getItem(OAUTH_REDIRECT_TARGET_KEY);
        if (storedRedirect && storedRedirect.trim().length > 0) {
          return storedRedirect;
        }
      } catch {
        // ignore session storage failures
      }
    }
    return "/studio";
  }, [location.search]);

  const [step, setStep] = useState<LoginStep>("email");
  const [accountChooserDismissed, setAccountChooserDismissed] = useState(false);
  const [rememberedAccounts, setRememberedAccounts] = useState<RememberedAccount[]>(() =>
    readRememberedAccounts(),
  );
  const [email, setEmail] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [guestSubmitting, setGuestSubmitting] = useState(false);

  const emailRef = useRef<HTMLInputElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const otpRef = useRef<HTMLInputElement | null>(null);

  const { handleGithubLogin, handleGoogleLogin, resetNativeAuthState } = useNativeGithubAuth({
    redirectTarget,
    setError,
    setMessage,
    setSubmitting,
  });

  const allowGuestSignIn = import.meta.env.DEV && !import.meta.env.PROD;
  const normalizedEmail = normalizeEmail(email);
  const passwordType = passwordVisible ? "text" : "password";

  const shouldSkipInitialEmailAutofocus = useMemo(() => {
    if (typeof window === "undefined") {
      return false;
    }
    if (Capacitor.isNativePlatform()) {
      return true;
    }
    const coarsePointer = window.matchMedia?.("(pointer: coarse)")?.matches ?? false;
    const touchPoints = typeof navigator !== "undefined" && navigator.maxTouchPoints > 0;
    return coarsePointer || touchPoints;
  }, []);

  const stepAutofocusReadyRef = useRef(false);

  const stepTitle = useMemo(() => {
    if (recoveryMode) {
      return "Reset your password";
    }
    if (step === "chooseAccount") {
      return "Log back in";
    }
    if (step === "password") {
      return "Enter your password";
    }
    if (step === "otp") {
      return "Check your inbox";
    }
    return "Log in or sign up";
  }, [recoveryMode, step]);

  const stepDescription = useMemo((): string | null => {
    if (recoveryMode) {
      return "Choose a new password to finish signing in.";
    }
    if (step === "chooseAccount") {
      return "Choose an account to continue.";
    }
    if (step === "otp") {
      return normalizedEmail
        ? `Enter the verification code we just sent to ${normalizedEmail}.`
        : "Enter the verification code we just sent to your email.";
    }
    if (step === "password") {
      return null;
    }
    return "Bring the AI you already pay for and open your projects from any device.";
  }, [normalizedEmail, recoveryMode, step]);

  useEffect(() => {
    applyPageMeta({
      title: recoveryMode ? "Reset Password · Instafy" : "Log In · Instafy",
      description: "Sign in to Instafy and continue working in your project workspace.",
      image: "/og-image.png",
    });
  }, [recoveryMode]);

  useEffect(() => {
    if (!loading && user && !recoveryMode) {
      const nextEmail = user.email?.trim() || normalizedEmail;
      if (nextEmail) {
        setRememberedAccounts((current) => {
          const next = upsertRememberedAccount(
            current,
            nextEmail,
            {
              displayName:
                typeof user.user_metadata?.full_name === "string" ? user.user_metadata.full_name : undefined,
              provider: deriveRememberedAccountProviderFromUser(user),
            },
          );
          writeRememberedAccounts(next);
          return next;
        });
      }
      if (typeof window !== "undefined") {
        try {
          window.sessionStorage?.removeItem(OAUTH_REDIRECT_TARGET_KEY);
        } catch {
          // ignore session storage failures
        }
      }
      navigate(redirectTarget, { replace: true });
    }
  }, [loading, user, navigate, redirectTarget, recoveryMode, normalizedEmail]);

  useEffect(() => {
    if (recoveryMode) {
      setStep("recovery");
      setMessage("Set a new password for your account.");
      setError(null);
      return;
    }
    if (
      rememberedAccounts.length > 0 &&
      !accountChooserDismissed &&
      step === "email" &&
      normalizedEmail.length === 0
    ) {
      setStep("chooseAccount");
    }
  }, [recoveryMode, rememberedAccounts.length, accountChooserDismissed, step, normalizedEmail]);

  useEffect(() => {
    if (loading || (user && !recoveryMode)) {
      return;
    }
    if (step === "email") {
      if (!shouldSkipInitialEmailAutofocus || stepAutofocusReadyRef.current) {
        emailRef.current?.focus();
      }
    }
    if (step === "password") {
      passwordRef.current?.focus();
    }
    if (step === "otp") {
      otpRef.current?.focus();
    }
    stepAutofocusReadyRef.current = true;
  }, [loading, user, recoveryMode, step, shouldSkipInitialEmailAutofocus]);

  const clearTransientState = () => {
    resetNativeAuthState();
    setError(null);
    setMessage(null);
    setSubmitting(false);
  };


  const handleGuestSignIn = async () => {
    clearTransientState();
    setGuestSubmitting(true);
    try {
      await signInAnonymously();
      navigate(redirectTarget, { replace: true });
    } catch (err) {
      const details = err instanceof Error ? err.message : "Unable to sign in as guest.";
      setError(details);
    } finally {
      setGuestSubmitting(false);
    }
  };

  const handleContinueFromEmail = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextEmail = normalizeEmail(email);
    if (!nextEmail) {
      setError("Enter your email address.");
      return;
    }
    clearTransientState();
    setAccountChooserDismissed(true);
    setEmail(nextEmail);
    setPassword("");
    setOtpCode("");
    setStep("password");
  };

  const handleEditEmail = () => {
    clearTransientState();
    setAccountChooserDismissed(true);
    setPassword("");
    setOtpCode("");
    setStep("email");
  };

  const handlePasswordContinue = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextEmail = normalizeEmail(email);
    if (!nextEmail) {
      setError("Enter your email address.");
      return;
    }
    if (!password) {
      setError("Enter your password.");
      return;
    }

    clearTransientState();
    setSubmitting(true);
    try {
      await signInWithPassword(nextEmail, password);
      setRememberedAccounts((current) => {
        const next = upsertRememberedAccount(current, nextEmail, { provider: "email" });
        writeRememberedAccounts(next);
        return next;
      });
      navigate(redirectTarget, { replace: true });
    } catch (err) {
      const details = err instanceof Error ? err.message : "Unable to sign in.";
      setError(details);
    } finally {
      setSubmitting(false);
    }
  };

  const handleStartOtp = async () => {
    const nextEmail = normalizeEmail(email);
    if (!nextEmail) {
      setError("Enter your email address.");
      return;
    }
    clearTransientState();
    setAccountChooserDismissed(true);
    setSubmitting(true);
    try {
      await sendEmailOtp(nextEmail);
      setEmail(nextEmail);
      setOtpCode("");
      setStep("otp");
    } catch (err) {
      const details = err instanceof Error ? err.message : "Unable to send a sign-in code.";
      setError(details);
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerifyOtp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextEmail = normalizeEmail(email);
    if (!nextEmail) {
      setError("Enter your email address.");
      return;
    }
    const token = otpCode.replace(/\s+/g, "");
    if (!token) {
      setError("Enter the sign-in code from your email.");
      return;
    }

    clearTransientState();
    setSubmitting(true);
    try {
      await verifyEmailOtp(nextEmail, token);
      setRememberedAccounts((current) => {
        const next = upsertRememberedAccount(current, nextEmail, { provider: "email" });
        writeRememberedAccounts(next);
        return next;
      });
      navigate(redirectTarget, { replace: true });
    } catch (err) {
      const details = err instanceof Error ? err.message : "Unable to verify code.";
      setError(details);
    } finally {
      setSubmitting(false);
    }
  };

  const handleResendOtp = async () => {
    const nextEmail = normalizeEmail(email);
    if (!nextEmail) {
      return;
    }
    clearTransientState();
    setSubmitting(true);
    try {
      await sendEmailOtp(nextEmail);
      setOtpCode("");
      setMessage("Resent the verification email.");
    } catch (err) {
      const details = err instanceof Error ? err.message : "Unable to resend code.";
      setError(details);
    } finally {
      setSubmitting(false);
    }
  };

  const handleForgotPassword = async () => {
    const nextEmail = normalizeEmail(email);
    if (!nextEmail) {
      setError("Enter your email address first.");
      return;
    }
    clearTransientState();
    setSubmitting(true);
    try {
      await sendPasswordResetEmail(nextEmail);
      setMessage(`Password reset email sent to ${nextEmail}. Open the link to set a new password.`);
    } catch (err) {
      const details = err instanceof Error ? err.message : "Unable to send reset email.";
      setError(details);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRecoveryUpdate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!password) {
      setError("Enter a new password.");
      return;
    }
    if (password.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }
    if (!passwordConfirm) {
      setError("Confirm your new password.");
      return;
    }
    if (password !== passwordConfirm) {
      setError("Passwords do not match.");
      return;
    }
    clearTransientState();
    setSubmitting(true);
    try {
      await updatePassword(password);
      setPassword("");
      setPasswordConfirm("");
      navigate(redirectTarget, { replace: true });
    } catch (err) {
      const details = err instanceof Error ? err.message : "Unable to update password.";
      setError(details);
    } finally {
      setSubmitting(false);
    }
  };

  const touchRememberedAccount = (account: RememberedAccount) => {
    setRememberedAccounts((current) => {
      const next = upsertRememberedAccount(current, account.email, {
        displayName: account.displayName,
        provider: account.provider,
      });
      writeRememberedAccounts(next);
      return next;
    });
  };

  const handleContinueWithPassword = () => {
    clearTransientState();
    setAccountChooserDismissed(true);
    setOtpCode("");
    setStep("password");
  };

  const handleSelectAccount = (account: RememberedAccount) => {
    clearTransientState();
    setAccountChooserDismissed(true);
    setEmail(account.email);
    setPassword("");
    setOtpCode("");
    touchRememberedAccount(account);
    if (account.provider === "github") {
      void handleGithubLogin();
      return;
    }
    if (account.provider === "google") {
      void handleGoogleLogin();
      return;
    }
    setStep("password");
  };

  const handleRemoveAccount = (accountEmail: string) => {
    setRememberedAccounts((current) => {
      const next = removeRememberedAccount(current, accountEmail);
      writeRememberedAccounts(next);
      if (next.length === 0 && step === "chooseAccount") {
        setStep("email");
      }
      return next;
    });
  };

  const handleUseAnotherAccount = () => {
    clearTransientState();
    setAccountChooserDismissed(true);
    setEmail("");
    setPassword("");
    setOtpCode("");
    setStep("email");
  };

  const handleCreateAccount = () => {
    handleUseAnotherAccount();
  };

  const renderForm = () => {
    if (step === "chooseAccount") {
      return (
        <div className="mt-8 space-y-6">
          <div className="space-y-3">
            {rememberedAccounts.map((account) => {
              const initials = buildInitials(account.displayName);
              const isGithubAccount = account.provider === "github";
              const avatarClasses =
                "flex h-12 w-12 items-center justify-center rounded-full bg-primary-600 text-sm font-bold text-white";

              return (
                <div
                  key={account.email}
                  className="flex items-center gap-3 rounded-full border border-slate-200 bg-white px-4 py-3 shadow-sm transition hover:border-slate-300 dark:border-slate-800 dark:bg-slate-950/40 dark:hover:border-slate-700"
                >
                  <button
                    type="button"
                    onClick={() => handleSelectAccount(account)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary-400/40 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-950"
                    aria-label={
                      account.provider === "github"
                        ? `Continue with GitHub as ${account.email}`
                        : account.provider === "google"
                          ? `Continue with Google as ${account.email}`
                          : `Continue with password as ${account.email}`
                    }
                  >
                    <div className="relative shrink-0">
                      <div className={avatarClasses} aria-hidden="true">
                        {initials}
                      </div>
                      {isGithubAccount ? (
                        <span className="absolute -bottom-0.5 -right-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-white bg-slate-900 text-white shadow-sm dark:border-slate-950 dark:bg-white dark:text-slate-900">
                          <GitHubIcon className="h-3 w-3" />
                        </span>
                      ) : account.provider === "google" ? (
                        <span className="absolute -bottom-0.5 -right-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-200 bg-white shadow-sm dark:border-slate-950">
                          <GoogleIcon className="h-3 w-3" />
                        </span>
                      ) : null}
                    </div>
                    {/*
                      Name and email only. The provider is already stated by
                      the badge on the avatar; a pill beside the name and a
                      "Continue with GitHub" line under the email said the same
                      thing twice more, which crowded the chip without adding
                      anything. The badge stays because it is the compact form.
                      The button's aria-label still names the provider, so the
                      affordance survives for anyone who cannot see the badge.
                    */}
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-slate-900 dark:text-slate-50">
                        {account.displayName}
                      </div>
                      <div className="truncate text-xs text-slate-600 dark:text-slate-300">
                        {account.email}
                      </div>
                    </div>
                  </button>
                  <IconButton
                    aria-label={`Remove ${account.email}`}
                    variant="ghost"
                    radius="full"
                    size="sm"
                    onPress={() => handleRemoveAccount(account.email)}
                    className="text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-50"
                  >
                    <Xmark className="h-4 w-4" aria-hidden="true" />
                  </IconButton>
                </div>
              );
            })}
          </div>

          <OrDivider />

          <div className="space-y-3">
            <Button
              variant="outline"
              radius="full"
              size="lg"
              fullWidth
              onPress={handleUseAnotherAccount}
              isDisabled={submitting}
            >
              Log in to another account
            </Button>
            <Button
              variant="outline"
              radius="full"
              size="lg"
              fullWidth
              onPress={handleCreateAccount}
              isDisabled={submitting}
            >
              Create account
            </Button>
          </div>
        </div>
      );
    }

    if (step === "password") {
      return (
        <div className="mt-8 space-y-6">
          <div>
            <Text variant="overline" tone="muted">
              Email address
            </Text>
            <div className="mt-2 flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-3 text-sm dark:border-slate-800 dark:bg-slate-950/40">
              <div className="min-w-0 flex-1 truncate font-medium text-slate-900 dark:text-slate-50">
                {normalizedEmail || "—"}
              </div>
              <Button
                onPress={handleEditEmail}
                variant="ghost"
                size="xs"
                radius="full"
                className="!bg-transparent px-0 py-0 text-xs font-semibold text-primary-600 hover:!bg-transparent hover:text-primary-700 data-[hovered]:!bg-transparent dark:text-primary-300 dark:hover:text-primary-200"
              >
                Edit
              </Button>
            </div>
          </div>

          <form onSubmit={handlePasswordContinue} className="space-y-5">
            <div>
              <Text as="label" htmlFor="password" variant="overline" tone="muted" className="sr-only">
                Password
              </Text>
              <div className="relative mt-2">
                <Input
                  ref={passwordRef}
                  id="password"
                  type={passwordType}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  radius="full"
                  className={`pr-12 ${theme.input} rounded-full`}
                  placeholder="Password"
                  autoComplete="current-password"
                />
                <ToggleIconButton
                  isSelected={passwordVisible}
                  onPress={() => setPasswordVisible((value) => !value)}
                  aria-label={passwordVisible ? "Hide password" : "Show password"}
                  size="sm"
                  radius="full"
                  className="absolute right-2 top-1/2 -translate-y-1/2"
                >
                  {passwordVisible ? (
                    <EyeClosed className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Eye className="h-4 w-4" aria-hidden="true" />
                  )}
                </ToggleIconButton>
              </div>

              <div className="mt-3">
                <Button
                  onPress={handleForgotPassword}
                  isDisabled={submitting}
                  variant="ghost"
                  size="xs"
                  radius="full"
                  className="!bg-transparent px-0 py-0 text-sm font-semibold text-primary-600 hover:!bg-transparent hover:text-primary-700 data-[hovered]:!bg-transparent dark:text-primary-300 dark:hover:text-primary-200"
                >
                  Forgot password?
                </Button>
              </div>
            </div>

            <Button
              type="submit"
              variant="primary"
              size="lg"
              radius="full"
              className="w-full justify-center px-6 py-3 text-sm font-semibold"
              isDisabled={submitting || normalizedEmail.length === 0 || password.length === 0}
            >
              {submitting ? "Working…" : "Continue"}
            </Button>
          </form>

          <OrDivider />

          <div className="space-y-2">
            <Button
              variant="outline"
              radius="full"
              size="lg"
              fullWidth
              onPress={handleStartOtp}
              isDisabled={submitting || normalizedEmail.length === 0}
            >
              Email me a code instead
            </Button>
            <Text variant="caption" tone="muted" className="block text-center">
              No password yet? Get a sign-in code by email — it works whether or not you
              already have an account.
            </Text>
          </div>
        </div>
      );
    }

    if (step === "otp") {
      return (
        <div className="mt-8 space-y-6">
          <form onSubmit={handleVerifyOtp} className="space-y-5">
            <div>
              <Text as="label" htmlFor="otp" variant="bodyStrong" className="sr-only">
                Verification code
              </Text>
              <Input
                ref={otpRef}
                id="otp"
                value={otpCode}
                onChange={(event) => setOtpCode(event.target.value)}
                required
                aria-label="Verification code"
                radius="full"
                className={`${theme.input} min-h-14 rounded-full px-5`}
                placeholder="Enter the code"
                autoComplete="one-time-code"
                inputMode="numeric"
              />
            </div>

            <Button
              type="submit"
              variant="primary"
              size="lg"
              radius="full"
              className="w-full justify-center px-6 py-3 text-sm font-semibold"
              isDisabled={submitting || otpCode.trim().length === 0}
            >
              {submitting ? "Verifying…" : "Continue"}
            </Button>
          </form>

          <Button
            onPress={handleResendOtp}
            isDisabled={submitting}
            variant="ghost"
            size="sm"
            radius="full"
            fullWidth
            className="!bg-transparent text-sm font-semibold text-slate-700 hover:!bg-transparent hover:text-slate-900 dark:text-slate-200 dark:hover:text-slate-50"
          >
            Resend email
          </Button>

          <OrDivider />

          <Button
            variant="outline"
            radius="full"
            size="lg"
            fullWidth
            onPress={handleContinueWithPassword}
            isDisabled={submitting}
          >
            Continue with password
          </Button>
        </div>
      );
    }

    if (step === "recovery") {
      return (
        <div className="mt-8">
          <form onSubmit={handleRecoveryUpdate} className="space-y-5">
            <div>
              <Text as="label" htmlFor="password" variant="overline" tone="muted">
                New password
              </Text>
              <div className="relative mt-2">
                <Input
                  ref={passwordRef}
                  id="password"
                  type={passwordType}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  radius="full"
                  className={`pr-12 ${theme.input} rounded-full`}
                  placeholder="Create a new password"
                  autoComplete="new-password"
                />
                <ToggleIconButton
                  isSelected={passwordVisible}
                  onPress={() => setPasswordVisible((value) => !value)}
                  aria-label={passwordVisible ? "Hide password" : "Show password"}
                  size="sm"
                  radius="full"
                  className="absolute right-2 top-1/2 -translate-y-1/2"
                >
                  {passwordVisible ? (
                    <EyeClosed className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Eye className="h-4 w-4" aria-hidden="true" />
                  )}
                </ToggleIconButton>
              </div>
              <Text variant="caption" tone="muted" className="mt-2">
                Use at least 8 characters.
              </Text>
            </div>

            <div>
              <Text as="label" htmlFor="passwordConfirm" variant="overline" tone="muted">
                Confirm password
              </Text>
              <Input
                id="passwordConfirm"
                type={passwordType}
                value={passwordConfirm}
                onChange={(event) => setPasswordConfirm(event.target.value)}
                required
                radius="full"
                className={`${theme.input} rounded-full`}
                placeholder="Repeat your password"
                autoComplete="new-password"
              />
            </div>

            <Button
              type="submit"
              variant="primary"
              size="lg"
              radius="full"
              className="w-full justify-center px-6 py-3 text-sm font-semibold"
              isDisabled={submitting || password.length === 0 || passwordConfirm.length === 0}
            >
              {submitting ? "Working…" : "Update password"}
            </Button>
          </form>
        </div>
      );
    }

    return (
      <div className="mt-8 space-y-6">
        <div className="space-y-3">
          <Button
            variant="outline"
            radius="full"
            size="lg"
            fullWidth
            onPress={handleGithubLogin}
            isDisabled={submitting || !hasSupabaseConfig || isExtensionEmbed}
          >
            <span className="inline-flex items-center gap-2">
              <GitHubIcon className="h-4 w-4" />
              <span>Continue with GitHub</span>
            </span>
          </Button>
          {GOOGLE_AUTH_ENABLED ? (
            <Button
              variant="outline"
              radius="full"
              size="lg"
              fullWidth
              onPress={handleGoogleLogin}
              isDisabled={submitting || !hasSupabaseConfig || isExtensionEmbed}
            >
              <span className="inline-flex items-center gap-2">
                <GoogleIcon className="h-4 w-4" />
                <span>Continue with Google</span>
              </span>
            </Button>
          ) : null}
        </div>

        <OrDivider />

        <form onSubmit={handleContinueFromEmail} className="space-y-5">
          <div>
            <Text as="label" htmlFor="email" variant="overline" tone="muted" className="sr-only">
              Email address
            </Text>
            <Input
              ref={emailRef}
              id="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              radius="full"
              className={`${theme.input} rounded-full`}
              placeholder="you@example.com"
              autoComplete="email"
            />
          </div>

          <Button
            type="submit"
            variant="primary"
            size="lg"
            radius="full"
            className="w-full justify-center px-6 py-3 text-sm font-semibold"
            isDisabled={submitting || normalizeEmail(email).length === 0}
          >
            Continue
          </Button>
        </form>
      </div>
    );
  };

  const renderBody = () => (
    <div>
      <div className="text-center">
        <OctoMark className="mx-auto mb-5 h-12 w-12 text-brand-ink dark:text-brand-paper" />
        <Heading level={1} variant="section" className="tracking-tight">
          {stepTitle}
        </Heading>
        {stepDescription ? (
          <Text variant="bodyLg" tone="secondary" className="mx-auto mt-4 max-w-sm">
            {stepDescription}
          </Text>
        ) : null}
      </div>
      {renderForm()}
    </div>
  );

  // Keep the sign-in form out of the handoff for an existing session. Password
  // recovery remains available to signed-in users who opened a recovery link.
  if (loading || (user && !recoveryMode)) {
    return <EntryLoadingScreen />;
  }

  return (
    <div
      className="relative isolate min-h-screen min-h-[100dvh] w-full overflow-x-hidden bg-gradient-to-br from-slate-100 via-white to-slate-50 text-slate-900 dark:bg-none dark:bg-[var(--color-studio-dark-canvas)] dark:text-slate-100"
      data-testid="login-page"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 hidden overflow-hidden sm:block"
        data-testid="login-ambient-glow"
      >
        <div className="absolute left-1/2 top-1/2 h-[560px] w-[560px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary-400/10 blur-3xl dark:bg-primary-500/10" />
      </div>

      {!isExtensionEmbed ? (
        // Quiet version of the landing scene: arms frame the edges while the
        // form sits in the artwork's clear center. sm+ widths only, dimmed so
        // the form keeps the focus. Extension embeds stay plain; the web and
        // desktop-shell surfaces both get the scene in both themes.
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-0 hidden overflow-hidden opacity-70 sm:block"
        >
          <TentacleBackdrop fadeBottom={false} />
        </div>
      ) : null}

      <div
        className={[
          "relative z-10 mx-auto flex min-h-screen min-h-[100dvh] w-full max-w-2xl flex-col items-center px-4 sm:px-6",
          "justify-start py-6",
          isExtensionEmbed ? "" : "sm:justify-center sm:py-16",
          "[@media(max-height:740px)]:justify-start [@media(max-height:740px)]:py-6",
        ].join(" ")}
      >
        <div className="relative w-full max-w-[340px] sm:max-w-[400px]">
          <section
            className={[
              "w-full p-0",
              // The card carves a bounded region out of an unbounded canvas.
              // The desktop shell used to skip it because a plain window was
              // already that region, but the tentacle backdrop reintroduced
              // the unbounded canvas there, so every backdrop surface gets
              // the card again. Extension embeds are narrow, plain panels and
              // never reach the sm: card styles.
              "sm:rounded-[32px] sm:border sm:border-white/70 sm:bg-white/90 sm:shadow-[0_18px_60px_rgba(15,23,42,0.12)] sm:dark:border-slate-800/80 sm:dark:bg-slate-950/70 sm:dark:shadow-[0_18px_60px_rgba(0,0,0,0.5)]",
              isExtensionEmbed ? "sm:p-6" : "sm:p-8 sm:[@media(max-height:740px)]:p-6",
            ].join(" ")}
          >
            {showBackToLanding || allowGuestSignIn ? (
              <div
                className={[
                  "flex items-center gap-3",
                  showBackToLanding && allowGuestSignIn
                    ? "justify-between"
                    : showBackToLanding
                      ? "justify-start"
                      : "justify-end",
                ].join(" ")}
              >
                {showBackToLanding ? (
                  <TextLink
                    to="/"
                    aria-label="Back to landing"
                    underline={false}
                    className="inline-flex items-center gap-1.5 rounded-full px-2 py-2 text-sm font-semibold text-slate-600 transition hover:bg-slate-100/80 hover:text-slate-900 dark:text-slate-200 dark:hover:bg-slate-800/40 dark:hover:text-slate-50"
                  >
                    <NavArrowLeft className="h-5 w-5" aria-hidden="true" />
                    <span>Back</span>
                  </TextLink>
                ) : null}

                {allowGuestSignIn ? (
                  <Button
                    onPress={handleGuestSignIn}
                    isDisabled={guestSubmitting}
                    variant="ghost"
                    size="sm"
                    radius="full"
                    className={`${theme.button.secondary} justify-center`}
                  >
                    {guestSubmitting ? "Signing in…" : "Continue as guest"}
                  </Button>
                ) : null}
              </div>
            ) : null}

            <div className="mt-6">
              {renderBody()}

              {message ? (
                <div data-testid="login-message" className={`mt-6 ${theme.alert.success}`}>
                  {message}
                </div>
              ) : null}
              {error ? (
                <div data-testid="login-error" className={`mt-6 ${theme.alert.error}`}>
                  {error}
                </div>
              ) : null}

              {!recoveryMode ? (
                <div className="mt-10 flex items-center justify-center gap-3 text-xs text-slate-500 dark:text-slate-400">
                  <TextLink to="/terms" size="xs" tone="muted" target="_blank" rel="noreferrer">
                    Terms of Use
                  </TextLink>
                  <span className="text-slate-300 dark:text-slate-600">|</span>
                  <TextLink to="/privacy" size="xs" tone="muted" target="_blank" rel="noreferrer">
                    Privacy Policy
                  </TextLink>
                </div>
              ) : null}

              {!recoveryMode ? (
                <div className="mt-3 flex items-center justify-center text-[11px] text-slate-400 dark:text-slate-500">
                  <AppVersionLabel />
                </div>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
