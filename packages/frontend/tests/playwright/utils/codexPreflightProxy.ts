const CODEX_PROXY_CONTAINER_PORT = 8789;
const CODEX_PREFLIGHT_PROXY_HOST = "127.0.0.1";

export type CodexPreflightDockerResult = {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
};

export type CodexPreflightDockerRunner = (
  args: readonly string[],
) => CodexPreflightDockerResult;

type CodexPreflightProxyOptions = {
  projectName: string;
  composePath: string;
  containerName: string;
};

type CodexPreflightProxyRunOptions = CodexPreflightProxyOptions & {
  hostPort: number;
  build: boolean;
};

type CodexPreflightEnvironment = Record<string, string | undefined>;

const PREFLIGHT_ENVIRONMENT_KEYS = [
  "PROXY_PORT",
  "CONTROLLER_INTERNAL_TOKEN",
  "PROXY_CODEX_VOLUME",
  "OPENAI_API_KEY",
] as const;

function assertValidHostPort(hostPort: number): void {
  if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65_535) {
    throw new Error(`Invalid Codex preflight proxy port: ${hostPort}`);
  }
}

/**
 * Applies only the environment changes needed by the one-off proxy and returns
 * an idempotent restorer. When copied subscription auth is mounted, an ambient
 * paid API key must not shadow it.
 */
export function configureCodexPreflightProxyEnvironment(
  environment: CodexPreflightEnvironment,
  {
    hostPort,
    authDirectory,
  }: {
    hostPort: number;
    authDirectory: string | null;
  },
): () => void {
  assertValidHostPort(hostPort);
  const originalValues = new Map(
    PREFLIGHT_ENVIRONMENT_KEYS.map((key) => [key, environment[key]]),
  );

  environment.PROXY_PORT = String(hostPort);
  delete environment.CONTROLLER_INTERNAL_TOKEN;
  if (authDirectory) {
    environment.PROXY_CODEX_VOLUME = authDirectory;
    delete environment.OPENAI_API_KEY;
  }

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const key of PREFLIGHT_ENVIRONMENT_KEYS) {
      const originalValue = originalValues.get(key);
      if (originalValue === undefined) {
        delete environment[key];
      } else {
        environment[key] = originalValue;
      }
    }
  };
}

/**
 * Runs the disposable proxy as a Compose one-off container. Compose `run`
 * deliberately ignores the service's normal `ports` entry, so the only host
 * publication is the loopback-only mapping below.
 */
export function buildCodexPreflightProxyRunArgs({
  projectName,
  composePath,
  containerName,
  hostPort,
  build,
}: CodexPreflightProxyRunOptions): string[] {
  assertValidHostPort(hostPort);

  const args = [
    "compose",
    "-p",
    projectName,
    "-f",
    composePath,
    "run",
    "--detach",
    "--no-deps",
    "--name",
    containerName,
    "--publish",
    `${CODEX_PREFLIGHT_PROXY_HOST}:${hostPort}:${CODEX_PROXY_CONTAINER_PORT}`,
  ];
  if (build) {
    args.push("--build");
  }
  args.push("proxy");
  return args;
}

export function buildCodexPreflightProxyDownArgs({
  projectName,
  composePath,
}: Pick<CodexPreflightProxyOptions, "projectName" | "composePath">): string[] {
  return [
    "compose",
    "-p",
    projectName,
    "-f",
    composePath,
    "down",
    "--remove-orphans",
  ];
}

function commandSucceeded(result: CodexPreflightDockerResult): boolean {
  return result.status === 0 && !result.error;
}

function commandDetail(result: CodexPreflightDockerResult): string {
  const detail = (result.error?.message || result.stderr || "")
    .replace(/\s+/g, " ")
    .trim();
  const status = result.status === null ? "no exit status" : `exit ${result.status}`;
  return detail ? `${status}: ${detail.slice(0, 500)}` : status;
}

function isMissingContainer(result: CodexPreflightDockerResult): boolean {
  if (commandSucceeded(result)) return false;
  const detail = `${result.error?.message ?? ""}\n${result.stderr ?? ""}`;
  return /no such (?:container|object)/i.test(detail);
}

type ContainerInspection =
  | { state: "present" }
  | { state: "absent" }
  | { state: "unknown"; detail: string };

function inspectContainer(
  runDocker: CodexPreflightDockerRunner,
  containerName: string,
): ContainerInspection {
  const result = runDocker(["container", "inspect", containerName]);
  if (commandSucceeded(result)) return { state: "present" };
  if (isMissingContainer(result)) return { state: "absent" };
  return { state: "unknown", detail: commandDetail(result) };
}

/**
 * Stops the auth-bearing proxy and verifies that its named container no longer
 * exists. Any cleanup anomaly fails the Playwright setup. If Compose cleanup
 * fails or leaves the one-off container behind, a force-removal is attempted
 * before the fatal error is surfaced.
 */
export function cleanupCodexPreflightProxy(
  options: CodexPreflightProxyOptions,
  runDocker: CodexPreflightDockerRunner,
): void {
  const failures: string[] = [];
  const downResult = runDocker(buildCodexPreflightProxyDownArgs(options));
  if (!commandSucceeded(downResult)) {
    failures.push(`docker compose down failed (${commandDetail(downResult)})`);
  }

  let inspection = inspectContainer(runDocker, options.containerName);
  if (inspection.state === "present") {
    failures.push("the Codex preflight proxy container survived Compose cleanup");
  } else if (inspection.state === "unknown") {
    failures.push(`could not verify proxy removal (${inspection.detail})`);
  }

  if (inspection.state !== "absent") {
    const forceRemoveResult = runDocker([
      "container",
      "rm",
      "--force",
      options.containerName,
    ]);
    if (!commandSucceeded(forceRemoveResult) && !isMissingContainer(forceRemoveResult)) {
      failures.push(
        `forced proxy removal failed (${commandDetail(forceRemoveResult)})`,
      );
    }
    inspection = inspectContainer(runDocker, options.containerName);
  }

  if (inspection.state !== "absent") {
    const detail =
      inspection.state === "unknown"
        ? inspection.detail
        : "container is still present after forced removal";
    throw new Error(
      `[global-setup] SECURITY: Unable to confirm removal of Codex preflight proxy ` +
        `${options.containerName}; it may still expose copied Codex auth on the host ` +
        `(${detail}). ${failures.join("; ")}`,
    );
  }

  if (failures.length > 0) {
    throw new Error(
      `[global-setup] Codex preflight proxy cleanup required recovery; the proxy ` +
        `is no longer present, but setup is failing closed. ${failures.join("; ")}`,
    );
  }
}
