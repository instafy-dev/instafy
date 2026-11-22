import type { DesktopExtensionMessageBoxOptions } from "../desktopExtensionRegistry";
import {
  CLAUDE_CODE_LOGIN_SHELL_ENV_KEYS,
  hasControlCharacter,
  type ClaudeCodeLoginShellEnv,
  type ClaudeCodeLoginShellEnvKey,
} from "./detect";

/** The engine a granted start names in its runtime token request (2.10). */
export const CLAUDE_CODE_LOCAL_ENGINE = "claude-code";

/**
 * The version of the consent text a login was given for (11.19). A login
 * given consent for another version counts as not given, and a record with
 * no login of this version grants nothing: nobody's turns run on a login on
 * words they did not see. Version 2's records, one consent for the whole
 * computer with no login of its own, read as no consent.
 */
export const CLAUDE_CODE_CONSENT_VERSION = 3;

/** The most logins a record holds and a grant carries (runtime-contracts' `MAX_LOGINS`). */
export const CLAUDE_CODE_MAX_LOGINS = 10;

/** The most characters a login's name has, as the controller keeps it (11.19). */
export const CLAUDE_CODE_LOGIN_LABEL_MAX_CHARS = 60;

/** What Desktop grants runtime-agent, and strips from every start (4.3, 11.19). */
export const CLAUDE_CODE_LAUNCH_GRANT_ENV_KEYS = Object.freeze([
  "INSTAFY_CLAUDE_CODE_BIN",
  "INSTAFY_CLAUDE_CODE_PATH",
  "INSTAFY_CLAUDE_CODE_USER_ID",
  "INSTAFY_CLAUDE_CODE_ENV_JSON",
  "INSTAFY_CLAUDE_CODE_LOGINS_JSON",
] as const);

export type ClaudeCodeSharedEnvKey = Exclude<ClaudeCodeLoginShellEnvKey, "CLAUDE_CONFIG_DIR">;
export type ClaudeCodeSharedEnv = Readonly<Partial<Record<ClaudeCodeSharedEnvKey, string>>>;

/**
 * The login-shell values every login shares (D26): all but
 * `CLAUDE_CONFIG_DIR`, since each login is a Claude Code folder of its own
 * (11.19) and the record keeps it with that login.
 */
export const CLAUDE_CODE_SHARED_ENV_KEYS: readonly ClaudeCodeSharedEnvKey[] = Object.freeze(
  CLAUDE_CODE_LOGIN_SHELL_ENV_KEYS.filter(
    (key): key is ClaudeCodeSharedEnvKey => key !== "CLAUDE_CONFIG_DIR",
  ),
);

/** A login shell's values without its `CLAUDE_CONFIG_DIR`. */
export function claudeCodeSharedEnv(env: ClaudeCodeLoginShellEnv): ClaudeCodeSharedEnv {
  const shared: Partial<Record<ClaudeCodeSharedEnvKey, string>> = {};
  for (const key of CLAUDE_CODE_SHARED_ENV_KEYS) {
    const value = env[key];
    if (value) {
      shared[key] = value;
    }
  }
  return Object.freeze(shared);
}

/** One login the person consented to on this computer. */
export type ClaudeCodeConsentLogin = Readonly<{
  /** The controller's id for it (`claude_code_logins.id`), in lower case. */
  id: string;
  /**
   * Its Claude Code folder, granted as its `CLAUDE_CONFIG_DIR`; null for
   * Claude Code's usual folder, which is granted as no `CLAUDE_CONFIG_DIR`.
   */
  configDir: string | null;
  consentedAt: string;
  /** The consent text's version it was given for ({@link CLAUDE_CODE_CONSENT_VERSION}). */
  consentVersion: number;
}>;

/**
 * One person's consent on this computer, kept in Desktop's own config under
 * the controller origin and Instafy user id, and never sent anywhere (4.2).
 * The program, its PATH and the shared login-shell values serve every login;
 * each login has its folder and its consent (11.19).
 */
export type ClaudeCodeConsentRecord = Readonly<{
  /** The path the person confirmed, a symlink kept as a symlink. */
  binaryPath: string;
  /** Their login shell's PATH entries. */
  pathEntries: readonly string[];
  /** The D26 values their login shell had, without `CLAUDE_CONFIG_DIR`. */
  env: ClaudeCodeSharedEnv;
  /** The OS account that consented; a record copied to another account is void. */
  osUser: string;
  /** The logins given consent for the current words, in the order they were; never empty. */
  logins: readonly ClaudeCodeConsentLogin[];
}>;

// As the record keeps a login id: lower case, as the controller writes it.
const LOGIN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// As the page may pass one: either case, ASCII hex only.
const PAGE_LOGIN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAbsoluteSingleLine(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && !hasControlCharacter(value);
}

/**
 * A login id from the page: a UUID, in either case, kept in lower case as
 * the controller writes it. Null for anything else.
 */
export function parseClaudeCodeLoginId(value: unknown): string | null {
  return typeof value === "string" && PAGE_LOGIN_ID_PATTERN.test(value) ? value.toLowerCase() : null;
}

// A character a login's name may hold: no control character (C0, DEL, C1),
// nothing that breaks the dialog's line (the line and paragraph separators
// too), and no half of a surrogate pair, which no name the controller keeps
// can hold.
function isLoginLabelCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return !(
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0xd800 && code <= 0xdfff)
  );
}

/**
 * A login's name from the page, as the controller keeps it: trimmed, on one
 * line, 1 to 60 characters, with no control characters. Desktop only shows
 * it, quoted, in the consent dialog beside the folder it checked itself, and
 * keeps it nowhere. Null for anything else.
 */
export function parseClaudeCodeLoginLabel(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() !== value) {
    return null;
  }
  const characters = Array.from(value);
  return characters.length >= 1 &&
    characters.length <= CLAUDE_CODE_LOGIN_LABEL_MAX_CHARS &&
    characters.every(isLoginLabelCharacter)
    ? value
    : null;
}

function parseConsentLogin(value: unknown): ClaudeCodeConsentLogin | null | "malformed" {
  if (!isRecord(value)) {
    return "malformed";
  }
  const { id, configDir, consentedAt, consentVersion } = value;
  if (consentVersion !== CLAUDE_CODE_CONSENT_VERSION) {
    // Given for other words: not consent, but no reason to doubt the rest.
    return null;
  }
  if (
    typeof id !== "string" ||
    !LOGIN_ID_PATTERN.test(id) ||
    !(configDir === null || isAbsoluteSingleLine(configDir)) ||
    typeof consentedAt !== "string" ||
    Number.isNaN(Date.parse(consentedAt))
  ) {
    return "malformed";
  }
  return Object.freeze({ id, configDir, consentedAt, consentVersion: CLAUDE_CODE_CONSENT_VERSION });
}

/**
 * Read a stored record, or null when it grants nothing: it is malformed, it
 * is version 2's, or none of its logins was given consent for the current
 * words. Only what runtime-agent takes as a well-formed grant passes, so
 * Desktop never grants a malformed one: at most 10 logins, each id once and
 * each folder once, the usual folder included, and no `CLAUDE_CONFIG_DIR`
 * among the shared values.
 */
export function parseClaudeCodeConsentRecord(value: unknown): ClaudeCodeConsentRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  const { binaryPath, pathEntries, env, osUser, logins } = value;
  if (
    !isAbsoluteSingleLine(binaryPath) ||
    !Array.isArray(pathEntries) ||
    !pathEntries.every((entry) => isAbsoluteSingleLine(entry) && !entry.includes(":")) ||
    !isRecord(env) ||
    typeof osUser !== "string" ||
    osUser.length === 0 ||
    !Array.isArray(logins)
  ) {
    return null;
  }
  const parsedEnv: Partial<Record<ClaudeCodeSharedEnvKey, string>> = {};
  for (const [key, entry] of Object.entries(env)) {
    if (
      !(CLAUDE_CODE_SHARED_ENV_KEYS as readonly string[]).includes(key) ||
      typeof entry !== "string" ||
      entry.length === 0 ||
      hasControlCharacter(entry)
    ) {
      return null;
    }
    parsedEnv[key as ClaudeCodeSharedEnvKey] = entry;
  }
  const consented: ClaudeCodeConsentLogin[] = [];
  for (const entry of logins) {
    const login = parseConsentLogin(entry);
    if (login === "malformed") {
      return null;
    }
    if (login) {
      consented.push(login);
    }
  }
  if (
    consented.length === 0 ||
    consented.length > CLAUDE_CODE_MAX_LOGINS ||
    new Set(consented.map((login) => login.id)).size !== consented.length ||
    new Set(consented.map((login) => login.configDir)).size !== consented.length
  ) {
    return null;
  }
  return Object.freeze({
    binaryPath,
    pathEntries: Object.freeze([...(pathEntries as string[])]),
    env: Object.freeze(parsedEnv),
    osUser,
    logins: Object.freeze(consented),
  });
}

/**
 * The values a consenting person's runtime start gets: the confirmed path,
 * the login shell's PATH entries (colon-separated, as PATH is), the Instafy
 * user the grant is for, the shared D26 values as one JSON object, and every
 * consented login with its folder (`null` for the usual one), as one JSON
 * array in the order they were set up.
 */
export function buildClaudeCodeLaunchGrantEnv(
  record: ClaudeCodeConsentRecord,
  instafyUserId: string,
): Record<(typeof CLAUDE_CODE_LAUNCH_GRANT_ENV_KEYS)[number], string> {
  return {
    INSTAFY_CLAUDE_CODE_BIN: record.binaryPath,
    INSTAFY_CLAUDE_CODE_PATH: record.pathEntries.join(":"),
    INSTAFY_CLAUDE_CODE_USER_ID: instafyUserId,
    INSTAFY_CLAUDE_CODE_ENV_JSON: JSON.stringify(claudeCodeSharedEnv(record.env)),
    INSTAFY_CLAUDE_CODE_LOGINS_JSON: JSON.stringify(
      record.logins.map((login) => ({ id: login.id, configDir: login.configDir })),
    ),
  };
}

export function claudeCodeConsentQuestion(email: string): string {
  return `Use Claude Code on this computer for ${email}?`;
}

/**
 * The text of the dialog that confirms another program, or new login-shell
 * values, while the lane is on (docs/Local-Engine-Turns.md 11.13). Each
 * login's own consent is {@link CLAUDE_CODE_LOGIN_CONSENT_TEXT}.
 */
export const CLAUDE_CODE_CONSENT_TEXT =
  "Instafy Desktop will start the claude program on this computer, signed in the way you signed in to it yourself, for the turns of your agents whose AI you set to Claude Code: your messages to them, and the turns they take while you're away, such as their automations and their next steps toward a goal, whenever this computer runs the space. It runs under Anthropic's current terms, and that sign-in may bill your Claude plan or your own API or cloud account. Only your own agents' turns run here, one at a time, never anyone else's. Instafy gives Claude Code the words of each turn: your message, or what Instafy wrote for that turn, such as an automation's prompt. Everyone in the space can read the steps it takes and its replies. Claude Code uses your own Claude Code settings, including what you've allowed it to run without asking, except that it changes files without asking, whatever your own setting says, in this space's folder and in any other folder your Claude Code settings let it work in, and skips anything else that would need your OK. It can also write to Claude Code's memory for this folder, which your later Claude Code sessions here load, in Instafy or in a terminal. What others wrote in this space's files can steer it within those settings, also in turns nobody watches: it may copy files kept only on this computer, such as .env, into its reply or into files saved to the space, run the space's code through commands or hooks you've allowed, and put their words into that memory, where your later sessions read them. Instafy never reads, stores or sends your Claude sign-in. Only turn this on if the Claude account signed in on this computer account is yours.";

export function claudeCodeLoginConsentQuestion(label: string, email: string): string {
  return `Use your Claude Code login "${label}" on this computer for ${email}?`;
}

/**
 * Each login's consent text, consent version 3 (docs/Local-Engine-Turns.md
 * 11.19): 11.13's, for that login's folder, with its other sentences as
 * they are.
 */
export const CLAUDE_CODE_LOGIN_CONSENT_TEXT =
  "Instafy Desktop will start the claude program on this computer, signed in the way you signed in to it yourself in this login's folder, for the turns of your agents whose AI is this login: your messages to them, and the turns they take while you're away, such as their automations and their next steps toward a goal, whenever this computer runs the space. It runs under Anthropic's current terms, and that sign-in may bill your Claude plan or your own API or cloud account. Only your own agents' turns run here, one at a time on each login, never anyone else's. Instafy gives Claude Code the words of each turn: your message, or what Instafy wrote for that turn, such as an automation's prompt. Everyone in the space can read the steps it takes and its replies. Claude Code uses your own Claude Code settings, including what you've allowed it to run without asking, except that it changes files without asking, whatever your own setting says, in this space's folder and in any other folder your Claude Code settings let it work in, and skips anything else that would need your OK. It can also write to Claude Code's memory for this folder, which your later Claude Code sessions here load, in Instafy or in a terminal. What others wrote in this space's files can steer it within those settings, also in turns nobody watches: it may copy files kept only on this computer, such as .env, into its reply or into files saved to the space, run the space's code through commands or hooks you've allowed, and put their words into that memory, where your later sessions read them. Instafy never reads, stores or sends your Claude sign-in. Only turn this on if the Claude account signed in to this login is yours.";

/** How the dialog names a login with no `CLAUDE_CONFIG_DIR`. */
export const CLAUDE_CODE_USUAL_FOLDER_TEXT = "Claude Code's usual folder";

/** Added when another Instafy account on this OS account also consented (4.5). */
export const CLAUDE_CODE_OTHER_ACCOUNT_TEXT =
  "Another Instafy account on this computer account also uses Claude Code. Claude Code turns run on whichever Claude sign-in this computer account has. Only continue if it is yours.";

export const CLAUDE_CODE_CONSENT_BUTTONS = Object.freeze(["Use Claude Code", "Cancel"] as const);

// The shared login-shell values a dialog lists below its text; never a
// `CLAUDE_CONFIG_DIR`, which a login's own line names.
function listShellValues(env: ClaudeCodeLoginShellEnv): string[] {
  const shellValues = CLAUDE_CODE_SHARED_ENV_KEYS.flatMap((key) => {
    const value = env[key];
    return value ? [`${key}=${value}`] : [];
  });
  return shellValues.length > 0 ? [`From your login shell:\n${shellValues.join("\n")}`] : [];
}

function consentDialog(
  message: string,
  text: string,
  otherAccounts: boolean,
  listed: readonly string[],
): DesktopExtensionMessageBoxOptions {
  return Object.freeze({
    type: "question" as const,
    message,
    detail: [text, ...(otherAccounts ? [CLAUDE_CODE_OTHER_ACCOUNT_TEXT] : []), ...listed].join("\n\n"),
    buttons: [...CLAUDE_CODE_CONSENT_BUTTONS],
    defaultId: 1,
    cancelId: 1,
  });
}

/**
 * The native dialog that confirms another program, or new login-shell
 * values, for every login while the lane is on, for the host context's own
 * account. Cancel is the default.
 */
export function buildClaudeCodeConsentDialog(options: {
  email: string;
  otherAccounts: boolean;
  binaryPath: string;
  env: ClaudeCodeLoginShellEnv;
}): DesktopExtensionMessageBoxOptions {
  return consentDialog(claudeCodeConsentQuestion(options.email), CLAUDE_CODE_CONSENT_TEXT, options.otherAccounts, [
    `Program: ${options.binaryPath}`,
    ...listShellValues(options.env),
  ]);
}

/**
 * One login's native consent dialog (consent version 3), for the host
 * context's own account. It names the login by the label the page gave,
 * quoted, and lists the program, the folder Desktop checked itself and the
 * shared login-shell values. Cancel is the default.
 */
export function buildClaudeCodeLoginConsentDialog(options: {
  email: string;
  label: string;
  otherAccounts: boolean;
  binaryPath: string;
  configDir: string | null;
  env: ClaudeCodeLoginShellEnv;
}): DesktopExtensionMessageBoxOptions {
  return consentDialog(
    claudeCodeLoginConsentQuestion(options.label, options.email),
    CLAUDE_CODE_LOGIN_CONSENT_TEXT,
    options.otherAccounts,
    [
      `Program: ${options.binaryPath}`,
      `Claude Code folder: ${options.configDir ?? CLAUDE_CODE_USUAL_FOLDER_TEXT}`,
      ...listShellValues(options.env),
    ],
  );
}
