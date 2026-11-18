import kleur from "kleur";
import { requestControllerApiJson } from "./api.js";
import { shownJson, shownPath } from "./terminal-text.js";

let promptsModule: Promise<typeof import("@clack/prompts")> | null = null;

async function loadPrompts() {
  promptsModule ??= import("@clack/prompts");
  return promptsModule;
}

/**
 * One of your own machines as `GET /me/runtimes` lists it: a runtime the controller attested as
 * yours in one space, or a runtime token you minted for a machine that has not connected yet
 * (`status` "pending"). A computer you use in several spaces has a runtime, and a record, in each.
 * `revoked` is true while the runtime's current tokens are the ones you revoked, and `revokedAt`
 * says when; starting it again gives it new ones and clears both. A pending mint is never revoked.
 * Only these fields are kept, so nothing else reaches the terminal or `--json`.
 */
export type MachineRecord = {
  runtimeId: string;
  projectId: string;
  projectReadable: boolean;
  projectName: string | null;
  displayName: string | null;
  provider: string | null;
  status: string;
  lastSeenAt: string | null;
  mintedAt: string | null;
  personalBrowser: boolean;
  revoked: boolean;
  revokedAt: string | null;
};

type MachinesCommonOptions = {
  controllerUrl?: string;
  accessToken?: string;
  json?: boolean;
};

export type RuntimeMachinesOptions = MachinesCommonOptions;

export type RuntimeRevokeOptions = MachinesCommonOptions & {
  idsOrPrefixes: string[];
  all?: boolean;
  yes?: boolean;
};

const PENDING_STATUS = "pending";
const SHORT_ID_LENGTH = 8;
const MAX_REVOKED_IDS = 100;
const SIGN_IN_NOTE =
  "Revoking does not sign you out on a machine: one that still has your sign-in can start again.";
const EVERY_SPACE_NOTE = "Their access ends now, in every space, and the ones running stop.";
const ONCE_PER_SPACE_NOTE =
  "A computer used in several spaces is listed once per space: name each of its ids, or pass --all to end every one.";

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function toMachineRecord(entry: unknown): MachineRecord | null {
  if (!entry || typeof entry !== "object") return null;
  const raw = entry as Record<string, unknown>;
  const runtimeId = readString(raw.runtimeId);
  const projectId = readString(raw.projectId);
  const status = readString(raw.status);
  if (!runtimeId || !projectId || !status) return null;
  const projectReadable = raw.projectReadable === true;
  const revoked = raw.revoked === true;
  return {
    runtimeId,
    projectId,
    projectReadable,
    projectName: projectReadable ? readString(raw.projectName) : null,
    displayName: readString(raw.displayName),
    provider: readString(raw.provider),
    status,
    lastSeenAt: readString(raw.lastSeenAt),
    mintedAt: readString(raw.mintedAt),
    personalBrowser: raw.personalBrowser === true,
    revoked,
    revokedAt: revoked ? readString(raw.revokedAt) : null,
  };
}

async function fetchMachines(options: MachinesCommonOptions): Promise<MachineRecord[]> {
  const payload = await requestControllerApiJson<{ runtimes?: unknown }>({
    method: "GET",
    path: "/me/runtimes",
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
  });
  if (!Array.isArray(payload?.runtimes)) {
    throw new Error("The server answered without a list of machines.");
  }
  return payload.runtimes
    .map(toMachineRecord)
    .filter((record): record is MachineRecord => record !== null);
}

/**
 * Text the server sent, as the terminal shows it. Other people choose some of it: a machine names
 * itself each time it registers, and anyone who may edit a space may rename it. So the control
 * characters, line separators and bidirectional marks a terminal would act on, to rewrite or hide
 * a row, are escaped (terminal-text.ts). `--json` escapes the same characters (`shownJson`), so
 * its output parses to the text as it came: `JSON.stringify` alone escapes only those up to
 * U+001F, and would print DEL, the C1 controls, the line separators and the bidirectional marks
 * as they came.
 */
function shown(text: string): string {
  return shownPath(text);
}

export function shortMachineId(id: string): string {
  return id.slice(0, SHORT_ID_LENGTH);
}

function shortIds(ids: string[]): string {
  return ids.map((id) => shown(shortMachineId(id))).join(", ");
}

export function machineName(record: MachineRecord): string {
  if (record.displayName) return record.displayName;
  if (record.status === PENDING_STATUS) return "New machine";
  if (record.personalBrowser) return "Personal Browser";
  return "Self-hosted machine";
}

function machineSpace(record: MachineRecord): string {
  if (!record.projectReadable) return "(a space you can no longer open)";
  return record.projectName ?? "Untitled space";
}

function machineStatus(record: MachineRecord): string {
  if (record.revoked) return "revoked";
  if (record.status === PENDING_STATUS) return "not connected yet";
  return record.status;
}

/** The machine's short id, name and space, as the terminal shows them. */
function describeMachine(record: MachineRecord): string {
  return shown(
    [shortMachineId(record.runtimeId), machineName(record), machineSpace(record)].join(" · "),
  );
}

/** A machine as the confirmation names it, with its full id. */
function confirmationLine(record: MachineRecord): string {
  const line = `  ${describeMachine(record)} (${shown(record.runtimeId)})`;
  return record.revoked ? `${line}, already revoked` : line;
}

/**
 * Resolve machine ids or unique id prefixes against your machines. Exact ids win; a prefix must
 * match exactly one machine. Each machine is named once, however many arguments match it.
 */
export function resolveMachineRecords(
  records: MachineRecord[],
  idsOrPrefixes: string[],
): MachineRecord[] {
  const resolved: MachineRecord[] = [];
  for (const idOrPrefix of idsOrPrefixes) {
    const needle = idOrPrefix.trim().toLowerCase();
    if (!needle) {
      throw new Error("A machine id is required. Run `instafy runtime machines` to see ids.");
    }
    const exact = records.find((record) => record.runtimeId.toLowerCase() === needle);
    const matches = exact
      ? [exact]
      : records.filter((record) => record.runtimeId.toLowerCase().startsWith(needle));
    if (matches.length === 0) {
      throw new Error(
        `No machine of yours matches "${idOrPrefix}". Run \`instafy runtime machines\` to see ids.`,
      );
    }
    if (matches.length > 1) {
      const candidates = matches.map((record) => `  ${describeMachine(record)}`).join("\n");
      throw new Error(
        `Machine id prefix "${idOrPrefix}" is ambiguous; it matches ${matches.length} machines:\n${candidates}\n\nUse a longer prefix or the full id.`,
      );
    }
    const match = matches[0]!;
    if (!resolved.some((record) => record.runtimeId === match.runtimeId)) {
      resolved.push(match);
    }
  }
  return resolved;
}

function formatTimestamp(value: string | null): string {
  if (!value) return "never";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${parsed.toISOString().slice(0, 16).replace("T", " ")}Z`;
}

/** A table whose every cell is shown escaped, so no value can rewrite another row or column. */
function renderTable(headers: string[], rows: string[][]): string {
  const cells = rows.map((row) => row.map(shown));
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...cells.map((row) => row[index]?.length ?? 0)),
  );
  const line = (row: string[]) =>
    row.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd();
  return [kleur.bold(line(headers)), ...cells.map(line)].join("\n");
}

/** `instafy runtime machines`: your own machines in every space, once per space. */
export async function runtimeMachines(options: RuntimeMachinesOptions): Promise<void> {
  const records = await fetchMachines(options);

  if (options.json) {
    console.log(shownJson(records));
    return;
  }

  if (records.length === 0) {
    console.log(kleur.gray("No machines."));
    return;
  }

  console.log(
    renderTable(
      ["ID", "NAME", "SPACE", "STATUS", "LAST SEEN"],
      records.map((record) => [
        shortMachineId(record.runtimeId),
        machineName(record),
        machineSpace(record),
        machineStatus(record),
        record.status === PENDING_STATUS
          ? `minted ${formatTimestamp(record.mintedAt)}`
          : formatTimestamp(record.lastSeenAt),
      ]),
    ),
  );
}

/**
 * Revoking asks first only where a person can answer: both stdin and stdout are a terminal, the
 * output is not `--json` (a question would break it) and `CI` is not "true". Anywhere else it
 * needs `--yes`.
 */
function requireConfirmation(question: string, json: boolean | undefined): void {
  const interactive = Boolean(
    process.stdin.isTTY && process.stdout.isTTY && json !== true && process.env.CI !== "true",
  );
  if (!interactive) {
    throw new Error(`Refusing to ${question.toLowerCase()} without confirmation. Re-run with --yes.`);
  }
}

async function confirmRevoke(question: string, details: string[], notes: string[]): Promise<void> {
  const { confirm, isCancel } = await loadPrompts();
  for (const line of details) console.log(kleur.yellow(line));
  for (const line of notes) console.log(kleur.gray(line));
  const answer = await confirm({ message: `${question}?`, initialValue: false });
  if (isCancel(answer) || !answer) {
    throw new Error("Cancelled.");
  }
}

/** What revoking the machines named ends: each one's access to its own space, and no other. */
function namedScopeNote(count: number): string {
  return count === 1
    ? "Its access to the space listed ends now, and it stops if it is running."
    : "Their access to the spaces listed ends now, and the ones running stop.";
}

/** What `POST /me/runtimes/revoke` answers: the ids this revocation ended, and no others. */
type RevokeAnswer = { revoked?: unknown; pendingEnded?: unknown };

/**
 * `instafy runtime revoke`: end the runtime, agent and job tokens of your machines named by id or
 * prefix, each in its own space, or of all of them with `--all`, and stop the ones running. A
 * machine already revoked is left as it is, and when the list leaves nothing to revoke, nothing is
 * asked or sent.
 */
export async function runtimeRevoke(options: RuntimeRevokeOptions): Promise<void> {
  const named = options.idsOrPrefixes.filter((value) => value.trim().length > 0);
  if (options.all && named.length > 0) {
    throw new Error("Name machines to revoke, or pass --all, not both.");
  }
  if (!options.all && named.length === 0) {
    throw new Error(
      "Name the machines to revoke (see `instafy runtime machines`), or pass --all to revoke all of them.",
    );
  }

  // The server skips a machine still revoked, so a question about only such machines would be
  // about nothing. Then the body is null: nothing is asked or sent, and the answer is the empty
  // one the server would have given.
  let body: { all: true } | { runtimeIds: string[] } | null;
  let requested: MachineRecord[] = [];
  if (options.all) {
    body = { all: true };
    if (!options.yes) {
      const question = "Revoke all your machines";
      // Where no one can answer, this refuses before anything is read.
      requireConfirmation(question, options.json);
      // The question names only the machines not revoked yet; a pending token is one of them.
      const notRevoked = (await fetchMachines(options)).filter((record) => !record.revoked);
      if (notRevoked.length === 0) body = null;
      else await confirmRevoke(question, notRevoked.map(confirmationLine), [EVERY_SPACE_NOTE]);
    }
  } else {
    requested = resolveMachineRecords(await fetchMachines(options), named);
    if (requested.length > MAX_REVOKED_IDS) {
      throw new Error(`Revoke at most ${MAX_REVOKED_IDS} machines at once, or pass --all.`);
    }
    // Every machine named is sent, as one started again since the list was read is no longer
    // revoked. The question and its note count only the ones the list shows not revoked yet, and
    // the lines above it mark the others.
    const notRevoked = requested.filter((record) => !record.revoked);
    body =
      notRevoked.length === 0 ? null : { runtimeIds: requested.map((record) => record.runtimeId) };
    if (body && !options.yes) {
      const question =
        notRevoked.length === 1 ? "Revoke this machine" : `Revoke these ${notRevoked.length} machines`;
      requireConfirmation(question, options.json);
      await confirmRevoke(question, requested.map(confirmationLine), [
        namedScopeNote(notRevoked.length),
        ONCE_PER_SPACE_NOTE,
      ]);
    }
  }

  const result: RevokeAnswer | null = body
    ? await requestControllerApiJson<RevokeAnswer>({
        method: "POST",
        path: "/me/runtimes/revoke",
        controllerUrl: options.controllerUrl,
        accessToken: options.accessToken,
        jsonBody: body,
      })
    : { revoked: [], pendingEnded: [] };
  const ids = (value: unknown) =>
    Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  const revoked = ids(result?.revoked);
  const pendingEnded = ids(result?.pendingEnded);

  if (options.json) {
    console.log(shownJson({ revoked, pendingEnded }));
    return;
  }

  // The answer lists only what this revocation ended, and is empty when nothing was sent, so a
  // machine named and left out of it had been revoked already.
  const ended = new Set([...revoked, ...pendingEnded].map((id) => id.toLowerCase()));
  const alreadyRevoked = requested
    .map((record) => record.runtimeId)
    .filter((id) => !ended.has(id.toLowerCase()));
  const alreadyRevokedNote =
    alreadyRevoked.length > 0
      ? `${alreadyRevoked.length === 1 ? "1 machine was" : `${alreadyRevoked.length} machines were`} already revoked: ${shortIds(alreadyRevoked)}`
      : null;

  if (revoked.length === 0 && pendingEnded.length === 0) {
    console.log(kleur.gray("There was nothing to revoke."));
    if (alreadyRevokedNote) console.log(kleur.gray(alreadyRevokedNote));
    return;
  }
  if (revoked.length > 0) {
    console.log(
      kleur.green(
        `Revoked ${revoked.length} machine${revoked.length === 1 ? "" : "s"}: ${shortIds(revoked)}`,
      ),
    );
  }
  if (pendingEnded.length > 0) {
    console.log(
      kleur.green(
        `Ended ${pendingEnded.length} token${pendingEnded.length === 1 ? "" : "s"} for a machine that had not connected yet: ${shortIds(pendingEnded)}`,
      ),
    );
  }
  if (alreadyRevokedNote) console.log(kleur.gray(alreadyRevokedNote));
  console.log(kleur.gray(SIGN_IN_NOTE));
}
