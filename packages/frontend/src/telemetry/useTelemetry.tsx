import { useCallback } from "react";
import { useStatus, type StatusIntent } from "../status/useStatus";
import type { ControllerEventPayload } from "../sdk/instafy";

export function useTelemetry() {
  const { showStatus } = useStatus();

  const handleRuntimeTelemetryEvent = useCallback(
    (event: ControllerEventPayload) => {
      if (!event || typeof event !== "object") {
        return;
      }
      const kind = typeof event.kind === "string" ? event.kind.trim() : "";
      if (!kind) {
        return;
      }

      const data = (event.data ?? {}) as Record<string, unknown>;
      const runtimeId =
        typeof data.runtimeId === "string" && data.runtimeId.trim().length > 0 ? data.runtimeId : null;
      const runtimeLabel = runtimeId ? `runtime ${runtimeId}` : "the runtime";

      if (kind === "runtime.dev_isolation") {
        const action = typeof data.action === "string" ? data.action.trim() : "";
        if (import.meta.env.DEV) {
          console.info("[telemetry] dev isolation event", {
            action,
            payload: data
          });
        }
        return;
      }

      let message: string | null = null;
      let intent: StatusIntent = "info";

      if (kind === "runtime.login") {
        return;
      } else if (kind === "telemetry.error" || kind === "telemetry.warning") {
        const message = typeof data.message === "string" ? data.message.trim() : "";
        if (!message) {
          return;
        }
        if (isTransientAutomationNodeLookupWarning(message)) {
          return;
        }
        if (shouldSurfaceChatTelemetryAsToast()) {
          const level = typeof data.level === "string" ? data.level.trim().toLowerCase() : "";
          const isError = kind === "telemetry.error" || level === "error";
          showStatus(message, isError ? "error" : "warning", 6000);
        } else if (import.meta.env.DEV) {
          console.info("[telemetry] suppressed chat toast", { kind, message });
        }
        return;
      } else if (kind === "runtime.strict_mode") {
        const action = typeof data.action === "string" ? data.action : "";
        switch (action) {
          case "missing_runtime_scope":
            message = `Strict mode blocked ${runtimeLabel}: agent token was missing runtime scope.`;
            intent = "error";
            break;
          case "runtime_override_rejected": {
            const requested = typeof data.requestedRuntimeId === "string" ? data.requestedRuntimeId : null;
            const tokenRuntime = typeof data.tokenRuntimeId === "string" ? data.tokenRuntimeId : null;
            message = `Strict mode rejected runtime override${requested ? ` (${requested})` : ""}${
              tokenRuntime ? `; token scoped to ${tokenRuntime}.` : "."
            }`;
            intent = "error";
            break;
          }
          case "max_jobs_clamped": {
            const requested = typeof data.requested === "number" ? data.requested : Number(data.requested ?? NaN);
            const effective = typeof data.effective === "number" ? data.effective : Number(data.effective ?? NaN);
            const requestedText = Number.isFinite(requested) ? `requested ${requested}` : "requested";
            const effectiveText = Number.isFinite(effective) ? `${effective}` : "1";
            message = `Strict mode limited concurrent jobs (${requestedText} -> ${effectiveText}).`;
            break;
          }
          case "cross_project_jobs_detected": {
            const queuedGlobal =
              typeof data.queuedGlobal === "number" ? data.queuedGlobal : Number(data.queuedGlobal ?? NaN);
            message = `Strict mode spotted queued jobs for other projects${
              Number.isFinite(queuedGlobal) ? ` (${queuedGlobal} total)` : ""
            }.`;
            intent = "error";
            break;
          }
          case "heartbeat_rejected":
            message = `Strict mode rejected a heartbeat from ${runtimeLabel}.`;
            intent = "error";
            break;
          case "completion_rejected":
            message = `Strict mode rejected a job completion from ${runtimeLabel}.`;
            intent = "error";
            break;
          default:
            if (action) {
              message = `Strict mode event: ${action}.`;
            }
            break;
        }
      } else if (kind === "runtime.unavailable") {
        const reason =
          typeof data.reason === "string" && data.reason.trim().length > 0 ? data.reason.trim() : "";
        if (reason === "runtime_not_ready") {
          return;
        }
        const providedMessageRaw =
          typeof data.message === "string" && data.message.trim().length > 0
            ? data.message.trim()
            : null;
        const providedMessage =
          providedMessageRaw && looksLikeRuntimeAvailabilityDebugMessage(providedMessageRaw)
            ? null
            : providedMessageRaw;
        const detail =
          typeof data.detail === "string" && data.detail.trim().length > 0 ? data.detail.trim() : null;

        if (reason === "runtime_not_ready" && !providedMessage) {
          return;
        }

        if (reason === "no_runtime_connected") {
          message =
            providedMessage ??
            "No runtime is connected. Start or reconnect a runtime from Runtime & AI to process queued jobs.";
          intent = "error";
        } else {
          message =
            providedMessage ??
            "Unable to verify runtime availability. Check the controller logs and ensure the runtime agent is running.";
          intent = "warning";
        }
        if (detail && shouldIncludeTelemetryDetails() && !message.includes(detail)) {
          message = `${message} (${detail})`;
        }
      }

      if (message) {
        showStatus(message, intent, 6000);
      }
    },
    [showStatus]
  );

  return { handleRuntimeTelemetryEvent };
}

function looksLikeRuntimeAvailabilityDebugMessage(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.includes("status=") && normalized.includes("lastseen=");
}

function shouldIncludeTelemetryDetails(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem("instafy:chatInternals") === "1";
  } catch (_error) {
    return false;
  }
}

function isTransientAutomationNodeLookupWarning(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes("node cannot be found in the current page") ||
    normalized.includes("node is detached from document")
  );
}

function shouldSurfaceChatTelemetryAsToast(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem("instafy.telemetry.toast") === "1";
  } catch (_error) {
    return false;
  }
}
