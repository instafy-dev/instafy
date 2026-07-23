import { Copy } from "iconoir-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { IconButton } from "../components/Button";
import { Heading } from "../components/Heading";
import { Text } from "../components/Text";
import { useAuth } from "../providers/AuthProvider";
import { supabaseAnonKey, supabaseUrl } from "../lib/supabaseClient";

function maskToken(token: string): string {
  if (token.length <= 12) {
    return "•".repeat(Math.max(6, token.length));
  }
  return `${token.slice(0, 6)}…${token.slice(-6)}`;
}

function buildCallbackCandidates(primary: URL): URL[] {
  const candidates = new Map<string, URL>();
  const normalizedPrimary = new URL(primary.toString());
  normalizedPrimary.hash = "";
  candidates.set(normalizedPrimary.toString(), normalizedPrimary);

  const hosts = ["127.0.0.1", "localhost", "::1"] as const;
  for (const host of hosts) {
    if (host === normalizedPrimary.hostname.toLowerCase()) {
      continue;
    }
    const next = new URL(normalizedPrimary.toString());
    next.hostname = host;
    candidates.set(next.toString(), next);
  }

  return Array.from(candidates.values());
}

function normalizeCliCallbackUrl(raw: string | null): URL | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:") {
      return null;
    }
    const host = parsed.hostname.toLowerCase();
    const allowedHosts = new Set(["127.0.0.1", "localhost", "::1"]);
    if (!allowedHosts.has(host)) {
      return null;
    }
    if (parsed.pathname !== "/callback") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function CliLoginPage() {
  const auth = useAuth();
  const session = auth.session;
  const location = useLocation();
  const token = session?.access_token ?? "";
  const refreshToken = session?.refresh_token ?? "";
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [callbackState, setCallbackState] = useState<
    "idle" | "sending" | "sent" | "failed"
  >("idle");
  const [callbackError, setCallbackError] = useState<string | null>(null);
  const callbackTimeoutMs = 4000;

  const serverUrl = useMemo(() => {
    try {
      const params = new URLSearchParams(location.search);
      const raw = params.get("serverUrl");
      return raw && raw.trim().length > 0 ? raw.trim() : null;
    } catch (_error) {
      return null;
    }
  }, [location.search]);

  const cliCallbackUrl = useMemo(() => {
    try {
      const params = new URLSearchParams(location.search);
      return normalizeCliCallbackUrl(params.get("cliCallbackUrl"));
    } catch (_error) {
      return null;
    }
  }, [location.search]);

  const cliState = useMemo(() => {
    try {
      const params = new URLSearchParams(location.search);
      const raw = params.get("cliState");
      return raw && raw.trim().length > 0 ? raw.trim() : null;
    } catch (_error) {
      return null;
    }
  }, [location.search]);

  const displayToken = useMemo(() => {
    if (!token) {
      return "";
    }
    return copyState === "error" ? token : maskToken(token);
  }, [token, copyState]);

  const handleCopy = async () => {
    if (!token) {
      return;
    }
    try {
      await navigator.clipboard.writeText(token);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1500);
    } catch {
      setCopyState("error");
      window.setTimeout(() => setCopyState("idle"), 2000);
    }
  };

  const copyLabel = copyState === "copied" ? "Copied" : copyState === "error" ? "Copy failed" : "Copy";

  useEffect(() => {
    if (!token || !cliCallbackUrl || !cliState || callbackState !== "idle") {
      return;
    }

    let cancelled = false;
    setCallbackState("sending");
    setCallbackError(null);

    const sendToken = async () => {
      try {
        const params = new URLSearchParams({ token, state: cliState });
        if (refreshToken) {
          params.set("refreshToken", refreshToken);
        }
        if (supabaseUrl) {
          params.set("supabaseUrl", supabaseUrl);
        }
        if (supabaseAnonKey) {
          params.set("supabaseAnonKey", supabaseAnonKey);
        }
        const body = params.toString();

        const candidates = buildCallbackCandidates(cliCallbackUrl);
        const perAttemptTimeoutMs = Math.max(1500, Math.floor(callbackTimeoutMs / candidates.length));
        let lastResponseText = "";
        let lastError: unknown = null;

        for (const candidate of candidates) {
          const controller = new AbortController();
          const timeout = window.setTimeout(() => controller.abort(), perAttemptTimeoutMs);
          try {
            const response = await fetch(candidate.toString(), {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body,
              signal: controller.signal
            });

            if (cancelled) {
              return;
            }

            if (!response.ok) {
              lastResponseText = await response.text().catch(() => "");
              continue;
            }

            setCallbackState("sent");
            return;
          } catch (error) {
            lastError = error;
            continue;
          } finally {
            window.clearTimeout(timeout);
          }
        }

        if (lastError) {
          throw lastError;
        }

        setCallbackError(lastResponseText || "Could not connect to the CLI callback. Copy the token into your terminal instead.");
        setCallbackState("failed");
      } catch (error) {
        if (cancelled) {
          return;
        }
        const message = (() => {
          if (error instanceof DOMException && error.name === "AbortError") {
            return "Timed out connecting to the CLI callback. Copy the token into your terminal instead.";
          }
          const raw = error instanceof Error ? error.message : String(error);
          if (!raw) {
            return "Could not connect to the CLI callback. Copy the token into your terminal instead.";
          }
          return `Could not connect to the CLI callback. This is often caused by ad blockers/privacy tools blocking localhost requests. Copy the token into your terminal instead. (${raw})`;
        })();
        setCallbackError(message);
        setCallbackState("failed");
      }
    };

    void sendToken();

    return () => {
      cancelled = true;
    };
  }, [token, refreshToken, cliCallbackUrl, cliState, callbackState, callbackTimeoutMs]);

  const isCliCallbackFlow = Boolean(cliCallbackUrl && cliState);
  const callbackStatus =
    isCliCallbackFlow && callbackState === "sending"
      ? "Connecting to the CLI…"
      : isCliCallbackFlow && callbackState === "sent"
        ? "Connected — you may close this page."
        : isCliCallbackFlow && callbackState === "failed"
          ? "Could not connect to the CLI. Copy the token instead."
          : null;

  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-[#ffffff] via-white to-[#efefef] text-slate-900 dark:bg-none dark:bg-slate-950 dark:text-slate-100">
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-6 py-20">
        <div className="rounded-[28px] border border-slate-200 bg-white/90 p-6 shadow-card-lg dark:border-slate-800 dark:bg-slate-950/60 dark:shadow-modal md:p-8">
          <Heading level={1} variant="section" className="tracking-tight">
            Signed in to Instafy
          </Heading>

          {callbackStatus ? (
            <Text variant="lead" tone="secondary" className="mt-4">
              {callbackStatus}
            </Text>
          ) : (
            <Text variant="lead" tone="secondary" className="mt-4">
              Return to your terminal — the CLI should continue automatically.
            </Text>
          )}

          {callbackError ? (
            <Text variant="caption" tone="muted" className="mt-2">
              {callbackError}
            </Text>
          ) : null}

          {serverUrl ? (
            <Text variant="caption" tone="muted" className="mt-2">
              Server: <span className="font-semibold">{serverUrl}</span>
            </Text>
          ) : null}

          {!token ? (
            <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
              No active session token found. Try signing out and back in.
            </div>
          ) : (
            <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-950 p-4 shadow-inner shadow-slate-900/20 dark:border-slate-800">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <Text variant="caption" tone="inverse" className="text-slate-200">
                    Token
                  </Text>
                  <code className="mt-2 block break-all text-xs font-semibold text-slate-100">
                    {displayToken}
                  </code>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <IconButton
                    onPress={handleCopy}
                    variant="primary"
                    size="xs"
                    radius="full"
                    aria-label="Copy token"
                    title={copyLabel}
                  >
                    <Copy className="h-4 w-4" aria-hidden="true" />
                  </IconButton>
                </div>
              </div>

              {copyState !== "idle" ? (
                <Text variant="caption" tone="inverse" className="mt-3 text-slate-200">
                  {copyLabel}
                </Text>
              ) : null}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
