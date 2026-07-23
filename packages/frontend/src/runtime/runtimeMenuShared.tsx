import type { RuntimeMenuOption } from "./useRuntimeMenu";
import type { ControllerTunnelGrant } from "../sdk/instafy";
import type { RuntimeStatusState } from "./runtimeLabels";
import { Spinner } from "../components/Spinner";

export const RUNTIME_BADGE_CLASSES: Record<"neutral" | "warning" | "danger", string> = {
  neutral: "bg-slate-100 text-slate-600",
  warning: "bg-secondary-100 text-secondary-700",
  danger: "bg-rose-100 text-rose-700",
};

export function tunnelGrantIsActive(
  grant: ControllerTunnelGrant | null | undefined,
): boolean {
  if (!grant) {
    return false;
  }
  const normalized = (grant.status ?? "").trim().toLowerCase();
  return !["revoked", "expired", "failed"].includes(normalized);
}

export function resolveTunnelHostname(grant: ControllerTunnelGrant | null | undefined): string | null {
  if (!grant) {
    return null;
  }
  const direct = grant.hostname?.trim();
  if (direct) {
    return direct;
  }
  if (grant.url) {
    try {
      const url = new URL(grant.url);
      return url.hostname;
    } catch (_error) {
      return null;
    }
  }
  return null;
}

export function resolveTunnelUrl(grant: ControllerTunnelGrant | null | undefined): string | null {
  if (!grant) {
    return null;
  }
  const direct = grant.url?.trim();
  if (direct) {
    return direct;
  }
  const host = resolveTunnelHostname(grant);
  return host ? `https://${host}` : null;
}

export function formatTunnelLabel(grant: ControllerTunnelGrant): string {
  const host = resolveTunnelHostname(grant) ?? grant.tunnelId ?? "Tunnel";
  const normalizedStatus = (grant.status ?? "").toLowerCase();
  if (!normalizedStatus || normalizedStatus === "active") {
    return `Tunnel ${host}`;
  }
  return `Tunnel ${host} (${normalizedStatus})`;
}

export function RuntimeStateIndicator({
  option,
  className,
}: {
  option: RuntimeMenuOption;
  className?: string;
}) {
  const styles = resolveRuntimeStateStyles(option.state);
  const baseClass = className ? className : "";
  if (styles.indicator === "spinner") {
    return (
      <Spinner tone="secondary" size="xs" className={baseClass} aria-hidden="true" />
    );
  }
  if (styles.indicator === "ring") {
    return (
      <span
        className={`inline-flex h-3 w-3 items-center justify-center ${baseClass}`.trim()}
        aria-hidden="true"
      >
        <span className={`h-2.5 w-2.5 rounded-full ${styles.indicatorClass}`} />
      </span>
    );
  }
  return (
    <span
      className={`inline-flex h-2.5 w-2.5 rounded-full ${styles.indicatorClass} ${baseClass}`.trim()}
      aria-hidden="true"
    />
  );
}

interface RuntimeStateStyle {
  badgeClass: string;
  indicator: "dot" | "spinner" | "ring";
  indicatorClass: string;
}

export function resolveRuntimeStateStyles(state: RuntimeStatusState): RuntimeStateStyle {
  switch (state) {
    case "online":
      return {
        badgeClass: "bg-primary-50 text-primary-600",
        indicator: "dot",
        indicatorClass: "bg-primary-500",
      };
    case "idle":
      return {
        badgeClass: "bg-slate-50 text-slate-500",
        indicator: "ring",
        indicatorClass: "border border-dashed border-slate-400",
      };
    case "booting":
      return {
        badgeClass: "bg-secondary-50 text-secondary-600",
        indicator: "spinner",
        indicatorClass: "border-2 border-secondary-300 border-t-secondary-500",
      };
    default:
      return {
        badgeClass: "bg-slate-100 text-slate-500",
        indicator: "dot",
        indicatorClass: "bg-slate-300",
      };
  }
}

function writeClipboardTextWithDomFallback(value: string): void {
  if (typeof document === "undefined") {
    throw new Error("Clipboard unavailable");
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!copied) {
    throw new Error("Clipboard unavailable");
  }
}

export async function writeClipboardText(value: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch (error) {
      try {
        writeClipboardTextWithDomFallback(value);
        return;
      } catch {
        throw error;
      }
    }
  }

  writeClipboardTextWithDomFallback(value);
}
