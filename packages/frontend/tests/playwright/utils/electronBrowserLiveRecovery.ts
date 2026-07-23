import type { APIRequestContext } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  cleanupElectronBrowserStudio,
  type ElectronBrowserCleanupConfig,
  type ElectronBrowserCleanupTarget,
} from "./electronBrowserLiveCleanup.js";
import {
  ElectronBrowserRecoveryJournalError,
  reconcileElectronBrowserRecoveryTarget,
  type ElectronBrowserRecoveryIdentity,
  type ElectronBrowserRecoveryTarget,
} from "./electronBrowserLiveResourceRecovery.js";

export {
  electronBrowserRecoveryOrgName,
  electronBrowserRecoveryOrgSlug,
  electronBrowserRecoveryProjectName,
  ElectronBrowserRecoveryJournalError,
  reconcileElectronBrowserRecoveryTarget,
  type ElectronBrowserRecoveryIdentity,
  type ElectronBrowserRecoveryTarget,
} from "./electronBrowserLiveResourceRecovery.js";

const RECOVERY_JOURNAL_VERSION = 1;
const RECOVERY_PROFILE_VERSION = 1;
const RECOVERY_PROFILE_OWNER_FILENAME = ".instafy-smoke-profile-owner.json";
const RECOVERY_PROFILE_OWNER_KEYS = new Set([
  "version",
  "recoveryMarker",
  "parentPid",
  "electronPid",
  "createdAt",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECOVERY_JOURNAL_KEYS = new Set([
  "version",
  "controllerUrl",
  "supabaseUrl",
  "disposableEmail",
  "recoveryMarker",
  "orgId",
  "projectId",
  "userId",
  "credentialUploadStarted",
]);

export type ElectronBrowserRecoveryJournal = {
  version: typeof RECOVERY_JOURNAL_VERSION;
  controllerUrl: string;
  supabaseUrl: string;
  disposableEmail: string;
  recoveryMarker: string;
  orgId: string | null;
  projectId: string | null;
  userId: string | null;
  // Set before the UI action that can upload auth.json. A false positive is
  // intentional: service-role cleanup is idempotent and safer than losing the
  // recovery handle between the request and its response.
  credentialUploadStarted: boolean;
};

type ElectronBrowserRecoveryProfileOwner = {
  version: typeof RECOVERY_PROFILE_VERSION;
  recoveryMarker: string;
  parentPid: number;
  electronPid: number | null;
  createdAt: string;
};

type ElectronBrowserLocalProfileRecoveryDependencies = {
  isProcessAlive?: (pid: number) => boolean;
  commandForPid?: (pid: number) => string | null;
  findProfilePids?: (
    recoveryMarker: string,
    profilePath: string,
  ) => number[] | null;
  wait?: (delayMs: number) => Promise<void>;
  timeoutMs?: number;
  recoveryDirectory?: string;
};

function normalizeRecoveryMarker(recoveryMarker: string): string {
  const normalized = recoveryMarker.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new ElectronBrowserRecoveryJournalError("marker is invalid");
  }
  return normalized;
}

export function resolveElectronBrowserRecoveryProfilePath(
  recoveryMarker: string,
  recoveryDirectory: string = resolveElectronBrowserRecoveryDirectory(),
): string {
  return path.join(
    normalizeRecoveryDirectory(recoveryDirectory),
    "profiles",
    normalizeRecoveryMarker(recoveryMarker),
  );
}

function recoveryProfileOwnerPath(profilePath: string): string {
  return path.join(profilePath, RECOVERY_PROFILE_OWNER_FILENAME);
}

function parseRecoveryProfileOwner(
  value: unknown,
): ElectronBrowserRecoveryProfileOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ElectronBrowserRecoveryJournalError(
      "local profile owner is invalid",
    );
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !RECOVERY_PROFILE_OWNER_KEYS.has(key),
    )
  ) {
    throw new ElectronBrowserRecoveryJournalError(
      "local profile owner contains unsupported fields",
    );
  }
  const recoveryMarker =
    typeof record.recoveryMarker === "string"
      ? normalizeRecoveryMarker(record.recoveryMarker)
      : "";
  const parentPid = record.parentPid;
  const electronPid = record.electronPid;
  const createdAt = record.createdAt;
  const validatedElectronPid =
    electronPid === null
      ? null
      : typeof electronPid === "number" &&
          Number.isSafeInteger(electronPid) &&
          electronPid > 0
        ? electronPid
        : undefined;
  if (
    record.version !== RECOVERY_PROFILE_VERSION ||
    !recoveryMarker ||
    typeof parentPid !== "number" ||
    !Number.isSafeInteger(parentPid) ||
    parentPid <= 0 ||
    validatedElectronPid === undefined ||
    typeof createdAt !== "string" ||
    !Number.isFinite(Date.parse(createdAt))
  ) {
    throw new ElectronBrowserRecoveryJournalError(
      "local profile owner is invalid",
    );
  }
  return {
    version: RECOVERY_PROFILE_VERSION,
    recoveryMarker,
    parentPid,
    electronPid: validatedElectronPid,
    createdAt,
  };
}

function readRecoveryProfileOwner(
  profilePath: string,
): ElectronBrowserRecoveryProfileOwner {
  try {
    const profileStat = fs.lstatSync(profilePath);
    if (!profileStat.isDirectory() || profileStat.isSymbolicLink()) {
      throw new ElectronBrowserRecoveryJournalError(
        "local profile is not a regular directory",
      );
    }
    const ownerPath = recoveryProfileOwnerPath(profilePath);
    const ownerStat = fs.lstatSync(ownerPath);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) {
      throw new ElectronBrowserRecoveryJournalError(
        "local profile owner is not a regular file",
      );
    }
    return parseRecoveryProfileOwner(
      JSON.parse(fs.readFileSync(ownerPath, "utf8")),
    );
  } catch (error) {
    if (error instanceof ElectronBrowserRecoveryJournalError) {
      throw error;
    }
    throw new ElectronBrowserRecoveryJournalError(
      "local profile owner could not be read",
    );
  }
}

function writeRecoveryProfileOwner(
  profilePath: string,
  owner: ElectronBrowserRecoveryProfileOwner,
): void {
  const ownerPath = recoveryProfileOwnerPath(profilePath);
  const temporaryPath = `${ownerPath}.${process.pid}.${Date.now()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    fs.writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporaryPath, ownerPath);
    fs.chmodSync(ownerPath, 0o600);
  } catch {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The sanitized error below is sufficient.
      }
    }
    fs.rmSync(temporaryPath, { force: true });
    throw new ElectronBrowserRecoveryJournalError(
      "local profile owner could not be written",
    );
  }
}

export function prepareElectronBrowserRecoveryProfile(
  recoveryMarker: string,
  recoveryDirectory: string = resolveElectronBrowserRecoveryDirectory(),
): string {
  const normalizedMarker = normalizeRecoveryMarker(recoveryMarker);
  const profilePath = resolveElectronBrowserRecoveryProfilePath(
    normalizedMarker,
    recoveryDirectory,
  );
  if (fs.existsSync(profilePath)) {
    throw new ElectronBrowserRecoveryJournalError(
      "local profile already exists and must be recovered first",
    );
  }
  try {
    const profilesDirectory = path.dirname(profilePath);
    fs.mkdirSync(profilesDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(profilesDirectory, 0o700);
    fs.mkdirSync(profilePath, { mode: 0o700 });
    fs.chmodSync(profilePath, 0o700);
    writeRecoveryProfileOwner(profilePath, {
      version: RECOVERY_PROFILE_VERSION,
      recoveryMarker: normalizedMarker,
      parentPid: process.pid,
      electronPid: null,
      createdAt: new Date().toISOString(),
    });
    return profilePath;
  } catch (error) {
    fs.rmSync(profilePath, { recursive: true, force: true });
    if (error instanceof ElectronBrowserRecoveryJournalError) {
      throw error;
    }
    throw new ElectronBrowserRecoveryJournalError(
      "local profile could not be prepared",
    );
  }
}

export function checkpointElectronBrowserRecoveryProfileProcess(
  recoveryMarker: string,
  electronPid: number,
  recoveryDirectory: string = resolveElectronBrowserRecoveryDirectory(),
): void {
  if (!Number.isSafeInteger(electronPid) || electronPid <= 0) {
    throw new ElectronBrowserRecoveryJournalError(
      "local profile process id is invalid",
    );
  }
  const normalizedMarker = normalizeRecoveryMarker(recoveryMarker);
  const profilePath = resolveElectronBrowserRecoveryProfilePath(
    normalizedMarker,
    recoveryDirectory,
  );
  const owner = readRecoveryProfileOwner(profilePath);
  if (
    owner.recoveryMarker !== normalizedMarker ||
    owner.parentPid !== process.pid ||
    owner.electronPid !== null
  ) {
    throw new ElectronBrowserRecoveryJournalError(
      "local profile ownership changed before process checkpoint",
    );
  }
  writeRecoveryProfileOwner(profilePath, { ...owner, electronPid });
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function defaultCommandForPid(pid: number): string | null {
  if (process.platform === "win32") {
    return null;
  }
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    timeout: 2_000,
  });
  return result.status === 0 && typeof result.stdout === "string"
    ? result.stdout.trim()
    : null;
}

function defaultFindProfilePids(
  recoveryMarker: string,
  profilePath: string,
): number[] | null {
  if (process.platform === "win32") {
    return null;
  }
  const result = spawnSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    timeout: 2_000,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return null;
  }
  const markerArg = `--instafy-smoke-recovery-marker=${recoveryMarker}`;
  const profileArg = `--user-data-dir=${profilePath}`;
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.match(/^\s*(\d+)\s+(.+)$/u))
    .filter(
      (match): match is RegExpMatchArray =>
        Boolean(match) &&
        (match?.[2]?.includes(markerArg) === true ||
          match?.[2]?.includes(profileArg) === true),
    )
    .map((match) => Number.parseInt(match[1], 10))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

export async function recoverElectronBrowserLocalProfile(
  recoveryMarker: string,
  dependencies: ElectronBrowserLocalProfileRecoveryDependencies = {},
): Promise<boolean> {
  const normalizedMarker = normalizeRecoveryMarker(recoveryMarker);
  const profilePath = resolveElectronBrowserRecoveryProfilePath(
    normalizedMarker,
    dependencies.recoveryDirectory,
  );
  const isProcessAlive = dependencies.isProcessAlive ?? defaultIsProcessAlive;
  const commandForPid = dependencies.commandForPid ?? defaultCommandForPid;
  const findProfilePids = dependencies.findProfilePids ?? defaultFindProfilePids;
  const markerArg = `--instafy-smoke-recovery-marker=${normalizedMarker}`;
  const profileArg = `--user-data-dir=${profilePath}`;
  if (!fs.existsSync(profilePath)) {
    const discoveredPids = findProfilePids(normalizedMarker, profilePath);
    if (discoveredPids === null) {
      throw new ElectronBrowserRecoveryJournalError(
        "local profile process discovery was unavailable",
      );
    }
    const livePids = discoveredPids.filter(isProcessAlive);
    for (const pid of livePids) {
      const command = commandForPid(pid);
      if (!command?.includes(markerArg) && !command?.includes(profileArg)) {
        throw new ElectronBrowserRecoveryJournalError(
          "local profile process identity could not be verified",
        );
      }
    }
    if (livePids.length > 0) {
      throw new ElectronBrowserRecoveryJournalError(
        "local profile process remains after its profile disappeared",
      );
    }
    return false;
  }
  const owner = readRecoveryProfileOwner(profilePath);
  if (owner.recoveryMarker !== normalizedMarker) {
    throw new ElectronBrowserRecoveryJournalError(
      "local profile marker could not be verified",
    );
  }

  const wait = dependencies.wait ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const timeoutMs = dependencies.timeoutMs ?? 10_000;
  const candidatePids = new Set<number>();

  if (owner.electronPid !== null) {
    if (isProcessAlive(owner.electronPid)) {
      candidatePids.add(owner.electronPid);
    }
  } else if (isProcessAlive(owner.parentPid)) {
    throw new ElectronBrowserRecoveryJournalError(
      "local profile is still owned by a live test process",
    );
  }

  const refreshAndVerifyMarkerProcesses = (): number[] => {
    const discoveredPids = findProfilePids(normalizedMarker, profilePath);
    if (discoveredPids === null) {
      throw new ElectronBrowserRecoveryJournalError(
        "local profile process discovery was unavailable",
      );
    }
    for (const pid of discoveredPids) {
      candidatePids.add(pid);
    }
    const livePids = [...candidatePids].filter(isProcessAlive);
    for (const pid of livePids) {
      const command = commandForPid(pid);
      if (!command?.includes(markerArg) && !command?.includes(profileArg)) {
        throw new ElectronBrowserRecoveryJournalError(
          "local profile process identity could not be verified",
        );
      }
    }
    return livePids;
  };

  const deadline = Date.now() + timeoutMs;
  let livePids = refreshAndVerifyMarkerProcesses();
  while (livePids.length > 0 && Date.now() < deadline) {
    await wait(100);
    livePids = refreshAndVerifyMarkerProcesses();
  }
  if (livePids.length > 0) {
    throw new ElectronBrowserRecoveryJournalError(
      "local profile process did not exit after its parent disappeared",
    );
  }

  const finalOwner = readRecoveryProfileOwner(profilePath);
  if (
    finalOwner.recoveryMarker !== owner.recoveryMarker ||
    finalOwner.parentPid !== owner.parentPid ||
    finalOwner.electronPid !== owner.electronPid ||
    finalOwner.createdAt !== owner.createdAt
  ) {
    throw new ElectronBrowserRecoveryJournalError(
      "local profile ownership changed during recovery",
    );
  }
  try {
    fs.rmSync(profilePath, { recursive: true, force: false });
  } catch {
    throw new ElectronBrowserRecoveryJournalError(
      "local profile could not be removed",
    );
  }
  if (fs.existsSync(profilePath)) {
    throw new ElectronBrowserRecoveryJournalError(
      "local profile remains after recovery",
    );
  }
  return true;
}

function safeBaseUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    const url = new URL(value.trim());
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.toString().replace(/\/+$/g, "");
  } catch {
    return null;
  }
}

function safeResourceId(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return UUID_PATTERN.test(normalized) ? normalized : undefined;
}

function safeRecoveryIdentity(
  disposableEmailValue: unknown,
  recoveryMarkerValue: unknown,
): ElectronBrowserRecoveryIdentity | null {
  const disposableEmail =
    typeof disposableEmailValue === "string"
      ? disposableEmailValue.trim().toLowerCase()
      : "";
  const recoveryMarker =
    typeof recoveryMarkerValue === "string" ? recoveryMarkerValue.trim() : "";
  if (
    !UUID_PATTERN.test(recoveryMarker) ||
    disposableEmail !==
      `electron-shared-browser-${recoveryMarker.toLowerCase()}@instafy.dev`
  ) {
    return null;
  }
  return { disposableEmail, recoveryMarker };
}

function parseRecoveryJournal(value: unknown): ElectronBrowserRecoveryJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ElectronBrowserRecoveryJournalError("is invalid");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !RECOVERY_JOURNAL_KEYS.has(key))) {
    throw new ElectronBrowserRecoveryJournalError("contains unsupported fields");
  }
  const controllerUrl = safeBaseUrl(record.controllerUrl);
  const supabaseUrl = safeBaseUrl(record.supabaseUrl);
  const identity = safeRecoveryIdentity(
    record.disposableEmail,
    record.recoveryMarker,
  );
  const orgId = safeResourceId(record.orgId);
  const projectId = safeResourceId(record.projectId);
  const userId = safeResourceId(record.userId);
  if (
    record.version !== RECOVERY_JOURNAL_VERSION ||
    !controllerUrl ||
    !supabaseUrl ||
    !identity ||
    orgId === undefined ||
    projectId === undefined ||
    userId === undefined ||
    typeof record.credentialUploadStarted !== "boolean"
  ) {
    throw new ElectronBrowserRecoveryJournalError("is invalid");
  }
  return {
    version: RECOVERY_JOURNAL_VERSION,
    controllerUrl,
    supabaseUrl,
    ...identity,
    orgId,
    projectId,
    userId,
    credentialUploadStarted: record.credentialUploadStarted,
  };
}

function normalizeRecoveryDirectory(directory: string): string {
  const normalized = directory.trim();
  if (!normalized) {
    throw new ElectronBrowserRecoveryJournalError("directory path is empty");
  }
  return path.resolve(normalized);
}

function normalizeRecoveryJournalPath(journalPath: string): string {
  const normalized = journalPath.trim();
  if (!normalized) {
    throw new ElectronBrowserRecoveryJournalError("path is empty");
  }
  return path.resolve(normalized);
}

export function resolveElectronBrowserRecoveryDirectory(): string {
  const override =
    process.env.PLAYWRIGHT_ELECTRON_SHARED_BROWSER_RECOVERY_DIR?.trim();
  return normalizeRecoveryDirectory(
    override ||
      path.join(
        os.homedir(),
        ".instafy",
        "smoke-recovery",
        "electron-shared-browser-production",
      ),
  );
}

export function resolveElectronBrowserRecoveryJournalPath(
  directory: string,
  recoveryMarker: string,
): string {
  if (!UUID_PATTERN.test(recoveryMarker.trim())) {
    throw new ElectronBrowserRecoveryJournalError("marker is invalid");
  }
  return path.join(
    normalizeRecoveryDirectory(directory),
    `${recoveryMarker.trim().toLowerCase()}.json`,
  );
}

export function readElectronBrowserRecoveryJournal(
  journalPath: string,
): ElectronBrowserRecoveryJournal | null {
  const normalizedPath = normalizeRecoveryJournalPath(journalPath);
  if (!fs.existsSync(normalizedPath)) {
    return null;
  }
  try {
    const stat = fs.lstatSync(normalizedPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ElectronBrowserRecoveryJournalError("is not a regular file");
    }
    const journal = parseRecoveryJournal(
      JSON.parse(fs.readFileSync(normalizedPath, "utf8")),
    );
    if (
      path.basename(normalizedPath) !==
      `${journal.recoveryMarker.toLowerCase()}.json`
    ) {
      throw new ElectronBrowserRecoveryJournalError("filename is invalid");
    }
    return journal;
  } catch (error) {
    if (error instanceof ElectronBrowserRecoveryJournalError) {
      throw error;
    }
    throw new ElectronBrowserRecoveryJournalError("could not be read");
  }
}

export function writeElectronBrowserRecoveryJournal(
  journalPath: string,
  config: ElectronBrowserCleanupConfig,
  identity: ElectronBrowserRecoveryIdentity,
  target: ElectronBrowserRecoveryTarget,
  credentialUploadStarted: boolean,
): ElectronBrowserRecoveryJournal {
  // Construct the record field-by-field. In particular, config's service-role
  // key and a provisioning target's session can never enter the serialized
  // object even if callers pass richer runtime values.
  const record = parseRecoveryJournal({
    version: RECOVERY_JOURNAL_VERSION,
    controllerUrl: config.controllerUrl,
    supabaseUrl: config.supabaseUrl,
    disposableEmail: identity.disposableEmail,
    recoveryMarker: identity.recoveryMarker,
    orgId: target.orgId ?? null,
    projectId: target.projectId ?? null,
    userId: target.userId ?? null,
    credentialUploadStarted,
  });
  const normalizedPath = normalizeRecoveryJournalPath(journalPath);
  if (
    path.basename(normalizedPath) !==
    `${record.recoveryMarker.toLowerCase()}.json`
  ) {
    throw new ElectronBrowserRecoveryJournalError("filename is invalid");
  }
  const directory = path.dirname(normalizedPath);
  const temporaryPath = `${normalizedPath}.${process.pid}.${Date.now()}.tmp`;
  let descriptor: number | null = null;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    fs.writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporaryPath, normalizedPath);
    fs.chmodSync(normalizedPath, 0o600);
    return record;
  } catch {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The original safe error is reported below.
      }
    }
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // The recovery journal remains unchanged if temporary cleanup fails.
    }
    throw new ElectronBrowserRecoveryJournalError("could not be written");
  }
}

export function removeElectronBrowserRecoveryJournal(journalPath: string): void {
  const normalizedPath = normalizeRecoveryJournalPath(journalPath);
  try {
    fs.rmSync(normalizedPath, { force: true });
  } catch {
    throw new ElectronBrowserRecoveryJournalError("could not be removed");
  }
}

async function reconcileElectronBrowserRecoveryJournal(
  request: APIRequestContext,
  config: ElectronBrowserCleanupConfig,
  journalPath: string,
): Promise<ElectronBrowserRecoveryJournal | null> {
  let journal = readElectronBrowserRecoveryJournal(journalPath);
  if (!journal) {
    return null;
  }
  const currentControllerUrl = safeBaseUrl(config.controllerUrl);
  const currentSupabaseUrl = safeBaseUrl(config.supabaseUrl);
  if (
    currentControllerUrl !== journal.controllerUrl ||
    currentSupabaseUrl !== journal.supabaseUrl
  ) {
    // Never combine retained production ids with credentials for a different
    // environment. Keep the journal so the operator can rerun with the config
    // that created it.
    throw new ElectronBrowserRecoveryJournalError(
      "belongs to a different controller or Supabase environment",
    );
  }
  const reconciled = await reconcileElectronBrowserRecoveryTarget(
    request,
    config,
    journal,
    journal,
  );
  if (
    reconciled.userId !== journal.userId ||
    reconciled.orgId !== journal.orgId ||
    reconciled.projectId !== journal.projectId
  ) {
    journal = writeElectronBrowserRecoveryJournal(
      journalPath,
      config,
      journal,
      reconciled,
      journal.credentialUploadStarted,
    );
  }

  return journal;
}

export async function recoverElectronBrowserStudioFromJournal(
  request: APIRequestContext,
  config: ElectronBrowserCleanupConfig,
  journalPath: string,
): Promise<boolean> {
  const journal = await reconcileElectronBrowserRecoveryJournal(
    request,
    config,
    journalPath,
  );
  if (!journal) {
    return false;
  }

  await cleanupElectronBrowserStudio(
    request,
    config,
    {
      orgId: journal.orgId,
      projectId: journal.projectId,
      userId: journal.userId,
      session: null,
    },
    null,
  );
  // Strict cleanup resolved, including the service-role credential purge and
  // provider-release acknowledgement. Only now is it safe to forget the ids.
  removeElectronBrowserRecoveryJournal(journalPath);
  return true;
}

export async function recoverElectronBrowserStudioFromJournalOrTarget(
  request: APIRequestContext,
  config: ElectronBrowserCleanupConfig,
  journalPath: string,
  target: ElectronBrowserCleanupTarget,
  credentialId?: string | null,
): Promise<"journal" | "target"> {
  const journal = await reconcileElectronBrowserRecoveryJournal(
    request,
    config,
    journalPath,
  );
  if (journal) {
    const sessionAccessToken = target.session?.accessToken?.trim() ?? "";
    if (sessionAccessToken) {
      const inMemoryUserId = target.userId?.trim() ?? "";
      const inMemoryOrgId = target.orgId?.trim() ?? "";
      const inMemoryProjectId = target.projectId?.trim() ?? "";
      if (
        !inMemoryUserId ||
        inMemoryUserId !== journal.userId ||
        (inMemoryOrgId && inMemoryOrgId !== journal.orgId) ||
        (inMemoryProjectId && inMemoryProjectId !== journal.projectId)
      ) {
        throw new ElectronBrowserRecoveryJournalError(
          "does not match the authenticated in-memory cleanup target",
        );
      }
      // This is same-run teardown, not crash recovery. Keep the no-secret
      // journal as the ownership/reconciliation record, but use the live
      // disposable-user session retained only in process for project-scoped
      // controller cleanup.
      await cleanupElectronBrowserStudio(
        request,
        config,
        {
          orgId: journal.orgId,
          projectId: journal.projectId,
          userId: journal.userId,
          session: { accessToken: sessionAccessToken },
        },
        credentialId,
      );
      removeElectronBrowserRecoveryJournal(journalPath);
      return "journal";
    }

    // A later process has no disposable-user credential. Use only the
    // controller/Supabase service-authorized recovery paths and retain the
    // journal unless every absence/release proof succeeds.
    await cleanupElectronBrowserStudio(
      request,
      config,
      {
        orgId: journal.orgId,
        projectId: journal.projectId,
        userId: journal.userId,
        session: null,
      },
      null,
    );
    removeElectronBrowserRecoveryJournal(journalPath);
    return "journal";
  }
  if (!target.userId?.trim() && !target.orgId?.trim() && !target.projectId?.trim()) {
    throw new ElectronBrowserRecoveryJournalError(
      "vanished before any in-memory cleanup handle was available",
    );
  }
  // A vanished journal is not success: use every process-local handle in the
  // same strict cleanup path. This covers accidental file removal after the
  // create responses were checkpointed in memory.
  await cleanupElectronBrowserStudio(
    request,
    config,
    target,
    credentialId,
  );
  return "target";
}

export async function recoverElectronBrowserStudiosBeforeProvisioning(
  request: APIRequestContext,
  config: ElectronBrowserCleanupConfig,
  directory: string,
): Promise<number> {
  const normalizedDirectory = normalizeRecoveryDirectory(directory);
  if (!fs.existsSync(normalizedDirectory)) {
    return 0;
  }
  let journalPaths: string[];
  try {
    const stat = fs.lstatSync(normalizedDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ElectronBrowserRecoveryJournalError("directory is invalid");
    }
    journalPaths = fs
      .readdirSync(normalizedDirectory)
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .map((entry) => path.join(normalizedDirectory, entry));
  } catch (error) {
    if (error instanceof ElectronBrowserRecoveryJournalError) {
      throw error;
    }
    throw new ElectronBrowserRecoveryJournalError("directory could not be read");
  }

  const journalFilenames = new Set(
    journalPaths.map((journalPath) => path.basename(journalPath)),
  );
  const profilesDirectory = path.join(normalizedDirectory, "profiles");
  if (fs.existsSync(profilesDirectory)) {
    let profileMarkers: string[];
    try {
      const profilesStat = fs.lstatSync(profilesDirectory);
      if (!profilesStat.isDirectory() || profilesStat.isSymbolicLink()) {
        throw new ElectronBrowserRecoveryJournalError(
          "local profiles directory is invalid",
        );
      }
      profileMarkers = fs.readdirSync(profilesDirectory).sort();
    } catch (error) {
      if (error instanceof ElectronBrowserRecoveryJournalError) {
        throw error;
      }
      throw new ElectronBrowserRecoveryJournalError(
        "local profiles directory could not be read",
      );
    }
    for (const profileMarker of profileMarkers) {
      const profilePath = path.join(profilesDirectory, profileMarker);
      let profileStat: fs.Stats;
      try {
        profileStat = fs.lstatSync(profilePath);
      } catch {
        throw new ElectronBrowserRecoveryJournalError(
          "local profile entry could not be read",
        );
      }
      if (
        !UUID_PATTERN.test(profileMarker) ||
        !profileStat.isDirectory() ||
        profileStat.isSymbolicLink()
      ) {
        throw new ElectronBrowserRecoveryJournalError(
          "local profile entry is invalid",
        );
      }
      if (!journalFilenames.has(`${profileMarker.toLowerCase()}.json`)) {
        // A local profile can contain a refresh token. Without its journal we
        // cannot prove which disposable server identity owns it, so block a
        // new run and retain the profile for explicit operator recovery.
        throw new ElectronBrowserRecoveryJournalError(
          "local profile has no matching recovery journal",
        );
      }
    }
  }

  const failures: string[] = [];
  let recovered = 0;
  // A collaboration canary owns one full Studio journal plus one or more
  // user-only actor journals. The full Studio reconciliation deliberately
  // requires the disposable owner to be the organization's only member, so
  // recover user-only collaborators first. Filename order is random UUID
  // order and cannot encode this dependency after a hard-killed run.
  const orderedJournalPaths = journalPaths
    .map((journalPath) => {
      try {
        const journal = readElectronBrowserRecoveryJournal(journalPath);
        return {
          journalPath,
          rank: journal && !journal.orgId && !journal.projectId ? 0 : 1,
        };
      } catch {
        // Preserve the existing per-journal error handling below. Invalid
        // journals run last so they cannot prevent independent, verifiable
        // user-only cleanup from unblocking a retained owner journal.
        return { journalPath, rank: 2 };
      }
    })
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        left.journalPath.localeCompare(right.journalPath),
    )
    .map(({ journalPath }) => journalPath);
  for (const journalPath of orderedJournalPaths) {
    try {
      const journal = readElectronBrowserRecoveryJournal(journalPath);
      if (journal) {
        // The desktop process owns a disposable local profile containing the
        // Supabase session. Recover it before touching server resources so a
        // live orphan can never overlap a new destructive run.
        await recoverElectronBrowserLocalProfile(journal.recoveryMarker, {
          recoveryDirectory: normalizedDirectory,
        });
      }
      if (
        await recoverElectronBrowserStudioFromJournal(
          request,
          config,
          journalPath,
        )
      ) {
        recovered += 1;
      }
    } catch (error) {
      failures.push(
        error instanceof ElectronBrowserRecoveryJournalError
          ? error.message
          : `Electron Shared Browser recovery cleanup failed (${error instanceof Error ? error.name : "unknown error"}).`,
      );
    }
  }
  if (failures.length > 0) {
    throw new ElectronBrowserRecoveryJournalError(
      `${failures.length} retained run(s) could not be reconciled`,
    );
  }
  return recovered;
}
