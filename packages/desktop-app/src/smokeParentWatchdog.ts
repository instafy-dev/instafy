import path from "node:path";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SmokeParentWatchdogConfig = {
  parentPid: number;
  recoveryMarker: string;
};

type SmokeParentWatchdogDependencies = {
  isProcessAlive?: (pid: number) => boolean;
  onParentLost: () => void;
  intervalMs?: number;
};

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export function resolveSmokeParentWatchdogConfig(
  parentPidValue: string | undefined,
  environmentMarkerValue: string | undefined,
  argumentMarkerValue: string | null,
  recoveryRootValue: string | undefined,
  userDataDir: string | null,
): SmokeParentWatchdogConfig | null {
  const parentPidText = parentPidValue?.trim() ?? "";
  const environmentMarker = environmentMarkerValue?.trim().toLowerCase() ?? "";
  const argumentMarker = argumentMarkerValue?.trim().toLowerCase() ?? "";
  const recoveryRoot = recoveryRootValue?.trim() ?? "";
  const hasAnyValue =
    parentPidText.length > 0 ||
    environmentMarker.length > 0 ||
    argumentMarker.length > 0 ||
    recoveryRoot.length > 0;
  if (!hasAnyValue) {
    return null;
  }

  const parentPid = Number(parentPidText);
  if (
    !Number.isSafeInteger(parentPid) ||
    parentPid <= 0 ||
    parentPid === process.pid ||
    !UUID_PATTERN.test(environmentMarker) ||
    argumentMarker !== environmentMarker ||
    !recoveryRoot ||
    !userDataDir
  ) {
    throw new Error("Invalid Electron smoke parent-watchdog configuration.");
  }

  const expectedProfilePath = path.join(
    path.resolve(recoveryRoot),
    "profiles",
    environmentMarker,
  );
  if (path.resolve(userDataDir) !== path.resolve(expectedProfilePath)) {
    throw new Error("Electron smoke profile path does not match its recovery marker.");
  }

  return { parentPid, recoveryMarker: environmentMarker };
}

export function startSmokeParentWatchdog(
  config: SmokeParentWatchdogConfig,
  dependencies: SmokeParentWatchdogDependencies,
): () => void {
  const isProcessAlive = dependencies.isProcessAlive ?? defaultIsProcessAlive;
  const intervalMs = dependencies.intervalMs ?? 250;
  let stopped = false;
  let parentLost = false;
  const timer = setInterval(() => {
    if (stopped || parentLost || isProcessAlive(config.parentPid)) {
      return;
    }
    parentLost = true;
    dependencies.onParentLost();
  }, intervalMs);
  timer.unref();

  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(timer);
  };
}
