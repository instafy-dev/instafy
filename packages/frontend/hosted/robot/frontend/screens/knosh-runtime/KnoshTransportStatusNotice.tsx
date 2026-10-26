import {
  DEFAULT_RUNTIME_ROBOT_BACKEND,
  DEFAULT_RUNTIME_ROBOT_TARGET,
} from "../../robot/runtimeDefaults";
import type { RobotRuntimeStatusValue } from "../../robot";
import { Link } from "react-router-dom";
import { KNOSH_ROBOT_LAB_ENABLED } from "../../developmentFlags";

const TRANSPORT_ERROR_PATTERN =
  /connection refused|econnrefused|timed out|timeout|unreachable|failed to connect|could not connect|reset by peer|network is unreachable/i;

type KnoshTransportAlert = {
  backend: string;
  target: string | null;
  detail: string;
  hint: string;
};

function normalizeTransportError(error: unknown): string | null {
  if (typeof error === "string") {
    const trimmed = error.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (error && typeof error === "object") {
    const serialized = JSON.stringify(error);
    return serialized.trim().length > 0 ? serialized : null;
  }
  return null;
}

function resolveTransportBackend(status: RobotRuntimeStatusValue | null) {
  const configuredTransportBackend =
    typeof status?.transport?.adapter_transport_backend === "string"
      ? status.transport.adapter_transport_backend.trim()
      : "";
  const configuredRuntimeBackend =
    typeof status?.configured_runtime_backend_id === "string"
      ? status.configured_runtime_backend_id.trim()
      : "";
  const preferredRuntimeBackend =
    typeof status?.preferred_runtime_backend_id === "string"
      ? status.preferred_runtime_backend_id.trim()
      : "";
  return (
    configuredTransportBackend ||
    configuredRuntimeBackend ||
    preferredRuntimeBackend ||
    DEFAULT_RUNTIME_ROBOT_BACKEND
  );
}

function resolveTransportTarget(status: RobotRuntimeStatusValue | null, backend: string) {
  const configuredTarget =
    typeof status?.transport?.tcp_target === "string" ? status.transport.tcp_target.trim() : "";
  if (configuredTarget) {
    return configuredTarget;
  }
  return backend === DEFAULT_RUNTIME_ROBOT_BACKEND ? DEFAULT_RUNTIME_ROBOT_TARGET : null;
}

export function resolveKnoshTransportAlert(options: {
  providerRuntimeStatus: RobotRuntimeStatusValue | null;
  runtimeError?: string | null;
  actionError?: string | null;
}): KnoshTransportAlert | null {
  const { providerRuntimeStatus } = options;
  const backend = resolveTransportBackend(providerRuntimeStatus);
  const target = resolveTransportTarget(providerRuntimeStatus, backend);
  const probeError = normalizeTransportError(providerRuntimeStatus?.status_probe?.error);
  const fallbackError =
    normalizeTransportError(options.runtimeError) ??
    normalizeTransportError(options.actionError);
  const detail = probeError ?? fallbackError;
  const transportConfigured =
    providerRuntimeStatus?.transport?.configured === true ||
    backend.length > 0 ||
    Boolean(target);

  if (!detail || !transportConfigured) {
    return null;
  }

  const detailLooksTransportRelated =
    probeError !== null ||
    TRANSPORT_ERROR_PATTERN.test(detail) ||
    detail.includes(backend) ||
    (target ? detail.includes(target) : false);

  if (!detailLooksTransportRelated) {
    return null;
  }

  return {
    backend,
    target,
    detail,
    hint: KNOSH_ROBOT_LAB_ENABLED
      ? backend === DEFAULT_RUNTIME_ROBOT_BACKEND && target === DEFAULT_RUNTIME_ROBOT_TARGET
        ? "Start the local robot transport or switch the backend in Robot Lab."
        : "Reconnect the mounted robot transport or switch the backend in Robot Lab."
      : "Reconnect the mounted robot transport and verify its configured backend.",
  };
}

export function KnoshTransportStatusNotice(props: {
  providerRuntimeStatus: RobotRuntimeStatusValue | null;
  runtimeError?: string | null;
  actionError?: string | null;
  projectId?: string | null;
}) {
  const alert = resolveKnoshTransportAlert(props);
  if (!alert) {
    return null;
  }
  const search = new URLSearchParams();
  if (props.projectId?.trim()) {
    search.set("projectId", props.projectId.trim());
  }
  search.set("backend", alert.backend);
  if (alert.target?.trim()) {
    search.set("tcpTarget", alert.target.trim());
  }
  const robotLabHref = `/robot-lab?${search.toString()}`;

  return (
    <div
      className="rounded-2xl border border-amber-300/25 bg-amber-300/10 p-4"
      data-testid="knosh-runtime-transport-alert"
    >
      <div className="text-xxs uppercase tracking-[0.24em] text-amber-100/75">
        Robot transport
      </div>
      <h3
        className="mt-2 text-lg font-semibold text-amber-50"
        data-testid="knosh-runtime-transport-alert-title"
      >
        Robot transport offline
      </h3>
      <p
        className="mt-2 text-sm text-amber-50/90"
        data-testid="knosh-runtime-transport-alert-detail"
      >
        {alert.detail}
      </p>
      <div className="mt-3 flex flex-wrap gap-2 text-xs text-amber-50/90">
        <span
          className="rounded-full border border-amber-200/20 bg-black/15 px-3 py-1"
          data-testid="knosh-runtime-transport-backend"
        >
          Backend {alert.backend}
        </span>
        {alert.target ? (
          <span
            className="rounded-full border border-amber-200/20 bg-black/15 px-3 py-1"
            data-testid="knosh-runtime-transport-target"
          >
            Target {alert.target}
          </span>
        ) : null}
      </div>
      <p className="mt-3 text-sm text-amber-100/85" data-testid="knosh-runtime-transport-hint">
        {alert.hint}
      </p>
      {KNOSH_ROBOT_LAB_ENABLED ? (
        <div className="mt-4">
          <Link
            to={robotLabHref}
            className="inline-flex rounded-full border border-amber-200/25 bg-black/15 px-4 py-2 text-xs font-medium text-amber-50 transition hover:border-amber-100/40 hover:bg-black/20"
            data-testid="knosh-runtime-transport-open-robot-lab"
          >
            Open in Robot Lab
          </Link>
        </div>
      ) : null}
    </div>
  );
}
