import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Key, Upload } from "iconoir-react";
import { Button } from "../../../components/Button";
import { Input } from "../../../components/Input";
import { Spinner } from "../../../components/Spinner";
import { Text } from "../../../components/Text";
import { controllerClient } from "../../../sdk/instafy";
import { useStatus } from "../../../status/useStatus";
import { openExternalUrl } from "../../../utils/openExternalUrl";
import {
  canUseDesktopCodexAuthJson,
  connectDesktopCodexAuthJson,
  shouldPromptForCodexAuthJsonUpload,
  useDesktopCodexAuthJsonStatus,
} from "./desktopCodexAuthJson";
import { formatProxyUpstreamErrorSummary } from "./proxyError";

interface CredentialConnectPanelProps {
  hasDefaultCredential: boolean;
  onConnected?: () => void;
  onOpenSettings?: () => void;
  onClose?: () => void;
}

const {
  cancelDeviceAuth,
  createCodex: createCodexCredential,
  getDeviceAuthStatus,
  list: listMyCredentials,
  setDefault: setDefaultCredential,
  startDeviceAuth,
  test: testMyCredential,
} = controllerClient.credentials;

function summarizeCredentialVerificationFailure(error: string | null | undefined): string {
  const normalized = typeof error === "string" ? error.trim() : "";
  const summary = normalized ? formatProxyUpstreamErrorSummary(normalized) : null;
  if (summary) {
    return summary;
  }
  if (normalized.length > 0) {
    return normalized;
  }
  return "Credential connected, but verification failed. Reconnect and retry.";
}

export function CredentialConnectPanel({
  hasDefaultCredential,
  onConnected,
  onOpenSettings,
  onClose,
}: CredentialConnectPanelProps) {
  const { showStatus } = useStatus();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const canUseDesktopConnect = canUseDesktopCodexAuthJson();
  const desktopCodexAuthJsonStatus = useDesktopCodexAuthJsonStatus(canUseDesktopConnect);
  const shouldPromptForAuthJsonUpload = shouldPromptForCodexAuthJsonUpload(
    desktopCodexAuthJsonStatus,
  );

  const [busy, setBusy] = useState(false);
  const [apiKeyMode, setApiKeyMode] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [deviceAuthSession, setDeviceAuthSession] = useState<{
    sessionId: string;
    verificationUrl: string;
    userCode: string;
    expiresAt: string;
    pollIntervalSeconds: number;
    status: "pending" | "completed" | "failed" | "cancelled";
    error?: string | null;
  } | null>(null);
  const [deviceAuthError, setDeviceAuthError] = useState<string | null>(null);
  const deviceAuthPollingRef = useRef(false);

  const shouldMakeDefault = useMemo(() => !hasDefaultCredential, [hasDefaultCredential]);

  const handleConnectDesktop = useCallback(async () => {
    if (!canUseDesktopConnect) {
      showStatus("Desktop connect is only available in the Instafy desktop app.", "info", 4500);
      return;
    }
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      const result = await connectDesktopCodexAuthJson({
        label: "Codex on this computer",
        makeDefault: shouldMakeDefault,
      });
      if (!result.success) {
        throw new Error(result.error ?? "Unable to save credentials.");
      }
      showStatus("Credentials connected.", "success", 3500);
      onConnected?.();
      onClose?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showStatus(message, "error", 5000);
    } finally {
      setBusy(false);
    }
  }, [busy, canUseDesktopConnect, onClose, onConnected, shouldMakeDefault, showStatus]);

  const beginDeviceAuth = useCallback(async () => {
    if (busy) {
      return;
    }
    setApiKeyMode(false);
    setApiKeyDraft("");
    setShowAdvanced(false);
    setDeviceAuthError(null);
    setDeviceAuthSession(null);

    const result = await startDeviceAuth("codex");
    if (!result.success) {
      setDeviceAuthError(result.error ?? "Unable to start device login.");
      return;
    }
    if (!result.sessionId || !result.verificationUrl || !result.userCode) {
      setDeviceAuthError("Device login response missing session details.");
      return;
    }
    setDeviceAuthSession({
      sessionId: result.sessionId,
      verificationUrl: result.verificationUrl,
      userCode: result.userCode,
      expiresAt: result.expiresAt ?? "",
      pollIntervalSeconds: result.pollIntervalSeconds ?? 10,
      status: "pending",
      error: null,
    });
  }, [busy]);

  const cancelDeviceAuthSession = useCallback(async () => {
    if (!deviceAuthSession) {
      setDeviceAuthError(null);
      return;
    }
    setDeviceAuthError(null);
    await cancelDeviceAuth(deviceAuthSession.sessionId).catch(() => null);
    setDeviceAuthSession(null);
  }, [deviceAuthSession]);

  useEffect(() => {
    if (!deviceAuthSession) {
      return;
    }
    if (deviceAuthSession.status !== "pending") {
      return;
    }
    if (deviceAuthPollingRef.current) {
      return;
    }

    const pollMs = Math.max(3000, Math.min(10000, deviceAuthSession.pollIntervalSeconds * 1000));
    let cancelled = false;
    let pollInFlight = false;
    deviceAuthPollingRef.current = true;

    const pollOnce = async () => {
      if (cancelled || pollInFlight) {
        return;
      }
      pollInFlight = true;
      try {
        const result = await getDeviceAuthStatus(deviceAuthSession.sessionId).catch(() => null);
        if (!result || !result.success) {
          return;
        }
        if (cancelled) {
          return;
        }
        if (result.status === "completed") {
          let credentialId = typeof result.credentialId === "string" ? result.credentialId.trim() : "";
          if (!credentialId) {
            const credentialsResult = await listMyCredentials().catch(() => null);
            if (!credentialsResult || !credentialsResult.success) {
              const message = summarizeCredentialVerificationFailure(credentialsResult?.error ?? null);
              setDeviceAuthError(message);
              setDeviceAuthSession((prev) => (prev ? { ...prev, status: "failed", error: message } : prev));
              return;
            }
            const activeDefault = credentialsResult.credentials.find(
              (credential) =>
                !credential.revokedAt &&
                credential.isDefault &&
                (credential.kind === "codex_auth_json" || credential.kind === "openai_api_key"),
            );
            credentialId = activeDefault?.id?.trim() ?? "";
          }

          if (credentialId) {
            const testResult = await testMyCredential(credentialId).catch(() => null);
            if (cancelled) {
              return;
            }
            if (!testResult || !testResult.success || testResult.ok === false) {
              const message = summarizeCredentialVerificationFailure(testResult?.error ?? null);
              setDeviceAuthError(message);
              setDeviceAuthSession((prev) => (prev ? { ...prev, status: "failed", error: message } : prev));
              return;
            }

            if (shouldMakeDefault) {
              const setDefaultResult = await setDefaultCredential(credentialId).catch(() => null);
              if (cancelled) {
                return;
              }
              if (!setDefaultResult || !setDefaultResult.success) {
                const message = summarizeCredentialVerificationFailure(
                  setDefaultResult?.error ?? "Unable to set the newly connected credential as default.",
                );
                setDeviceAuthError(message);
                setDeviceAuthSession((prev) => (prev ? { ...prev, status: "failed", error: message } : prev));
                return;
              }
            }
          }

          setDeviceAuthError(null);
          setDeviceAuthSession((prev) => (prev ? { ...prev, status: "completed", error: null } : prev));
          showStatus("Credentials connected.", "success", 3500);
          onConnected?.();
          onClose?.();
          return;
        }
        if (result.status === "failed") {
          setDeviceAuthSession((prev) =>
            prev ? { ...prev, status: "failed", error: result.error ?? "Device login failed." } : prev,
          );
          return;
        }
        if (result.status === "cancelled") {
          setDeviceAuthSession(null);
        }
      } finally {
        pollInFlight = false;
      }
    };

    void pollOnce();
    const intervalId = window.setInterval(() => void pollOnce(), pollMs);

    return () => {
      cancelled = true;
      deviceAuthPollingRef.current = false;
      window.clearInterval(intervalId);
    };
  }, [deviceAuthSession, onClose, onConnected, shouldMakeDefault, showStatus]);

  const handleTriggerUpload = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleUploadFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0] ?? null;
      event.target.value = "";
      if (!file) {
        return;
      }
      if (busy) {
        return;
      }
      setBusy(true);
      try {
        const raw = await file.text();
        const parsed = JSON.parse(raw) as unknown;
        const result = await createCodexCredential({
          authJson: parsed,
          label: "auth.json",
          makeDefault: shouldMakeDefault,
        });
        if (!result.success) {
          throw new Error(result.error ?? "Unable to save credentials.");
        }
        showStatus("Credentials connected.", "success", 3500);
        onConnected?.();
        onClose?.();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        showStatus(`Upload failed: ${message}`, "error", 5000);
      } finally {
        setBusy(false);
      }
    },
    [busy, onClose, onConnected, shouldMakeDefault, showStatus],
  );

  const handleSaveApiKey = useCallback(async () => {
    const apiKey = apiKeyDraft.trim();
    if (!apiKey || busy) {
      return;
    }
    setBusy(true);
    try {
      const result = await createCodexCredential({
        authJson: { OPENAI_API_KEY: apiKey },
        label: "API key",
        makeDefault: shouldMakeDefault,
      });
      if (!result.success) {
        throw new Error(result.error ?? "Unable to save credentials.");
      }
      showStatus("Credentials connected.", "success", 3500);
      onConnected?.();
      onClose?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showStatus(`Save failed: ${message}`, "error", 5000);
    } finally {
      setBusy(false);
    }
  }, [apiKeyDraft, busy, onClose, onConnected, shouldMakeDefault, showStatus]);

  const showDeviceAuthConnect = !canUseDesktopConnect;

  return (
    <div className="space-y-2 rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm dark:border-slate-800 dark:bg-slate-900/40">
      <div className="flex items-center justify-between gap-2">
        <Text as="div" variant="bodyStrong" tone="inherit" className="text-xs">
          Connect a credential
        </Text>
        {onClose ? (
          <Button onPress={onClose} variant="ghost" size="xs" radius="full" isDisabled={busy}>
            Close
          </Button>
        ) : null}
      </div>

      {deviceAuthError ? (
        <Text as="div" variant="caption" tone="muted" className="text-xs text-rose-600 dark:text-rose-300">
          {deviceAuthError}
        </Text>
      ) : null}

      {deviceAuthSession ? (
        <div className="space-y-2">
          <Text as="div" variant="caption" tone="muted" className="text-xs">
            Open the login page and enter this one‑time code:
          </Text>
          <Text as="div" variant="caption" tone="muted" className="text-xs">
            You&apos;ll connect whichever ChatGPT account you sign into (email doesn&apos;t need to match Instafy). Codex access
            typically requires ChatGPT Plus/Team.
          </Text>
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded-lg bg-white px-2 py-1 text-xs font-semibold tracking-wide text-slate-800 dark:bg-slate-950 dark:text-slate-100">
              {deviceAuthSession.userCode}
            </code>
            <Button
              onPress={() => {
                try {
                  void navigator.clipboard?.writeText(deviceAuthSession.userCode);
                } catch {
                  // ignore
                }
              }}
              variant="outline"
              size="xs"
              radius="full"
              isDisabled={busy}
            >
              Copy
            </Button>
            <Button
              onPress={() => void openExternalUrl(deviceAuthSession.verificationUrl)}
              variant="primary"
              size="xs"
              radius="full"
              isDisabled={busy}
            >
              Open login
            </Button>
            <Button
              onPress={cancelDeviceAuthSession}
              variant="ghost"
              size="xs"
              radius="full"
              isDisabled={busy}
            >
              Cancel
            </Button>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-300">
            {deviceAuthSession.status === "pending" ? (
              <>
                <Spinner aria-hidden="true" tone="slate" size="xs" />
                <span>Waiting for you to finish login…</span>
              </>
            ) : deviceAuthSession.status === "completed" ? (
              <>
                <Spinner aria-hidden="true" tone="primary" size="xs" />
                <span>Connected — syncing credentials…</span>
              </>
            ) : deviceAuthSession.status === "failed" ? (
              <span className="text-rose-600 dark:text-rose-400">
                {deviceAuthSession.error ?? "Device login failed."}
              </span>
            ) : null}
          </div>
          {deviceAuthSession.status === "failed" ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button onPress={beginDeviceAuth} variant="primary" size="xs" radius="full" isDisabled={busy}>
                Try again
              </Button>
              <Button onPress={cancelDeviceAuthSession} variant="ghost" size="xs" radius="full" isDisabled={busy}>
                Back
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {canUseDesktopConnect ? (
            <Button
              onPress={shouldPromptForAuthJsonUpload ? handleTriggerUpload : handleConnectDesktop}
              variant="primary"
              size="xs"
              radius="full"
              isDisabled={busy}
            >
              {shouldPromptForAuthJsonUpload ? "Choose auth.json" : "Use local Codex login"}
            </Button>
          ) : null}
          {showDeviceAuthConnect ? (
            <Button onPress={beginDeviceAuth} variant="primary" size="xs" radius="full" isDisabled={busy}>
              Connect with ChatGPT
            </Button>
          ) : null}

          <Button
            onPress={() => setApiKeyMode((value) => !value)}
            variant="ghost"
            size="xs"
            radius="full"
            isDisabled={busy}
          >
            <Key className="h-4 w-4" aria-hidden="true" />
            API key
          </Button>
          {onOpenSettings ? (
            <Button onPress={onOpenSettings} variant="ghost" size="xs" radius="full" isDisabled={busy}>
              Settings
            </Button>
          ) : null}
          <Button
            onPress={() => setShowAdvanced((value) => !value)}
            variant="ghost"
            size="xs"
            radius="full"
            isDisabled={busy}
          >
            {showAdvanced ? "Hide options" : "More options"}
          </Button>
        </div>
      )}

      {!deviceAuthSession && showAdvanced ? (
        <div className="space-y-2">
          {canUseDesktopConnect ? (
            <Text as="div" variant="caption" tone="muted" className="text-xs">
              {desktopCodexAuthJsonStatus?.exists
                ? "Found ~/.codex/auth.json."
                : shouldPromptForAuthJsonUpload
                  ? "No default Codex auth.json found on this computer."
                  : "Desktop will use this computer's local Codex login."}
            </Text>
          ) : null}
          <Button onPress={handleTriggerUpload} variant="outline" size="xs" radius="full" isDisabled={busy}>
            <Upload className="h-4 w-4" aria-hidden="true" />
            Upload auth.json (advanced)
          </Button>
        </div>
      ) : null}

      {apiKeyMode && !deviceAuthSession ? (
        <div className="space-y-2">
          <Input
            value={apiKeyDraft}
            onChange={(event) => setApiKeyDraft(event.target.value)}
            placeholder="sk-…"
            size="sm"
            radius="xl"
            disabled={busy}
          />
          <div className="flex items-center justify-end gap-2">
            <Button
              onPress={() => {
                setApiKeyMode(false);
                setApiKeyDraft("");
              }}
              variant="ghost"
              size="xs"
              radius="full"
              isDisabled={busy}
            >
              Cancel
            </Button>
            <Button
              onPress={() => void handleSaveApiKey()}
              variant="primary"
              size="xs"
              radius="full"
              isDisabled={busy || apiKeyDraft.trim().length === 0}
            >
              Save key
            </Button>
          </div>
          <Text as="div" variant="caption" tone="muted" className="text-xs">
            Saved to your Instafy profile (not stored in the browser).
          </Text>
        </div>
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={handleUploadFile}
      />
    </div>
  );
}
