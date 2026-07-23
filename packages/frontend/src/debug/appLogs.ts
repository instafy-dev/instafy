import type { BuildLogEntry } from "../types";

const STORAGE_NAME = "instafy.appLogs.v1";
const MAX_LOG_LINES = 250;

type AppLogListener = () => void;

const listeners = new Set<AppLogListener>();
let logs: BuildLogEntry[] = [];
let captureInstalled = false;
let pendingPersistTimer: number | null = null;

function safeGetRandomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function truncate(value: string, limit = 10_000): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}…`;
}

function stringifyUnknown(value: unknown): string {
  if (value instanceof Error) {
    return truncate(value.stack || `${value.name}: ${value.message}`);
  }
  if (typeof value === "string") {
    return truncate(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  try {
    return truncate(JSON.stringify(value));
  } catch {
    return truncate(String(value));
  }
}

function formatConsoleArgs(args: unknown[]): string {
  return truncate(args.map(stringifyUnknown).join(" "));
}

function resolveUrlFromFetchArgs(args: Parameters<typeof fetch>): string | null {
  const first = args[0] as unknown;
  if (typeof first === "string") {
    return first;
  }
  if (typeof Request !== "undefined" && first instanceof Request) {
    return first.url;
  }
  if (first && typeof first === "object" && "url" in (first as Record<string, unknown>)) {
    const url = (first as Record<string, unknown>).url;
    return typeof url === "string" ? url : null;
  }
  return null;
}

function sanitizeUrl(value: string): string {
  if (typeof window === "undefined") {
    return value.split(/[?#]/)[0] ?? value;
  }
  try {
    const url = new URL(value, window.location.href);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.split(/[?#]/)[0] ?? value;
  }
}

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function persistLogs(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_NAME, JSON.stringify(logs));
  } catch {
    // Ignore persistence failures (storage full / blocked / private mode).
  }
}

function schedulePersist(): void {
  if (typeof window === "undefined") {
    return;
  }
  if (pendingPersistTimer !== null) {
    return;
  }
  pendingPersistTimer = window.setTimeout(() => {
    pendingPersistTimer = null;
    persistLogs();
  }, 500);
}

function addLog(severity: BuildLogEntry["severity"], message: string): void {
  const entry: BuildLogEntry = {
    id: safeGetRandomId(),
    timestamp: Date.now(),
    severity,
    message: truncate(message),
  };
  logs = [...logs, entry].slice(-MAX_LOG_LINES);
  schedulePersist();
  emitChange();
}

function loadPersistedLogs(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_NAME);
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return;
    }
    logs = parsed
      .filter((entry): entry is BuildLogEntry => {
        return Boolean(
          entry &&
            typeof entry === "object" &&
            typeof (entry as BuildLogEntry).id === "string" &&
            typeof (entry as BuildLogEntry).message === "string" &&
            typeof (entry as BuildLogEntry).timestamp === "number" &&
            ((entry as BuildLogEntry).severity === "info" ||
              (entry as BuildLogEntry).severity === "warn" ||
              (entry as BuildLogEntry).severity === "error")
        );
      })
      .slice(-MAX_LOG_LINES);
  } catch {
    // Ignore malformed payloads.
  }
}

export function installAppLogCapture(): void {
  if (captureInstalled) {
    return;
  }
  captureInstalled = true;

  if (typeof window === "undefined") {
    return;
  }

  loadPersistedLogs();

  if (typeof window.fetch === "function") {
    try {
      const originalFetch = window.fetch.bind(window);
      window.fetch = (async (...args: Parameters<typeof fetch>) => {
        const url = resolveUrlFromFetchArgs(args);
        try {
          const response = await originalFetch(...args);
          if (!response.ok) {
            const status = response.status;
            const level = status >= 500 ? "error" : "warn";
            addLog(level, `fetch ${status}${url ? ` ${sanitizeUrl(url)}` : ""}`);
          }
          return response;
        } catch (error) {
          addLog("error", `fetch failed${url ? ` ${sanitizeUrl(url)}` : ""}\n${stringifyUnknown(error)}`);
          throw error;
        }
      }) as typeof fetch;
    } catch {
      // Ignore fetch instrumentation failures.
    }
  }

  const patchConsoleMethod = (
    method: "warn" | "error",
    severity: BuildLogEntry["severity"],
  ) => {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      try {
        addLog(severity, formatConsoleArgs(args));
      } catch {
        // Ignore capture failures.
      }
      original(...args);
    };
  };

  patchConsoleMethod("warn", "warn");
  patchConsoleMethod("error", "error");

  window.addEventListener(
    "error",
    (event: Event) => {
      try {
        if (event instanceof ErrorEvent) {
          const error = event.error;
          if (error instanceof Error) {
            addLog("error", error.stack || `${error.name}: ${error.message}`);
            return;
          }
          const details = [
            event.message,
            event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : null,
          ]
            .filter(Boolean)
            .join(" ");
          if (details) {
            addLog("error", details);
          }
          return;
        }

        const target = event.target as
          | (EventTarget & { src?: string; href?: string; tagName?: string })
          | null;
        const resourceUrl = target?.src || target?.href || null;
        if (resourceUrl) {
          addLog("error", `Resource failed to load: ${sanitizeUrl(resourceUrl)}`);
        }
      } catch {
        // Ignore capture failures.
      }
    },
    true,
  );

  window.addEventListener("unhandledrejection", (event) => {
    try {
      addLog("error", `Unhandled rejection: ${stringifyUnknown(event.reason)}`);
    } catch {
      // Ignore capture failures.
    }
  });
}

export function getAppLogs(): BuildLogEntry[] {
  return logs;
}

export function subscribeAppLogs(listener: AppLogListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function clearAppLogs(): void {
  logs = [];
  persistLogs();
  emitChange();
}

export function logAppInfo(message: string): void {
  addLog("info", message);
}

export function logAppWarn(message: string): void {
  addLog("warn", message);
}

export function logAppError(message: string, error?: unknown): void {
  if (error) {
    addLog("error", `${message}\n${stringifyUnknown(error)}`);
    return;
  }
  addLog("error", message);
}
