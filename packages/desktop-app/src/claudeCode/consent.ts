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
 * The version of the consent text a record was given for (11.13). A record
 * without it, or for another version, counts as not given: nobody's agents
 * run on Claude Code on words they did not see.
 */
export const CLAUDE_CODE_CONSENT_VERSION = 2;

/** What Desktop grants runtime-agent, and strips from every start (4.3). */
export const CLAUDE_CODE_LAUNCH_GRANT_ENV_KEYS = Object.freeze([
  "INSTAFY_CLAUDE_CODE_BIN",
  "INSTAFY_CLAUDE_CODE_PATH",
  "INSTAFY_CLAUDE_CODE_USER_ID",
  "INSTAFY_CLAUDE_CODE_ENV_JSON",
] as const);

/**
 * One person's consent on this computer, kept in Desktop's own config under
 * the controller origin and Instafy user id, and never sent anywhere (4.2).
 */
export type ClaudeCodeConsentRecord = Readonly<{
  /** The path the person confirmed, a symlink kept as a symlink. */
  binaryPath: string;
  /** Their login shell's PATH entries. */
  pathEntries: readonly string[];
  /** The D26 values their login shell had. */
  env: ClaudeCodeLoginShellEnv;
  consentedAt: string;
  /** The OS account that consented; a record copied to another account is void. */
  osUser: string;
  /** The consent text's version it was given for ({@link CLAUDE_CODE_CONSENT_VERSION}). */
  consentVersion: number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAbsoluteSingleLine(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && !hasControlCharacter(value);
}

export function parseClaudeCodeConsentRecord(value: unknown): ClaudeCodeConsentRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  const { binaryPath, pathEntries, env, consentedAt, osUser, consentVersion } = value;
  if (
    consentVersion !== CLAUDE_CODE_CONSENT_VERSION ||
    !isAbsoluteSingleLine(binaryPath) ||
    !Array.isArray(pathEntries) ||
    !pathEntries.every((entry) => isAbsoluteSingleLine(entry) && !entry.includes(":")) ||
    !isRecord(env) ||
    typeof consentedAt !== "string" ||
    Number.isNaN(Date.parse(consentedAt)) ||
    typeof osUser !== "string" ||
    osUser.length === 0
  ) {
    return null;
  }
  const parsedEnv: Partial<Record<ClaudeCodeLoginShellEnvKey, string>> = {};
  for (const [key, entry] of Object.entries(env)) {
    if (
      !(CLAUDE_CODE_LOGIN_SHELL_ENV_KEYS as readonly string[]).includes(key) ||
      typeof entry !== "string" ||
      entry.length === 0 ||
      hasControlCharacter(entry)
    ) {
      return null;
    }
    parsedEnv[key as ClaudeCodeLoginShellEnvKey] = entry;
  }
  return Object.freeze({
    binaryPath,
    pathEntries: Object.freeze([...(pathEntries as string[])]),
    env: Object.freeze(parsedEnv),
    consentedAt,
    osUser,
    consentVersion: CLAUDE_CODE_CONSENT_VERSION,
  });
}

/**
 * The values a consenting person's runtime start gets: the confirmed path, the
 * login shell's PATH entries (colon-separated, as PATH is), the Instafy user
 * the grant is for, and the D26 values as one JSON object.
 */
export function buildClaudeCodeLaunchGrantEnv(
  record: ClaudeCodeConsentRecord,
  instafyUserId: string,
): Record<(typeof CLAUDE_CODE_LAUNCH_GRANT_ENV_KEYS)[number], string> {
  const env: Partial<Record<ClaudeCodeLoginShellEnvKey, string>> = {};
  for (const key of CLAUDE_CODE_LOGIN_SHELL_ENV_KEYS) {
    const value = record.env[key];
    if (value) {
      env[key] = value;
    }
  }
  return {
    INSTAFY_CLAUDE_CODE_BIN: record.binaryPath,
    INSTAFY_CLAUDE_CODE_PATH: record.pathEntries.join(":"),
    INSTAFY_CLAUDE_CODE_USER_ID: instafyUserId,
    INSTAFY_CLAUDE_CODE_ENV_JSON: JSON.stringify(env),
  };
}

export function claudeCodeConsentQuestion(email: string): string {
  return `Use Claude Code on this computer for ${email}?`;
}

/** The consent dialog's text (docs/Local-Engine-Turns.md 11.13). */
export const CLAUDE_CODE_CONSENT_TEXT =
  "Instafy Desktop will start the claude program on this computer, signed in the way you signed in to it yourself, for the turns of your agents whose AI you set to Claude Code: your messages to them, and the turns they take while you're away, such as their automations and their next steps toward a goal, whenever this computer runs the space. It runs under Anthropic's current terms, and that sign-in may bill your Claude plan or your own API or cloud account. Only your own agents' turns run here, one at a time, never anyone else's. Instafy gives Claude Code the words of each turn: your message, or what Instafy wrote for that turn, such as an automation's prompt. Everyone in the space can read the steps it takes and its replies. Claude Code uses your own Claude Code settings, including what you've allowed it to run without asking, except that it changes files without asking, whatever your own setting says, in this space's folder and in any other folder your Claude Code settings let it work in, and skips anything else that would need your OK. It can also write to Claude Code's memory for this folder, which your later Claude Code sessions here load, in Instafy or in a terminal. What others wrote in this space's files can steer it within those settings, also in turns nobody watches: it may copy files kept only on this computer, such as .env, into its reply or into files saved to the space, run the space's code through commands or hooks you've allowed, and put their words into that memory, where your later sessions read them. Instafy never reads, stores or sends your Claude sign-in. Only turn this on if the Claude account signed in on this computer account is yours.";

/** Added when another Instafy account on this OS account also consented (4.5). */
export const CLAUDE_CODE_OTHER_ACCOUNT_TEXT =
  "Another Instafy account on this computer account also uses Claude Code. Claude Code turns run on whichever Claude sign-in this computer account has. Only continue if it is yours.";

export const CLAUDE_CODE_CONSENT_BUTTONS = Object.freeze(["Use Claude Code", "Cancel"] as const);

/** The native consent dialog for the host context's own account. Cancel is the default. */
export function buildClaudeCodeConsentDialog(options: {
  email: string;
  otherAccounts: boolean;
  binaryPath: string;
  env: ClaudeCodeLoginShellEnv;
}): DesktopExtensionMessageBoxOptions {
  const listed = [`Program: ${options.binaryPath}`];
  const shellValues = CLAUDE_CODE_LOGIN_SHELL_ENV_KEYS.flatMap((key) => {
    const value = options.env[key];
    return value ? [`${key}=${value}`] : [];
  });
  if (shellValues.length > 0) {
    listed.push(`From your login shell:\n${shellValues.join("\n")}`);
  }
  return Object.freeze({
    type: "question" as const,
    message: claudeCodeConsentQuestion(options.email),
    detail: [
      CLAUDE_CODE_CONSENT_TEXT,
      ...(options.otherAccounts ? [CLAUDE_CODE_OTHER_ACCOUNT_TEXT] : []),
      ...listed,
    ].join("\n\n"),
    buttons: [...CLAUDE_CODE_CONSENT_BUTTONS],
    defaultId: 1,
    cancelId: 1,
  });
}
