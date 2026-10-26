import type {
  KnoshRuntimeAdapter,
  KnoshRuntimeCommandResult,
  KnoshRuntimeDebugInfo,
  KnoshRuntimeStatus,
} from "../../../robot";

export type KnoshDesktopOperatorHint = {
  tone: "info" | "warning" | "danger" | "success";
  title: string;
  body: string;
  details?: string;
  developerOnly?: boolean;
};

type HintInput = {
  runtimeId: KnoshRuntimeAdapter["id"] | null;
  status: KnoshRuntimeStatus | null;
  scanResult: {
    deviceCount: number;
  } | null;
  error: string | null;
  debug: KnoshRuntimeDebugInfo | null;
  latestOutput: unknown;
};

function includesText(value: string | null | undefined, pattern: string) {
  return typeof value === "string" && value.toLowerCase().includes(pattern.toLowerCase());
}

function isKnoshRuntimeCommandResult(value: unknown): value is KnoshRuntimeCommandResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  return "writeCompleted" in value && "action" in value;
}

export function getKnoshDesktopOperatorHints({
  runtimeId,
  status,
  scanResult,
  error,
  debug,
  latestOutput,
}: HintInput): KnoshDesktopOperatorHint[] {
  const hints: KnoshDesktopOperatorHint[] = [];

  const bluetoothPermission = status?.permissions.bluetooth ?? "denied";
  const bleSupported = status?.bleSupported === true;
  const connected = status?.connection.connected === true;
  const ready = status?.connection.ready === true;
  const latestCommandResult = isKnoshRuntimeCommandResult(latestOutput) ? latestOutput : null;

  if (
    runtimeId === "web_bluetooth" &&
    (bluetoothPermission === "prompt" || bluetoothPermission === "prompt-with-rationale")
  ) {
    hints.push({
      tone: "info",
      title: "Browser session note",
      body:
        "This browser session can scan over Web Bluetooth. Use the Instafy desktop app for reliable repeated robot control.",
      developerOnly: true,
    });
  } else if (runtimeId === "web_bluetooth") {
    hints.push({
      tone: "info",
      title: "Browser Bluetooth session",
      body:
        "This browser can scan over Web Bluetooth. The Instafy desktop app remains the supported path for reliable desktop Knosh control.",
      developerOnly: true,
    });
  }

  if (!status) {
    return hints;
  }

  if (!bleSupported) {
    hints.push({
      tone: "danger",
      title: "Desktop BLE is unavailable here",
      body:
        "This runtime does not currently expose Knosh BLE. Open the Instafy desktop app and retry there before treating this as a board or firmware failure.",
    });
  }

  if (
    runtimeId !== "web_bluetooth" &&
    (bluetoothPermission === "prompt" || bluetoothPermission === "prompt-with-rationale")
  ) {
    hints.push({
      tone: "warning",
      title: "Allow Bluetooth in the system prompt",
      body:
        "Click Allow Bluetooth in macOS, then refresh status or retry the scan. Desktop BLE can sit waiting until the system prompt is accepted.",
    });
  } else if (bluetoothPermission === "denied") {
    hints.push({
      tone: "danger",
      title: "Bluetooth access is blocked",
      body:
        "macOS is denying Bluetooth access for this desktop session. Re-enable it in Privacy settings, then refresh status before retrying scan or connect.",
    });
  }

  if (
    includesText(error, "timed out while waiting for bluetooth permission or readiness") ||
    debug?.stage === "status.timeout"
  ) {
    hints.push({
      tone: "warning",
      title: "The desktop bridge is still waiting on macOS",
      body:
        "The native bridge did not become ready in time. Confirm Bluetooth is allowed, then retry Refresh status.",
      details:
        "If it keeps happening, run `pnpm --filter @instafy/desktop-app smoke:knosh:native:release`.",
    });
  }

  if (
    scanResult?.deviceCount === 0 &&
    bluetoothPermission === "granted" &&
    bleSupported &&
    !connected &&
    debug?.stage === "scan.completed"
  ) {
    hints.push({
      tone: "info",
      title: "No Knosh board was found in the latest scan",
      body:
        "Check that the ESP32 board is powered, booted into Knosh firmware, and advertising, then retry Scan for Knosh.",
      details:
        "If desktop still finds nothing, run the native desktop release smoke before debugging the UI.",
    });
  }

  if (includesText(error, "connect to a desktop knosh device before")) {
    hints.push({
      tone: "info",
      title: "Connect first, then read or send commands",
      body:
        "This action needs an active Knosh BLE connection. Scan, connect to the board, and then retry the status read or safe test command.",
      developerOnly: true,
    });
  }

  if (connected && !ready) {
    hints.push({
      tone: "info",
      title: "Connection is still synchronizing",
      body:
        "The board is connected, but the Knosh characteristics are not fully ready yet. Wait a moment and retry Read GATT status if the state does not settle.",
    });
  }

  if (
    latestCommandResult &&
    latestCommandResult.writeCompleted &&
    debug?.stage === "send_command.telemetry_timeout"
  ) {
    hints.push({
      tone: "warning",
      title: "Safe command was written, but Knosh did not reply yet",
      body:
        "The desktop bridge finished writing the command, but no telemetry acknowledgement arrived before timeout.",
      details:
        "Treat `stop_all_motion` as likely delivered, then retry Read GATT status or reconnect if the board still looks stale.",
      developerOnly: true,
    });
  } else if (latestCommandResult?.error && latestCommandResult.writeCompleted === false) {
    hints.push({
      tone: "danger",
      title: "Safe command did not complete",
      body:
        "The desktop bridge did not finish writing the command to Knosh. Retry after reconnecting.",
      details:
        "Use the native desktop release smoke if this keeps happening.",
      developerOnly: true,
    });
  }

  return hints;
}
