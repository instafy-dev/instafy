import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { Capacitor } from "@capacitor/core";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { LoginPage } from "../../../src/screens/LoginPage";
import { NativeStatusBarBackground } from "../../../src/native/NativeStatusBarBackground";
import "../../../src/styles/tailwind.css";

const params = new URLSearchParams(location.search);
// Only the platform flag is inert; no native plugin is called by this review.
Capacitor.isNativePlatform = () => params.get("native") !== "0";
Capacitor.getPlatform = () => Capacitor.isNativePlatform() ? "android" : "web";
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const longFailure = "We could not send your verification email. Check the address and try again. If the problem continues, contact your administrator with this reference: verification-email-delivery-reference-0123456789abcdefghijklmnopqrstuvwxyz.";
type Failure = "none" | "password" | "send" | "verify" | "update";
type AuthState = {
  loading: boolean;
  user: { id: string; email: string; user_metadata: Record<string, unknown> } | null;
  sendEmailOtp: (email: string) => Promise<void>;
  verifyEmailOtp: (email: string, code: string) => Promise<void>;
  signInWithPassword: (email: string, password: string) => Promise<void>;
  sendPasswordResetEmail: (email: string) => Promise<void>;
  updatePassword: (password: string) => Promise<void>;
  signInAnonymously: () => Promise<void>;
};
declare global {
  interface Window {
    __loginKeyboardReview: {
      auth: AuthState;
      listeners: Set<() => void>;
      hooks: { useSyncExternalStore: typeof useSyncExternalStore };
      failure: Failure;
      calls: Record<"send" | "verify" | "password" | "reset" | "update", number>;
      setFailure: (failure: Failure) => void;
      setVisualViewport?: (height: number, offsetTop?: number, width?: number) => void;
    };
  }
}
const listeners = new Set<() => void>();
const calls = { send: 0, verify: 0, password: 0, reset: 0, update: 0 };
const inertUser = { id: "login-layout-user", email: "review@example.test", user_metadata: {} };
const publishUser = () => {
  review.auth = { ...review.auth, user: inertUser };
  for (const listener of listeners) listener();
};
const auth: AuthState = {
  loading: false, user: null,
  sendEmailOtp: async () => { calls.send++; if (review.failure === "send") throw new Error(longFailure); },
  verifyEmailOtp: async () => { calls.verify++; if (review.failure === "verify") throw new Error("The verification code has expired. Request a new email and try again."); publishUser(); },
  signInWithPassword: async () => { calls.password++; if (review.failure === "password") throw { code: "invalid_credentials" }; publishUser(); },
  sendPasswordResetEmail: async () => { calls.reset++; },
  updatePassword: async () => { calls.update++; if (review.failure === "update") throw { code: "weak_password" }; },
  signInAnonymously: async () => {},
};
const review: Window["__loginKeyboardReview"] = {
  auth, listeners, calls, hooks: { useSyncExternalStore }, failure: "none", setFailure: (failure) => { review.failure = failure; },
};
window.__loginKeyboardReview = review;
const recovery = params.get("surface") === "recovery";
createRoot(document.getElementById("root")!).render(<><NativeStatusBarBackground /><MemoryRouter initialEntries={[recovery ? "/login?type=recovery" : "/login"]}>
  <Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route path="/studio" element={<p data-testid="login-destination">Signed in to the inert review workspace.</p>} />
  </Routes>
</MemoryRouter></>);
