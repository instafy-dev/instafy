import kleur from "kleur";
import {
  resolveControllerUrl,
  resolveUserAccessTokenWithSource,
  type AccessTokenSource,
} from "./config.js";
import { fetchWithControllerAuth } from "./controller-fetch.js";
import { formatAuthRejectedError, formatAuthRequiredError } from "./errors.js";
import { findProjectManifest } from "./project-manifest.js";

type AutomationRecord = {
  id: string;
  name: string;
  scheduleKind: string;
  runAt: string | null;
  intervalHours: number | null;
  byDay: string[];
  byHour: number | null;
  byMinute: number | null;
  timezone: string;
  runtimeMode: string;
  runtimeProvider: string | null;
  silentWhenNothingToReport: boolean;
  resultVisibility: "private" | "team";
  status: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
};

type ResultVisibility = "private" | "team";

type AutomationsCommonOptions = {
  project?: string;
  controllerUrl?: string;
  accessToken?: string;
  json?: boolean;
  cwd?: string;
};

export type AutomationsCreateOptions = AutomationsCommonOptions & {
  name: string;
  prompt: string;
  scheduleKind?: "weekly" | "hourly" | "once";
  runAt?: string;
  intervalHours?: number;
  days?: string;
  time?: string;
  timezone?: string;
  runtimeMode?: "auto" | "hosted" | "existing";
  runtimeProvider?: string;
  silentWhenNothingToReport?: boolean;
  resultVisibility?: ResultVisibility;
  paused?: boolean;
};

export type AutomationsUpdateStatusOptions = AutomationsCommonOptions & {
  automationId: string;
  status: "active" | "paused";
};

export type AutomationsUpdateOptions = AutomationsCommonOptions & {
  automationId: string;
  resultVisibility?: ResultVisibility;
};

export type AutomationsRunOptions = AutomationsCommonOptions & {
  automationId: string;
};

export type AutomationsDeleteOptions = AutomationsCommonOptions & {
  automationId: string;
};

type ControllerAuth = {
  controllerUrl: string;
  accessToken: string;
  tokenSource: AccessTokenSource;
  profile: string | null;
  cwd: string;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeUuidParam(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  return UUID_PATTERN.test(value) ? value : null;
}

function resolveProjectId(project?: string, cwd: string = process.cwd()): string {
  const explicit = project?.trim();
  if (explicit) {
    return explicit;
  }

  const fromSpaceEnv = process.env["SPACE_ID"]?.trim();
  if (fromSpaceEnv) {
    return fromSpaceEnv;
  }

  const manifest = findProjectManifest(cwd).manifest;
  if (manifest?.spaceId?.trim()) {
    return manifest.spaceId.trim();
  }

  throw new Error(
    "No space configured. Run `instafy space init` in this folder, set SPACE_ID, or pass --space.",
  );
}

function resolveControllerAuth(
  options: AutomationsCommonOptions,
  retryCommand: string,
): ControllerAuth {
  const cwd = options.cwd ?? process.cwd();
  const controllerUrl = resolveControllerUrl({
    controllerUrl: options.controllerUrl ?? null,
    cwd,
  });

  const resolved = resolveUserAccessTokenWithSource({
    accessToken: options.accessToken ?? null,
    cwd,
  });

  if (!resolved.token) {
    throw formatAuthRequiredError({
      retryCommand,
      advancedHint:
        "pass --access-token, or set INSTAFY_ACCESS_TOKEN / SUPABASE_ACCESS_TOKEN",
    });
  }

  return {
    controllerUrl,
    accessToken: resolved.token,
    tokenSource: resolved.source,
    profile: resolved.profile,
    cwd,
  };
}

async function controllerJsonRequest(
  auth: ControllerAuth,
  retryCommand: string,
  params: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    path: string;
    body?: Record<string, unknown>;
  },
): Promise<unknown> {
  const url = `${auth.controllerUrl.replace(/\/$/, "")}${params.path}`;
  const headers = new Headers();
  headers.set("accept", "application/json");

  let bodyText: string | undefined;
  if (params.body !== undefined) {
    headers.set("content-type", "application/json");
    bodyText = JSON.stringify(params.body);
  }

  const response = (
    await fetchWithControllerAuth({
      url,
      init: {
        method: params.method,
        headers,
        body: bodyText,
      },
      accessToken: auth.accessToken,
      tokenSource: auth.tokenSource,
      profile: auth.profile,
      cwd: auth.cwd,
    })
  ).response;

  const text = await response.text().catch(() => "");
  if (response.status === 401 || response.status === 403) {
    throw formatAuthRejectedError({
      status: response.status,
      responseBody: text,
      retryCommand,
      advancedHint: "run `instafy login`, or pass --access-token",
    });
  }
  if (!response.ok) {
    throw new Error(`Request failed (${response.status} ${response.statusText}): ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

function normalizeAutomationRecord(input: unknown): AutomationRecord | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!id || !name) return null;

  const toMaybeNumber = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const toMaybeString = (value: unknown): string | null =>
    typeof value === "string" && value.trim() ? value.trim() : null;

  return {
    id,
    name,
    scheduleKind: typeof record.scheduleKind === "string" ? record.scheduleKind : "",
    runAt: toMaybeString(record.runAt),
    intervalHours: toMaybeNumber(record.intervalHours),
    byDay: Array.isArray(record.byDay)
      ? record.byDay.filter((entry): entry is string => typeof entry === "string")
      : [],
    byHour: toMaybeNumber(record.byHour),
    byMinute: toMaybeNumber(record.byMinute),
    timezone: typeof record.timezone === "string" ? record.timezone : "UTC",
    runtimeMode: typeof record.runtimeMode === "string" ? record.runtimeMode : "auto",
    runtimeProvider: toMaybeString(record.runtimeProvider),
    silentWhenNothingToReport: record.silentWhenNothingToReport === true,
    resultVisibility: record.resultVisibility === "team" ? "team" : "private",
    status: typeof record.status === "string" ? record.status : "active",
    nextRunAt: toMaybeString(record.nextRunAt),
    lastRunAt: toMaybeString(record.lastRunAt),
    lastError: toMaybeString(record.lastError),
  };
}

function listToRecords(payload: unknown): AutomationRecord[] {
  if (!Array.isArray(payload)) return [];
  const out: AutomationRecord[] = [];
  for (const item of payload) {
    const normalized = normalizeAutomationRecord(item);
    if (normalized) out.push(normalized);
  }
  return out;
}

function defaultTimezone(): string {
  for (const raw of [
    process.env["INSTAFY_CLIENT_TIMEZONE"],
    process.env["TZ"],
  ]) {
    const value = raw?.trim();
    if (value) return value;
  }
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof tz === "string" && tz.trim()) return tz.trim();
  } catch {
    // ignore
  }
  return "UTC";
}

function parseTime(raw: string | undefined | null): { hour: number; minute: number } {
  const value = (raw ?? "09:00").trim();
  const match = /^([0-9]{1,2}):([0-9]{2})$/.exec(value);
  if (!match) {
    throw new Error("Invalid time. Use HH:MM (24h), e.g. 09:00");
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) {
    throw new Error("Hour must be between 0 and 23");
  }
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) {
    throw new Error("Minute must be between 0 and 59");
  }
  return { hour, minute };
}

function normalizeDays(raw: string | undefined | null): string[] {
  const value = (raw ?? "mo,tu,we,th,fr").trim();
  const parts = value
    .split(/[,\s]+/)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const allowed = new Set(["mo", "tu", "we", "th", "fr", "sa", "su"]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    if (!allowed.has(part)) {
      throw new Error("days must be a comma-separated list of mo,tu,we,th,fr,sa,su");
    }
    if (!seen.has(part)) {
      seen.add(part);
      out.push(part);
    }
  }
  if (out.length === 0) {
    throw new Error("days must include at least one weekday");
  }
  return out;
}

export async function automationsList(options: AutomationsCommonOptions) {
  const auth = resolveControllerAuth(options, "instafy login");
  const projectId = resolveProjectId(options.project, auth.cwd);

  const payload = await controllerJsonRequest(auth, "instafy login", {
    method: "GET",
    path: `/projects/${projectId}/automations`,
  });

  const records = listToRecords(payload);

  if (options.json) {
    console.log(JSON.stringify(records, null, 2));
    return;
  }

  if (records.length === 0) {
    console.log(kleur.gray("No automations."));
    return;
  }

  for (const record of records) {
    const schedule = (() => {
      if (record.scheduleKind === "once") {
        const when = record.runAt ?? record.nextRunAt;
        return when ? `once at ${when}` : "once";
      }
      if (record.scheduleKind === "weekly") {
        return `${record.byDay.join(" ")} ${String(record.byHour ?? 9).padStart(2, "0")}:${String(
          record.byMinute ?? 0,
        ).padStart(2, "0")} (${record.timezone})`;
      }
      return `every ${record.intervalHours ?? 24}h`;
    })();
    const status = record.status === "paused" ? kleur.gray("paused") : kleur.green("active");
    const next = record.nextRunAt ? kleur.cyan(record.nextRunAt) : kleur.gray("n/a");
    const delivery = record.silentWhenNothingToReport ? " · findings only" : "";
    const sharing =
      record.resultVisibility === "team"
        ? ` · ${kleur.cyan("team-visible")}`
        : "";
    console.log(`${kleur.bold(record.name)}  ${kleur.gray(record.id)}`);
    console.log(
      `  ${schedule} · ${record.runtimeMode}${delivery}${sharing} · ${status} · next ${next}`,
    );
    if (record.lastError) {
      console.log(`  ${kleur.red(record.lastError)}`);
    }
  }
}

export async function automationsCreate(options: AutomationsCreateOptions) {
  const auth = resolveControllerAuth(options, "instafy login");
  const projectId = resolveProjectId(options.project, auth.cwd);

  const name = options.name.trim();
  if (!name) {
    throw new Error("--name is required");
  }
  const promptText = options.prompt.trim();
  if (!promptText) {
    throw new Error("--prompt is required");
  }

  const scheduleKind = options.scheduleKind ?? "weekly";
  const timezone = (options.timezone ?? defaultTimezone()).trim() || "UTC";

  const body: Record<string, unknown> = {
    name,
    promptText,
    scheduleKind,
    timezone,
    runtimeMode: options.runtimeMode ?? "auto",
    runtimeProvider: options.runtimeProvider?.trim() || undefined,
    silentWhenNothingToReport: options.silentWhenNothingToReport ?? false,
    resultVisibility: options.resultVisibility ?? undefined,
    status: options.paused ? "paused" : "active",
  };

  if (scheduleKind === "once") {
    const runAt = options.runAt?.trim();
    if (!runAt) {
      throw new Error("--run-at is required when --schedule-kind=once");
    }
    body.runAt = runAt;
  } else if (scheduleKind === "hourly") {
    const interval = Number(options.intervalHours ?? 24);
    if (!Number.isFinite(interval) || interval < 1) {
      throw new Error("--interval-hours must be >= 1");
    }
    body.intervalHours = interval;
  } else {
    const { hour, minute } = parseTime(options.time);
    body.byDay = normalizeDays(options.days);
    body.byHour = hour;
    body.byMinute = minute;
  }

  const payload = await controllerJsonRequest(auth, "instafy login", {
    method: "POST",
    path: `/projects/${projectId}/automations`,
    body,
  });

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const record = normalizeAutomationRecord(payload);
  if (!record) {
    console.log(kleur.green("Automation created."));
    return;
  }
  console.log(`${kleur.green("Created")} ${kleur.bold(record.name)} (${record.id})`);
}

export async function automationsUpdateStatus(options: AutomationsUpdateStatusOptions) {
  const auth = resolveControllerAuth(options, "instafy login");
  const automationId = normalizeUuidParam(options.automationId);
  if (!automationId) {
    throw new Error("automationId must be a UUID");
  }

  const payload = await controllerJsonRequest(auth, "instafy login", {
    method: "PATCH",
    path: `/automations/${automationId}`,
    body: { status: options.status },
  });

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(kleur.green(`Updated ${automationId} -> ${options.status}`));
}

export async function automationsUpdate(options: AutomationsUpdateOptions) {
  const auth = resolveControllerAuth(options, "instafy login");
  const automationId = normalizeUuidParam(options.automationId);
  if (!automationId) {
    throw new Error("automationId must be a UUID");
  }

  const body: Record<string, unknown> = {};
  if (options.resultVisibility !== undefined) {
    body.resultVisibility = options.resultVisibility;
  }
  if (Object.keys(body).length === 0) {
    throw new Error(
      "Nothing to update. Pass --share-results, --no-share-results, or --result-visibility <private|team>.",
    );
  }

  const payload = await controllerJsonRequest(auth, "instafy login", {
    method: "PATCH",
    path: `/automations/${automationId}`,
    body,
  });

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const record = normalizeAutomationRecord(payload);
  if (!record) {
    console.log(kleur.green("Automation updated."));
    return;
  }
  const sharing =
    record.resultVisibility === "team"
      ? "results shared with the team"
      : "results kept private";
  console.log(
    `${kleur.green("Updated")} ${kleur.bold(record.name)} (${record.id}) · ${sharing}`,
  );
}

export async function automationsRun(options: AutomationsRunOptions) {
  const auth = resolveControllerAuth(options, "instafy login");
  const automationId = normalizeUuidParam(options.automationId);
  if (!automationId) {
    throw new Error("automationId must be a UUID");
  }

  await controllerJsonRequest(auth, "instafy login", {
    method: "POST",
    path: `/automations/${automationId}/run`,
  });

  if (options.json) {
    console.log(JSON.stringify({ ok: true }, null, 2));
    return;
  }

  console.log(kleur.green("Queued."));
}

export async function automationsDelete(options: AutomationsDeleteOptions) {
  const auth = resolveControllerAuth(options, "instafy login");
  const automationId = normalizeUuidParam(options.automationId);
  if (!automationId) {
    throw new Error("automationId must be a UUID");
  }

  await controllerJsonRequest(auth, "instafy login", {
    method: "DELETE",
    path: `/automations/${automationId}`,
  });

  if (options.json) {
    console.log(JSON.stringify({ ok: true }, null, 2));
    return;
  }

  console.log(kleur.green("Deleted."));
}
