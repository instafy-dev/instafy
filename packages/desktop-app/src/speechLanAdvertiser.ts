import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";

type SpawnImpl = typeof spawn;
type DesktopVoiceHostLogLevel = "info" | "warn" | "error";

type DesktopVoiceHostLogger = (
  level: DesktopVoiceHostLogLevel,
  message: string,
  payload?: Record<string, unknown>,
) => void;

type DesktopSpeechLanAdvertiserOptions = {
  spawnImpl?: SpawnImpl;
  logger?: DesktopVoiceHostLogger;
  platform?: NodeJS.Platform;
  dnsSdBinary?: string;
};

type DesktopSpeechLanAdvertiserInput = {
  serviceName?: string | null;
  port: number;
  tokenHint?: string | null;
  authRequired: boolean;
};

export type DesktopSpeechLanAdvertiserStatus = {
  state: "idle" | "advertising" | "unsupported" | "error";
  serviceName?: string;
  port?: number;
  tokenHint?: string | null;
  lastError?: string;
};

const SERVICE_TYPE = "_instafy-speech._tcp";
const SERVICE_DOMAIN = "local.";
const DEFAULT_DNS_SD_BINARY = "dns-sd";

function normalizeOptionalString(value: string | null | undefined) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function defaultServiceName() {
  const hostName = normalizeOptionalString(os.hostname()) ?? "desktop";
  return `Instafy ${hostName}`;
}

function attachChildLogging(
  child: ChildProcessWithoutNullStreams,
  logger: DesktopVoiceHostLogger,
) {
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (!text) {
      return;
    }
    logger("info", "[instafy-desktop] speech-lan-advertiser:stdout", { text });
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (!text) {
      return;
    }
    logger("warn", "[instafy-desktop] speech-lan-advertiser:stderr", { text });
  });
}

export class DesktopSpeechLanAdvertiser {
  private readonly spawnImpl: SpawnImpl;
  private readonly logger: DesktopVoiceHostLogger;
  private readonly platform: NodeJS.Platform;
  private readonly dnsSdBinary: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private currentKey: string | null = null;
  private status: DesktopSpeechLanAdvertiserStatus = {
    state: "idle",
  };
  private stopping = false;

  constructor(options: DesktopSpeechLanAdvertiserOptions = {}) {
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.logger =
      options.logger ??
      ((level, message, payload) => {
        const args = payload ? [message, payload] : [message];
        if (level === "error") {
          console.error(...args);
          return;
        }
        if (level === "warn") {
          console.warn(...args);
          return;
        }
        console.log(...args);
      });
    this.platform = options.platform ?? process.platform;
    this.dnsSdBinary = normalizeOptionalString(options.dnsSdBinary) ?? DEFAULT_DNS_SD_BINARY;
  }

  getStatus() {
    return { ...this.status };
  }

  async ensureRunning(input: DesktopSpeechLanAdvertiserInput) {
    const serviceName = normalizeOptionalString(input.serviceName) ?? defaultServiceName();
    const port = Number.isFinite(input.port) && input.port > 0 ? input.port : 0;
    const tokenHint = normalizeOptionalString(input.tokenHint);
    if (this.platform !== "darwin") {
      await this.stop();
      this.status = {
        state: "unsupported",
        serviceName,
        port: port || undefined,
        tokenHint,
        lastError: "Bonjour LAN advertising currently requires macOS.",
      };
      return this.getStatus();
    }
    if (!port || !tokenHint) {
      await this.stop();
      this.status = {
        state: "idle",
        serviceName,
        port: port || undefined,
        tokenHint,
      };
      return this.getStatus();
    }

    const nextKey = [serviceName, port, tokenHint, input.authRequired ? "1" : "0"].join("::");
    if (this.child && this.currentKey === nextKey && this.child.exitCode === null) {
      this.status = {
        state: "advertising",
        serviceName,
        port,
        tokenHint,
      };
      return this.getStatus();
    }

    await this.stop();
    this.stopping = false;

    try {
      const child = this.spawnImpl(
        this.dnsSdBinary,
        [
          "-R",
          serviceName,
          SERVICE_TYPE,
          SERVICE_DOMAIN,
          String(port),
          `token_hint=${tokenHint}`,
          "host_mode=desktop",
          `auth_required=${input.authRequired ? "1" : "0"}`,
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      this.child = child;
      this.currentKey = nextKey;
      this.status = {
        state: "advertising",
        serviceName,
        port,
        tokenHint,
      };
      attachChildLogging(child, this.logger);
      child.once("error", (error) => {
        if (this.child !== child) {
          return;
        }
        this.child = null;
        this.currentKey = null;
        this.status = {
          state: "error",
          serviceName,
          port,
          tokenHint,
          lastError: error instanceof Error ? error.message : String(error),
        };
        this.logger("warn", "[instafy-desktop] speech-lan-advertiser:error", {
          message: this.status.lastError,
        });
      });
      child.once("exit", (code, signal) => {
        if (this.child !== child) {
          return;
        }
        this.child = null;
        this.currentKey = null;
        if (this.stopping) {
          this.status = {
            state: "idle",
            serviceName,
            port,
            tokenHint,
          };
          return;
        }
        this.status = {
          state: "error",
          serviceName,
          port,
          tokenHint,
          lastError: `dns-sd exited unexpectedly (${signal ?? code ?? "unknown"}).`,
        };
      });
    } catch (error) {
      this.child = null;
      this.currentKey = null;
      this.status = {
        state: "error",
        serviceName,
        port,
        tokenHint,
        lastError: error instanceof Error ? error.message : String(error),
      };
    }

    return this.getStatus();
  }

  async stop() {
    const child = this.child;
    this.child = null;
    this.currentKey = null;
    if (!child || child.exitCode !== null) {
      this.status = {
        state: "idle",
      };
      return this.getStatus();
    }
    this.stopping = true;
    await new Promise<void>((resolve) => {
      const finish = () => {
        resolve();
      };
      child.once("exit", finish);
      child.kill("SIGTERM");
      setTimeout(finish, 1_500);
    });
    this.stopping = false;
    this.status = {
      state: "idle",
    };
    return this.getStatus();
  }
}

export function createDesktopSpeechLanAdvertiser(options: DesktopSpeechLanAdvertiserOptions = {}) {
  return new DesktopSpeechLanAdvertiser(options);
}
