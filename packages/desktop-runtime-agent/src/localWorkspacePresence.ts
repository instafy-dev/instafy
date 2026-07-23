import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface LocalWorkspacePresenceOptions {
  controllerUrl: string;
  projectId: string;
  accessToken: string;
  workspacePath: string;
  deviceId?: string;
  heartbeatIntervalMs?: number;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

export interface LocalWorkspacePresenceHandle {
  deviceId: string;
  stop: () => Promise<void>;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Stable per-machine device id, persisted under ~/.instafy/device-id so the
 * controller sees the same device across restarts. INSTAFY_DEVICE_ID overrides.
 */
export function resolveDeviceId(): string {
  const fromEnv = process.env.INSTAFY_DEVICE_ID?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const dir = path.join(os.homedir(), ".instafy");
  const file = path.join(dir, "device-id");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) {
      return existing;
    }
  } catch {
    // fall through and create one
  }
  const id = randomUUID();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `${id}\n`, "utf8");
  } catch {
    // non-fatal: a per-process id still works, it just won't be stable
  }
  return id;
}

/**
 * Register this machine's working copy for a project with the controller and
 * keep it alive with heartbeats. The controller prunes entries whose
 * heartbeats stop (TTL 120s), so a crashed process expires on its own;
 * stop() unregisters eagerly for clean shutdowns.
 */
export async function startLocalWorkspacePresence(
  options: LocalWorkspacePresenceOptions,
): Promise<LocalWorkspacePresenceHandle> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? (() => {});
  const deviceId = options.deviceId ?? resolveDeviceId();
  const base = options.controllerUrl.replace(/\/$/, "");
  const endpoint = `${base}/projects/${encodeURIComponent(options.projectId)}/workspaces/local`;
  const headers = {
    authorization: `Bearer ${options.accessToken}`,
    "content-type": "application/json",
  };

  const register = async () => {
    const response = await fetchImpl(endpoint, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        path: options.workspacePath,
        deviceId,
        hostname: os.hostname(),
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `local workspace registration failed (${response.status}): ${text}`,
      );
    }
  };

  await register();
  log(`registered local workspace presence for ${options.projectId} at ${options.workspacePath}`);

  let stopped = false;
  const heartbeat = async () => {
    try {
      const response = await fetchImpl(`${endpoint}/heartbeat`, {
        method: "POST",
        headers,
        body: JSON.stringify({ deviceId }),
      });
      if (response.status === 400) {
        // Registration expired or was replaced — re-register.
        await register();
        return;
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        log(`local workspace heartbeat failed (${response.status}): ${text}`);
      }
    } catch (error) {
      log(`local workspace heartbeat error: ${String(error)}`);
    }
  };

  const timer = setInterval(() => {
    if (!stopped) {
      void heartbeat();
    }
  }, options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();

  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(timer);
    try {
      await fetchImpl(endpoint, {
        method: "DELETE",
        headers,
        body: JSON.stringify({ deviceId }),
      });
      log(`unregistered local workspace presence for ${options.projectId}`);
    } catch (error) {
      // Best effort: the controller TTL-prunes the entry within ~2 minutes.
      log(`local workspace unregister error: ${String(error)}`);
    }
  };

  return { deviceId, stop };
}
