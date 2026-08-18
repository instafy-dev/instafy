import kleur from "kleur";
import {
  resolveControllerUrl,
  resolveUserAccessTokenWithSource,
  type AccessTokenSource,
} from "./config.js";
import { fetchWithControllerAuth } from "./controller-fetch.js";
import { formatAuthRejectedError, formatAuthRequiredError } from "./errors.js";

let promptsModule: Promise<typeof import("@clack/prompts")> | null = null;

async function loadPrompts() {
  promptsModule ??= import("@clack/prompts");
  return promptsModule;
}

/**
 * Projection of a controller credential row that is safe to print. The controller never
 * returns secret material from `/me/credentials`, but the CLI still whitelists fields so a
 * future metadata key can never leak into terminal output or `--json`.
 */
export type CredentialRecord = {
  id: string;
  kind: string;
  label: string | null;
  provider: string | null;
  defaultModel: string | null;
  isDefault: boolean;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type CredentialTestResult = {
  ok: boolean;
  provider: string | null;
  model: string | null;
  output: string | null;
  upstreamEndpoint: string | null;
  elapsedMs: number | null;
};

type CredentialsCommonOptions = {
  controllerUrl?: string;
  accessToken?: string;
  json?: boolean;
  cwd?: string;
};

export type CredentialsListOptions = CredentialsCommonOptions & {
  all?: boolean;
};

export type CredentialsTestOptions = CredentialsCommonOptions & {
  idOrPrefix: string;
};

export type CredentialsSetDefaultOptions = CredentialsCommonOptions & {
  idOrPrefix: string;
};

export type CredentialsClearDefaultOptions = CredentialsCommonOptions;

export type CredentialsRevokeOptions = CredentialsCommonOptions & {
  idOrPrefix: string;
  yes?: boolean;
};

type ControllerAuth = {
  controllerUrl: string;
  accessToken: string;
  tokenSource: AccessTokenSource;
  profile: string | null;
  cwd: string;
};

const RETRY_COMMAND = "instafy login";
const SHORT_ID_LENGTH = 8;
const TEST_OUTPUT_PREVIEW_CHARS = 300;
// The controller probes the upstream provider through the proxy; slow providers can take close
// to a minute, so give this one request more headroom than the default controller timeout.
const CREDENTIAL_TEST_TIMEOUT_MS = 90_000;

function resolveControllerAuth(options: CredentialsCommonOptions): ControllerAuth {
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
      retryCommand: RETRY_COMMAND,
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
  params: {
    method: "GET" | "POST" | "DELETE";
    path: string;
    timeoutMs?: number;
  },
): Promise<unknown> {
  const url = `${auth.controllerUrl.replace(/\/$/, "")}${params.path}`;
  const headers = new Headers();
  headers.set("accept", "application/json");

  const init: RequestInit = { method: params.method, headers };
  if (params.timeoutMs !== undefined) {
    init.signal = AbortSignal.timeout(params.timeoutMs);
  }

  const response = (
    await fetchWithControllerAuth({
      url,
      init,
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
      retryCommand: RETRY_COMMAND,
      advancedHint: "run `instafy login`, or pass --access-token",
    });
  }
  if (!response.ok) {
    throw new Error(`Request failed (${response.status} ${response.statusText}): ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

function credentialTestTimeoutMs(): number {
  const configured = Number(process.env["INSTAFY_HTTP_TIMEOUT_MS"]);
  const base = Number.isFinite(configured) && configured > 0 ? configured : 0;
  return Math.max(base, CREDENTIAL_TEST_TIMEOUT_MS);
}

function toMaybeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeCredentialRecord(input: unknown): CredentialRecord | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const id = toMaybeString(record.id);
  if (!id) return null;

  const metadata =
    record.metadata && typeof record.metadata === "object"
      ? (record.metadata as Record<string, unknown>)
      : {};

  return {
    id,
    kind: toMaybeString(record.kind) ?? "unknown",
    label: toMaybeString(record.label),
    provider: toMaybeString(metadata.provider),
    defaultModel: toMaybeString(metadata.default_model),
    isDefault: record.isDefault === true,
    lastUsedAt: toMaybeString(record.lastUsedAt),
    revokedAt: toMaybeString(record.revokedAt),
    createdAt: toMaybeString(record.createdAt),
    updatedAt: toMaybeString(record.updatedAt),
  };
}

function listToRecords(payload: unknown): CredentialRecord[] {
  if (!Array.isArray(payload)) return [];
  const out: CredentialRecord[] = [];
  for (const item of payload) {
    const normalized = normalizeCredentialRecord(item);
    if (normalized) out.push(normalized);
  }
  return out;
}

function normalizeTestResult(payload: unknown): CredentialTestResult {
  const record =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const elapsed = record.elapsedMs;
  return {
    ok: record.ok === true,
    provider: toMaybeString(record.provider),
    model: toMaybeString(record.model),
    output: typeof record.output === "string" ? record.output : null,
    upstreamEndpoint: toMaybeString(record.upstreamEndpoint),
    elapsedMs: typeof elapsed === "number" && Number.isFinite(elapsed) ? elapsed : null,
  };
}

async function fetchCredentialRecords(auth: ControllerAuth): Promise<CredentialRecord[]> {
  const payload = await controllerJsonRequest(auth, {
    method: "GET",
    path: "/me/credentials",
  });
  return listToRecords(payload);
}

export function shortCredentialId(id: string): string {
  return id.slice(0, SHORT_ID_LENGTH);
}

function describeCredential(record: CredentialRecord): string {
  const parts = [shortCredentialId(record.id), record.kind];
  if (record.provider) parts.push(record.provider);
  if (record.label) parts.push(`"${record.label}"`);
  if (record.revokedAt) parts.push("revoked");
  return parts.join(" · ");
}

/**
 * Resolve a full credential id or a unique id prefix against the account's credentials.
 * Exact ids always win. Prefixes match active credentials first; a prefix that only matches
 * revoked credentials is reported as such rather than silently picking one.
 */
export function resolveCredentialRecord(
  records: CredentialRecord[],
  idOrPrefix: string,
): CredentialRecord {
  const needle = idOrPrefix.trim().toLowerCase();
  if (!needle) {
    throw new Error("Credential id is required. Run `instafy credentials list` to see ids.");
  }

  const exact = records.find((record) => record.id.toLowerCase() === needle);
  if (exact) return exact;

  const matches = records.filter((record) => record.id.toLowerCase().startsWith(needle));
  const active = matches.filter((record) => !record.revokedAt);

  if (active.length === 1) {
    return active[0]!;
  }
  if (active.length > 1) {
    const candidates = active.map((record) => `  ${describeCredential(record)}`).join("\n");
    throw new Error(
      `Credential id prefix "${idOrPrefix}" is ambiguous; it matches ${active.length} credentials:\n${candidates}\n\nUse a longer prefix or the full id.`,
    );
  }
  if (matches.length > 0) {
    throw new Error(
      `Credential "${idOrPrefix}" only matches revoked credentials. Run \`instafy credentials list --all\` to see them.`,
    );
  }
  throw new Error(
    `No credential matches "${idOrPrefix}". Run \`instafy credentials list\` to see ids.`,
  );
}

async function resolveCredential(
  auth: ControllerAuth,
  idOrPrefix: string,
): Promise<CredentialRecord> {
  const records = await fetchCredentialRecords(auth);
  return resolveCredentialRecord(records, idOrPrefix);
}

async function resolveActiveCredential(
  auth: ControllerAuth,
  idOrPrefix: string,
  action: string,
): Promise<CredentialRecord> {
  const record = await resolveCredential(auth, idOrPrefix);
  if (record.revokedAt) {
    throw new Error(
      `Credential ${describeCredential(record)} is revoked and cannot be ${action}. Run \`instafy credentials list\` to see active ids.`,
    );
  }
  return record;
}

function formatTimestamp(value: string | null): string {
  if (!value) return "never";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${parsed.toISOString().slice(0, 16).replace("T", " ")}Z`;
}

function truncateOutput(output: string, limit: number): string {
  const singleLine = output.replace(/\s+/g, " ").trim();
  if (singleLine.length <= limit) return singleLine;
  return `${singleLine.slice(0, limit)}…`;
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd();
  return [kleur.bold(line(headers)), ...rows.map(line)].join("\n");
}

export async function credentialsList(options: CredentialsListOptions): Promise<void> {
  const auth = resolveControllerAuth(options);
  const records = await fetchCredentialRecords(auth);
  const visible = options.all ? records : records.filter((record) => !record.revokedAt);
  const hiddenRevoked = records.length - visible.length;

  if (options.json) {
    console.log(JSON.stringify(visible, null, 2));
    return;
  }

  if (visible.length === 0) {
    console.log(kleur.gray(records.length === 0 ? "No credentials." : "No active credentials."));
    if (hiddenRevoked > 0) {
      console.log(kleur.gray(`${hiddenRevoked} revoked hidden (use --all to show).`));
    }
    return;
  }

  const rows = visible.map((record) => [
    shortCredentialId(record.id),
    record.kind,
    record.provider ?? "-",
    record.defaultModel ?? "-",
    record.label ?? "-",
    record.isDefault ? "*" : "",
    formatTimestamp(record.lastUsedAt),
    record.revokedAt ? formatTimestamp(record.revokedAt) : "",
  ]);

  console.log(
    renderTable(
      ["ID", "KIND", "PROVIDER", "MODEL", "LABEL", "DEFAULT", "LAST USED", "REVOKED"],
      rows,
    ),
  );
  if (hiddenRevoked > 0) {
    console.log(kleur.gray(`${hiddenRevoked} revoked hidden (use --all to show).`));
  }
  if (!visible.some((record) => record.isDefault && !record.revokedAt)) {
    console.log(
      kleur.yellow(
        "No default credential. Jobs cannot pick one automatically; run `instafy credentials default <id>`.",
      ),
    );
  }
}

export async function credentialsTest(
  options: CredentialsTestOptions,
): Promise<CredentialTestResult> {
  const auth = resolveControllerAuth(options);
  const record = await resolveActiveCredential(auth, options.idOrPrefix, "tested");

  if (!options.json) {
    console.log(
      kleur.gray(
        `Testing ${describeCredential(record)} through the proxy (this calls the upstream provider and may take up to a minute)…`,
      ),
    );
  }

  const payload = await controllerJsonRequest(auth, {
    method: "POST",
    path: `/me/credentials/${encodeURIComponent(record.id)}/test`,
    timeoutMs: credentialTestTimeoutMs(),
  });
  const result = normalizeTestResult(payload);

  if (options.json) {
    console.log(JSON.stringify({ credentialId: record.id, ...result }, null, 2));
    return result;
  }

  const status = result.ok ? kleur.green("ok") : kleur.red("failed");
  console.log(`${status}  ${shortCredentialId(record.id)}`);
  console.log(`  provider ${result.provider ?? "-"} · model ${result.model ?? "-"}`);
  if (result.upstreamEndpoint) {
    console.log(`  upstream ${result.upstreamEndpoint}`);
  }
  if (result.elapsedMs !== null) {
    console.log(`  elapsed ${result.elapsedMs} ms`);
  }
  if (result.output) {
    const preview = truncateOutput(result.output, TEST_OUTPUT_PREVIEW_CHARS);
    console.log(`  output ${result.ok ? preview : kleur.red(preview)}`);
  }
  return result;
}

export async function credentialsSetDefault(options: CredentialsSetDefaultOptions): Promise<void> {
  const auth = resolveControllerAuth(options);
  const record = await resolveActiveCredential(auth, options.idOrPrefix, "made the default");

  const payload = await controllerJsonRequest(auth, {
    method: "POST",
    path: `/me/credentials/${encodeURIComponent(record.id)}/default`,
  });
  const response =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          credentialId: toMaybeString(response.credentialId) ?? record.id,
          kind: toMaybeString(response.kind) ?? record.kind,
          isDefault: response.isDefault !== false,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`${kleur.green("Default set:")} ${describeCredential(record)}`);
}

export async function credentialsClearDefault(
  options: CredentialsClearDefaultOptions,
): Promise<void> {
  const auth = resolveControllerAuth(options);

  await controllerJsonRequest(auth, {
    method: "DELETE",
    path: "/me/credentials/default",
  });

  if (options.json) {
    console.log(JSON.stringify({ ok: true, hasDefaultCredential: false }, null, 2));
    return;
  }

  console.log(kleur.green("Default cleared."));
  console.log(kleur.gray("Jobs will not pick a credential automatically until you set a new default."));
}

async function confirmRevoke(record: CredentialRecord, json: boolean | undefined): Promise<void> {
  const interactive = Boolean(
    process.stdin.isTTY && process.stdout.isTTY && json !== true && process.env.CI !== "true",
  );
  if (!interactive) {
    throw new Error(
      `Refusing to revoke ${describeCredential(record)} without confirmation. Re-run with --yes.`,
    );
  }

  const { confirm, isCancel } = await loadPrompts();
  console.log(kleur.yellow(`Revoke ${describeCredential(record)} (${record.id})?`));
  console.log(kleur.gray("Agents bound to this credential are disconnected and jobs stop using it."));
  const answer = await confirm({ message: "Revoke this credential?", initialValue: false });
  if (isCancel(answer) || !answer) {
    throw new Error("Cancelled.");
  }
}

export async function credentialsRevoke(options: CredentialsRevokeOptions): Promise<void> {
  const auth = resolveControllerAuth(options);
  const record = await resolveActiveCredential(auth, options.idOrPrefix, "revoked again");

  if (!options.yes) {
    await confirmRevoke(record, options.json);
  }

  await controllerJsonRequest(auth, {
    method: "DELETE",
    path: `/me/credentials/${encodeURIComponent(record.id)}`,
  });

  if (options.json) {
    console.log(JSON.stringify({ ok: true, credentialId: record.id }, null, 2));
    return;
  }

  console.log(`${kleur.green("Revoked:")} ${describeCredential(record)}`);
  if (record.isDefault) {
    console.log(
      kleur.yellow(
        "This was the default credential. Set a new one with `instafy credentials default <id>`.",
      ),
    );
  }
}
