import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  controllerClient,
  type DeviceAuthProvider,
} from "../../../../sdk/instafy";

export type DeviceAuthSession = {
  sessionId: string;
  verificationUrl: string;
  userCode: string;
  expiresAt: string;
  pollIntervalSeconds: number;
  status: "pending" | "completed" | "failed" | "cancelled";
  error?: string | null;
};

export type DeviceAuthFlowBeginOptions = {
  provider: DeviceAuthProvider;
  label?: string | null;
};

export type DeviceAuthFlowCompletionResult =
  | void
  | { success?: true; warning?: string | null }
  | { success: false; error?: string | null };

export function useDeviceAuthFlow({
  onCompleted,
  onCancelled,
}: {
  onCompleted?: (input: {
    provider: DeviceAuthProvider;
    sessionId: string;
    credentialId?: string | null;
  }) => Promise<DeviceAuthFlowCompletionResult> | DeviceAuthFlowCompletionResult;
  onCancelled?: () => void;
} = {}) {
  const [provider, setProvider] = useState<DeviceAuthProvider | null>(null);
  const [session, setSession] = useState<DeviceAuthSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [completionWarning, setCompletionWarning] = useState<string | null>(null);
  const pollingRef = useRef(false);
  const beginGenerationRef = useRef(0);
  const statusFailureCountRef = useRef(0);
  const onCompletedRef = useRef(onCompleted);
  const onCancelledRef = useRef(onCancelled);
  onCompletedRef.current = onCompleted;
  onCancelledRef.current = onCancelled;

  useEffect(() => {
    return () => {
      beginGenerationRef.current += 1;
    };
  }, []);

  const begin = useCallback(
    async (options: DeviceAuthFlowBeginOptions) => {
      if (busy) {
        return;
      }
      const generation = beginGenerationRef.current + 1;
      beginGenerationRef.current = generation;
      setBusy(true);
      setCompleting(false);
      setCompletionWarning(null);
      setProvider(options.provider);
      setError(null);
      setSession(null);
      statusFailureCountRef.current = 0;
      try {
        const result = await controllerClient.credentials.startDeviceAuth(options.provider);
        if (beginGenerationRef.current !== generation) {
          return;
        }
        if (!result.success) {
          setError(result.error ?? "Unable to start device login.");
          return;
        }
        if (!result.sessionId || !result.verificationUrl || !result.userCode) {
          setError("Device login response missing session details.");
          return;
        }
        setSession({
          sessionId: result.sessionId,
          verificationUrl: result.verificationUrl,
          userCode: result.userCode,
          expiresAt: result.expiresAt ?? "",
          pollIntervalSeconds: result.pollIntervalSeconds ?? 10,
          status: "pending",
          error: null,
        });
      } finally {
        if (beginGenerationRef.current === generation) {
          setBusy(false);
        }
      }
    },
    [busy],
  );

  const cancel = useCallback(async () => {
    if (busy) {
      return;
    }
    const generation = beginGenerationRef.current + 1;
    beginGenerationRef.current = generation;
    setCompleting(false);
    setCompletionWarning(null);
    if (!session) {
      setError(null);
      setProvider(null);
      return;
    }
    setBusy(true);
    try {
      setError(null);
      statusFailureCountRef.current = 0;
      await controllerClient.credentials.cancelDeviceAuth(session.sessionId).catch(() => null);
      if (beginGenerationRef.current !== generation) {
        return;
      }
      setSession(null);
      setProvider(null);
      onCancelledRef.current?.();
    } finally {
      if (beginGenerationRef.current === generation) {
        setBusy(false);
      }
    }
  }, [busy, session]);

  const reset = useCallback(() => {
    beginGenerationRef.current += 1;
    setBusy(false);
    setCompleting(false);
    setCompletionWarning(null);
    setError(null);
    setSession(null);
    setProvider(null);
    statusFailureCountRef.current = 0;
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const hydrate = useCallback(
    (input: { provider?: DeviceAuthProvider | null; session?: DeviceAuthSession | null; error?: string | null }) => {
      beginGenerationRef.current += 1;
      setBusy(false);
      setCompleting(false);
      setCompletionWarning(null);
      setProvider(input.provider ?? null);
      setSession(input.session ?? null);
      setError(input.error ?? null);
      statusFailureCountRef.current = 0;
    },
    [],
  );

  const pollMs = useMemo(() => {
    if (!session) {
      return null;
    }
    const interval = session.pollIntervalSeconds > 0 ? session.pollIntervalSeconds : 10;
    return Math.max(3000, Math.min(10000, interval * 1000));
  }, [session]);

  useEffect(() => {
    if (!session) {
      return;
    }
    if (session.status !== "pending") {
      return;
    }
    if (pollingRef.current) {
      return;
    }
    if (typeof window === "undefined") {
      return;
    }

    const currentProvider = provider;
    const sessionId = session.sessionId;
    const resolvedPollMs = pollMs ?? 5000;
    const generation = beginGenerationRef.current;

    let cancelled = false;
    let pollInFlight = false;
    pollingRef.current = true;
    const isStale = () => cancelled || beginGenerationRef.current !== generation;

    const pollOnce = async () => {
      if (isStale() || pollInFlight) {
        return;
      }

      const expiresAtMs = Date.parse(session.expiresAt);
      if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
        const message = "Device login timed out. Generate a new code and try again.";
        setError(message);
        setSession((prev) => (prev ? { ...prev, status: "failed", error: message } : prev));
        return;
      }

      pollInFlight = true;
      try {
        const result = await controllerClient.credentials.getDeviceAuthStatus(sessionId).catch(() => null);
        if (isStale()) {
          return;
        }
        if (!result || !result.success) {
          statusFailureCountRef.current += 1;
          const resultError = result?.error?.trim() ?? "";
          const sessionEnded = resultError.toLowerCase().includes("not found");
          if (sessionEnded || statusFailureCountRef.current >= 3) {
            const message = sessionEnded
              ? "This device login session ended. Generate a new code and try again."
              : resultError || "Instafy lost contact with the device login. Check your connection and try again.";
            setError(message);
            setSession((prev) => (prev ? { ...prev, status: "failed", error: message } : prev));
          }
          return;
        }
        statusFailureCountRef.current = 0;
        if (result.status === "completed") {
          const completionProvider = currentProvider ?? "codex";
          setCompleting(true);
          try {
            let warning: string | null = null;
            const completionHandler = onCompletedRef.current;
            if (completionHandler) {
              const completion = await completionHandler({
                provider: completionProvider,
                sessionId,
                credentialId: typeof result.credentialId === "string" ? result.credentialId : null,
              });
              if (isStale()) {
                return;
              }
              if (completion && typeof completion === "object" && "success" in completion && completion.success === false) {
                const message = completion.error ?? "Device login succeeded, but Instafy could not finish connecting.";
                setError(message);
                setSession((prev) => (prev ? { ...prev, status: "failed", error: message } : prev));
                return;
              }
              warning =
                completion && typeof completion === "object" && "warning" in completion
                  ? completion.warning?.trim() || null
                  : null;
            }
            if (isStale()) {
              return;
            }
            setCompletionWarning(warning);
            setError(null);
            setSession((prev) => (prev ? { ...prev, status: "completed", error: null } : prev));
          } catch (completionError) {
            if (isStale()) {
              return;
            }
            const message =
              completionError instanceof Error ? completionError.message : String(completionError);
            setError(message);
            setSession((prev) => (prev ? { ...prev, status: "failed", error: message } : prev));
          } finally {
            if (!isStale()) {
              setCompleting(false);
            }
          }
          return;
        }
        if (result.status === "failed") {
          const message = result.error ?? "Device login failed.";
          setError(message);
          setSession((prev) => (prev ? { ...prev, status: "failed", error: message } : prev));
          return;
        }
        if (result.status === "cancelled") {
          setError(null);
          setSession(null);
          setProvider(null);
          onCancelledRef.current?.();
        }
      } finally {
        pollInFlight = false;
      }
    };

    void pollOnce();
    const intervalId = window.setInterval(() => void pollOnce(), resolvedPollMs);

    return () => {
      cancelled = true;
      pollingRef.current = false;
      window.clearInterval(intervalId);
    };
  }, [pollMs, provider, session]);

  return {
    provider,
    session,
    error,
    busy,
    completing,
    completionWarning,
    begin,
    cancel,
    reset,
    clearError,
    hydrate,
  };
}
