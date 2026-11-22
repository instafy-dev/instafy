import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  DesktopExtensionConsentStore,
  DesktopExtensionFeatureModule,
  DesktopExtensionHostContext,
  DesktopExtensionSession,
  DesktopRuntimeLaunchGrantRequest,
  DesktopRuntimeLaunchGrantValue,
} from "../desktopExtensionRegistry";
import {
  CLAUDE_CODE_CONSENT_VERSION,
  CLAUDE_CODE_LAUNCH_GRANT_ENV_KEYS,
  CLAUDE_CODE_LOCAL_ENGINE,
  CLAUDE_CODE_MAX_LOGINS,
  CLAUDE_CODE_SHARED_ENV_KEYS,
  buildClaudeCodeConsentDialog,
  buildClaudeCodeLaunchGrantEnv,
  buildClaudeCodeLoginConsentDialog,
  claudeCodeSharedEnv,
  parseClaudeCodeConsentRecord,
  parseClaudeCodeLoginId,
  parseClaudeCodeLoginLabel,
  type ClaudeCodeConsentLogin,
  type ClaudeCodeConsentRecord,
} from "./consent";
import {
  CLAUDE_CODE_DETECT_TIMEOUT_MS,
  detectClaudeCode,
  runClaudeCodeLoginShell,
  type ClaudeCodeLoginShellEnv,
  type RunClaudeCodeLoginShellOptions,
} from "./detect";
import {
  MACOS_ADMIN_GROUP_ID,
  checkClaudeCodeConfigFolder,
  claudeCodeFolderRealPath,
  findUnusableClaudeCodeShellSetting,
  validateClaudeCodeBinary,
  type ClaudeCodeBinaryProblem,
  type ClaudeCodeFileSystem,
  type ClaudeCodeShellSetting,
} from "./validate";

export const CLAUDE_CODE_DESKTOP_FEATURE_MODULE_ID = "instafy.claude-code";
/** The id Studio passes to `invokeDesktopExtension`. */
export const CLAUDE_CODE_DESKTOP_EXTENSION_ID = "claude-code";
export const CLAUDE_CODE_LAUNCH_GRANT_ID = "claude-code";

/**
 * Why Desktop won't use a program: its own problem, nothing found, or a
 * login-shell value it can't use with it (D26).
 */
export type ClaudeCodeDesktopProblem =
  | ClaudeCodeBinaryProblem
  | "not_found"
  | "shell_setting_unusable";

/** One of this account's consented logins on this computer, as every method lists it (11.19). */
export type ClaudeCodeDesktopLogin = Readonly<{
  /** The controller's id for the login. */
  id: string;
  /** Its Claude Code folder; null for Claude Code's usual folder. */
  folder: string | null;
  /**
   * Why its folder no longer passes the checks a `CLAUDE_CONFIG_DIR` gets
   * (D26), which makes that login, and only it, not ready on this computer.
   */
  problem?: ClaudeCodeDesktopProblem;
}>;

/**
 * What every method returns. Paths, a login's folder among them, show only
 * on this computer and are never sent to the controller. No method returns
 * any other login-shell value, only the name of one Desktop can't use.
 */
export type ClaudeCodeDesktopStatus = Readonly<{
  /** macOS only in v1 (D18). Elsewhere nothing is detected, stored or granted. */
  supported: boolean;
  /** `path` is a program Desktop can use, with login-shell values it can use. */
  found: boolean;
  /** While the lane is on, the path in use; otherwise what Find or Locate turned up. */
  path?: string;
  /** At least one login has this account's consent on this computer, for the current words. */
  consented: boolean;
  /** Why Desktop won't use `path`, or that Find found nothing. */
  problem?: ClaudeCodeDesktopProblem;
  /**
   * While the lane is on: another program Find or Locate turned up, or the
   * program in use itself (equal to `path`, with no `candidateProblem`) when
   * Find read login-shell values for it that Desktop can use in place of
   * recorded ones it no longer can. Such a Find turned up that program or,
   * as for an alias, no program at all; one that turned up another copy, in
   * the usual folders too, shows that copy instead. The path and values in
   * use stay until Use Claude Code on this computer confirms this one.
   */
  candidatePath?: string;
  /** While the lane is on: why Desktop won't use `candidatePath`, or that Find found nothing. */
  candidateProblem?: ClaudeCodeDesktopProblem;
  /**
   * The login-shell variable a `shell_setting_unusable` problem is about:
   * `problem`'s when it is one, otherwise `candidateProblem`'s. Never its value.
   * While the lane is on it is only ever `NODE_EXTRA_CA_CERTS`: a login's
   * folder is its own, and a Find's `CLAUDE_CONFIG_DIR` changes none.
   */
  shellSetting?: ClaudeCodeShellSetting;
  /** This account's consented logins on this computer, in the order they were set up. */
  logins: readonly ClaudeCodeDesktopLogin[];
}>;

type OsAccount = Readonly<{ username: string; homedir: string; shell: string | null }>;

type Candidate = Readonly<{
  /** Null when Find found no program, though its login shell may have answered. */
  binaryPath: string | null;
  pathEntries: readonly string[];
  env: ClaudeCodeLoginShellEnv;
  /**
   * Whether `pathEntries` and `env` are a login shell's answer. A shell that
   * gave none leaves them empty, which says nothing about the person's
   * settings, so such a find never stands for new values.
   */
  shellAnswered: boolean;
}>;

/** What Use Claude Code on this computer records: a program, with the PATH entries and values it runs with. */
type Choice = Readonly<{
  binaryPath: string;
  pathEntries: readonly string[];
  env: ClaudeCodeLoginShellEnv;
}>;

type Check = Readonly<{
  problem?: ClaudeCodeDesktopProblem;
  shellSetting?: ClaudeCodeShellSetting;
}>;

type Account = Readonly<{
  key: string;
  session: DesktopExtensionSession;
  store: DesktopExtensionConsentStore;
}>;

/** A login the page names: its id and name from the controller, never a path. */
type LoginRequest = Readonly<{ id: string; label: string }>;

export type ClaudeCodeDesktopFeatureOptions = {
  platform?: NodeJS.Platform;
  fs?: ClaudeCodeFileSystem;
  uid?: () => number;
  adminGroupId?: number | null;
  osAccount?: () => OsAccount;
  lang?: () => string | undefined;
  etcShellsPath?: string;
  detectTimeoutMs?: number;
  now?: () => Date;
};

const NO_LOGINS: readonly ClaudeCodeDesktopLogin[] = Object.freeze([]);

const UNSUPPORTED: ClaudeCodeDesktopStatus = Object.freeze({
  supported: false,
  found: false,
  consented: false,
  logins: NO_LOGINS,
});

/** Where Claude Code keeps its settings and sign-in with no `CLAUDE_CONFIG_DIR`, in the home folder. */
const CLAUDE_CODE_USUAL_FOLDER_NAME = ".claude";

/** The folder picker's words (11.19). */
const PICK_FOLDER_TEXT = "Choose the Claude Code folder you signed in to";

// Why Desktop won't take a chosen folder as a login's, in the words Studio
// uses for the program (docs/Local-Engine-Turns.md 5.4).
const CHOOSE_AGAIN = "Choose the Claude Code folder you signed in to.";
const FOLDER_REFUSALS: Readonly<Record<ClaudeCodeBinaryProblem, string>> = Object.freeze({
  relative_path: `Instafy Desktop can't use this folder. ${CHOOSE_AGAIN}`,
  missing: `Instafy Desktop can't find this folder. ${CHOOSE_AGAIN}`,
  not_a_file: `This isn't a folder. ${CHOOSE_AGAIN}`,
  not_executable: `Instafy Desktop can't use this folder. ${CHOOSE_AGAIN}`,
  too_many_links: `Instafy Desktop can't use this folder. ${CHOOSE_AGAIN}`,
  foreign_owner:
    "Other accounts on this computer can change this folder, so Instafy Desktop won't use it. Choose a folder only you can change.",
  writable_by_others:
    "Other accounts on this computer can change this folder, so Instafy Desktop won't use it. Choose a folder only you can change.",
  inside_instafy_folder: `This folder is inside a folder Instafy uses, so Instafy Desktop won't use it. ${CHOOSE_AGAIN}`,
});

function defaultOsAccount(): OsAccount {
  const info = os.userInfo();
  return { username: info.username, homedir: info.homedir, shell: info.shell };
}

function defaultUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

function payloadFields(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

// A page's login id, or a plain sentence for anything else. Nothing has been
// asked or written when this refuses.
function requireLoginId(payload: unknown): string {
  const id = parseClaudeCodeLoginId(payloadFields(payload).loginId);
  if (!id) {
    throw new Error("Instafy couldn't tell which Claude Code login this is. Reload the page, then try again.");
  }
  return id;
}

function requireLogin(payload: unknown): LoginRequest {
  const id = requireLoginId(payload);
  const label = parseClaudeCodeLoginLabel(payloadFields(payload).label);
  if (!label) {
    // A name the controller keeps can still hold a double quote or an
    // invisible character, which Desktop won't show in its dialog.
    throw new Error(
      "A Claude Code login's name must be 1 to 60 characters on one line, with no double quotes or invisible characters. Rename the login, then try again.",
    );
  }
  return Object.freeze({ id, label });
}

function requireFolderChoice(payload: unknown): "usual" | "choose" {
  const folder = payloadFields(payload).folder;
  if (folder !== "usual" && folder !== "choose") {
    throw new Error("Choose Claude Code's usual folder or another folder for this login.");
  }
  return folder;
}

/**
 * The Desktop side of local-engine turns: find the person's own `claude`,
 * ask for their consent to each of their Claude Code logins in a native
 * dialog, and grant the program and those logins to runtime starts bound to
 * their session. Studio reaches it only through
 * `instafy:desktopExtensionInvoke`; every key is the host context's
 * verified user, never anything in the payload, and the payload never names
 * a path.
 */
export function createClaudeCodeDesktopFeatureModule(
  options: ClaudeCodeDesktopFeatureOptions = {},
): DesktopExtensionFeatureModule {
  const supported = (options.platform ?? process.platform) === "darwin";
  const files = options.fs ?? fs;
  const uid = options.uid ?? defaultUid;
  const adminGroupId =
    options.adminGroupId === undefined ? MACOS_ADMIN_GROUP_ID : options.adminGroupId;
  const osAccount = options.osAccount ?? defaultOsAccount;
  const lang = options.lang ?? (() => process.env.LANG);
  const now = options.now ?? (() => new Date());
  // What Find or Locate turned up, which Use Claude Code on this computer confirms. Kept
  // in memory per controller and user: a found path is not a consent.
  const candidates = new Map<string, Candidate>();

  const accountKey = (host: DesktopExtensionHostContext): string | null =>
    host.session && host.controllerOrigin
      ? `${host.controllerOrigin}\n${host.session.userId}`
      : null;

  const requireAccount = (host: DesktopExtensionHostContext): Account => {
    if (!host.session) {
      throw new Error("Sign in to Instafy in this window, then try again.");
    }
    const key = accountKey(host);
    if (!key || !host.consentStore) {
      // Only an unpackaged build that has started no space yet gets here.
      throw new Error("Start a space on this computer, then try again.");
    }
    return Object.freeze({ key, session: host.session, store: host.consentStore });
  };

  // The account a consent dialog names (4.2).
  const requireEmail = (account: Account): string => {
    const email = account.session.email;
    if (!email) {
      throw new Error("Instafy couldn't read this account's email. Sign in again, then try again.");
    }
    return email;
  };

  const readRecord = (host: DesktopExtensionHostContext): ClaudeCodeConsentRecord | null => {
    const record = parseClaudeCodeConsentRecord(host.consentStore?.read() ?? null);
    return record && record.osUser === osAccount().username ? record : null;
  };

  // Every key spelled out, so a record is written in exactly the shape that
  // is read back.
  const writeRecord = (account: Account, record: ClaudeCodeConsentRecord): void => {
    account.store.write({
      binaryPath: record.binaryPath,
      pathEntries: [...record.pathEntries],
      env: { ...claudeCodeSharedEnv(record.env) },
      osUser: record.osUser,
      logins: record.logins.map((login) => ({
        id: login.id,
        configDir: login.configDir,
        consentedAt: login.consentedAt,
        consentVersion: login.consentVersion,
      })),
    });
  };

  const loginShellOptions = (): RunClaudeCodeLoginShellOptions => {
    const account = osAccount();
    return {
      shell: account.shell,
      homeDir: account.homedir,
      user: account.username,
      lang: lang(),
      etcShellsPath: options.etcShellsPath,
      timeoutMs: options.detectTimeoutMs ?? CLAUDE_CODE_DETECT_TIMEOUT_MS,
    };
  };

  // Whether a turn could use this program with these login-shell values, by
  // the checks runtime-agent repeats before every turn (3.2, D26).
  const check = (
    host: DesktopExtensionHostContext,
    binaryPath: string | null,
    env: ClaudeCodeLoginShellEnv,
  ): Check => {
    if (!binaryPath) {
      return { problem: "not_found" };
    }
    const validation = validateClaudeCodeBinary(binaryPath, {
      uid: uid(),
      adminGroupId,
      desktopOwnedPaths: host.desktopOwnedPaths,
      caseInsensitivePaths: true,
      fs: files,
    });
    if (!validation.ok) {
      return { problem: validation.problem };
    }
    const shellSetting = findUnusableClaudeCodeShellSetting(env, {
      uid: uid(),
      desktopOwnedPaths: host.desktopOwnedPaths,
      caseInsensitivePaths: true,
      fs: files,
    });
    return shellSetting ? { problem: "shell_setting_unusable", shellSetting } : {};
  };

  // Why a login's folder would make its turns refuse, by the checks
  // runtime-agent gives the `CLAUDE_CONFIG_DIR` it starts that login with
  // (11.19); null when it passes. It looks only at the folder and the links
  // on the way to it, never inside.
  const folderProblem = (
    host: DesktopExtensionHostContext,
    folder: string,
  ): ClaudeCodeBinaryProblem | null => {
    const checked = checkClaudeCodeConfigFolder(folder, {
      uid: uid(),
      desktopOwnedPaths: host.desktopOwnedPaths,
      caseInsensitivePaths: true,
      fs: files,
    });
    return checked.ok ? null : checked.problem;
  };

  // Which folder a login really uses, to tell two logins that share one
  // apart from two that don't: its links followed, and its name compared
  // ignoring case, as macOS compares folder names. The usual folder is
  // Claude Code's own ~/.claude, so a login whose folder is that one by its
  // path uses the usual folder too, and the usual folder counts once.
  const folderIdentity = (configDir: string | null): string =>
    claudeCodeFolderRealPath(
      configDir ?? path.join(osAccount().homedir, CLAUDE_CODE_USUAL_FOLDER_NAME),
      files,
    ).toLowerCase();

  // A login this record can't take, whatever its folder: one already set up
  // here, or one past the most a grant carries.
  const refuseLoginSetUp = (record: ClaudeCodeConsentRecord, id: string): void => {
    if (record.logins.some((login) => login.id === id)) {
      throw new Error("This login is already set up on this computer.");
    }
    if (record.logins.length >= CLAUDE_CODE_MAX_LOGINS) {
      throw new Error(
        `This computer already has ${CLAUDE_CODE_MAX_LOGINS} of your Claude Code logins. Remove one from this computer, then try again.`,
      );
    }
  };

  // Each login is a folder of its own: two that shared one would share its
  // sign-in, settings and sessions.
  const refuseFolderInUse = (record: ClaudeCodeConsentRecord, configDir: string | null): void => {
    const wanted = folderIdentity(configDir);
    if (record.logins.some((login) => folderIdentity(login.configDir) === wanted)) {
      throw new Error(
        configDir === null
          ? "Another of your Claude Code logins on this computer already uses Claude Code's usual folder."
          : "Another of your Claude Code logins on this computer already uses this folder. Choose another one.",
      );
    }
  };

  // The record with one more login, given consent now. It is checked again
  // against the record as it is once the dialog closed, since another call
  // may have changed it meanwhile.
  const withLogin = (
    record: ClaudeCodeConsentRecord,
    login: ClaudeCodeConsentLogin,
  ): ClaudeCodeConsentRecord => {
    refuseLoginSetUp(record, login.id);
    refuseFolderInUse(record, login.configDir);
    return Object.freeze({ ...record, logins: Object.freeze([...record.logins, login]) });
  };

  const consentedLogin = (id: string, configDir: string | null): ClaudeCodeConsentLogin =>
    Object.freeze({
      id,
      configDir,
      consentedAt: now().toISOString(),
      consentVersion: CLAUDE_CODE_CONSENT_VERSION,
    });

  // While the lane is on, only the login-shell values every login shares
  // count: a login's folder is its own, so a Find's `CLAUDE_CONFIG_DIR` is
  // neither offered nor checked, and changes no login.
  const sharedCandidate = (candidate: Candidate): Candidate =>
    Object.freeze({ ...candidate, env: claudeCodeSharedEnv(candidate.env) });

  // While the lane is on, what the last Find or Locate turned up, checked,
  // when it shows beside the program in use; null when it doesn't. Another
  // program, or nothing found, always shows. The program in use shows only
  // when Find read login-shell values for it that Desktop can use while the
  // recorded ones it no longer can (D26): Use Claude Code on this computer then confirms
  // those through the consent dialog, as it would another program. A Find
  // that turned up no program, as for an alias, but whose login shell
  // answered read values for the program in use all the same. A shell that
  // gave no answer read none, so its find never stands for new values. The
  // candidate's values are the shared ones ({@link sharedCandidate}).
  const checkBesideInUse = (
    host: DesktopExtensionHostContext,
    record: ClaudeCodeConsentRecord,
    inUse: Check,
    candidate: Candidate,
  ): Check | null => {
    const valuesOnly = candidate.binaryPath === null && candidate.shellAnswered;
    if (candidate.binaryPath !== record.binaryPath && !valuesOnly) {
      return check(host, candidate.binaryPath, candidate.env);
    }
    // A find of no program that renews nothing still shows that it found none.
    const nothingNew: Check | null = valuesOnly ? { problem: "not_found" } : null;
    if (
      !candidate.shellAnswered ||
      inUse.problem !== "shell_setting_unusable" ||
      CLAUDE_CODE_SHARED_ENV_KEYS.every((key) => candidate.env[key] === record.env[key])
    ) {
      return nothingNew;
    }
    const renewed = check(host, record.binaryPath, candidate.env);
    return renewed.problem ? nothingNew : renewed;
  };

  // What Use Claude Code on this computer confirms while the lane is on:
  // another program the last Find or Locate turned up, or new login-shell
  // values for the program in use when the answer offers them; otherwise the
  // record as it is, so nothing the answer did not offer is ever confirmed in
  // its place. It changes the program and shared values of every login, and
  // no login.
  const renewal = (
    host: DesktopExtensionHostContext,
    record: ClaudeCodeConsentRecord,
    found: Candidate | undefined,
  ): Choice => {
    const candidate = found ? sharedCandidate(found) : undefined;
    if (candidate?.binaryPath && candidate.binaryPath !== record.binaryPath) {
      return { binaryPath: candidate.binaryPath, pathEntries: candidate.pathEntries, env: candidate.env };
    }
    if (candidate) {
      const renewed = checkBesideInUse(host, record, check(host, record.binaryPath, record.env), candidate);
      if (renewed && !renewed.problem) {
        return { binaryPath: record.binaryPath, pathEntries: candidate.pathEntries, env: candidate.env };
      }
    }
    return record;
  };

  // Each consented login, with its folder and, when the folder no longer
  // passes its checks, why.
  const describeLogins = (
    host: DesktopExtensionHostContext,
    record: ClaudeCodeConsentRecord,
  ): readonly ClaudeCodeDesktopLogin[] =>
    Object.freeze(
      record.logins.map((login) => {
        const problem = login.configDir === null ? null : folderProblem(host, login.configDir);
        return Object.freeze({ id: login.id, folder: login.configDir, ...(problem ? { problem } : {}) });
      }),
    );

  // While the lane is on, the path in use, and beside it what the last Find
  // or Locate turned up when that is anything else, or new login-shell values
  // the program in use needs; otherwise what Find or Locate turned up, whose
  // login shell's `CLAUDE_CONFIG_DIR` is checked as the first login's folder.
  // So a change the shell rolls back never shows as made, and a find that is
  // not in use never shows as in use.
  const answer = (
    host: DesktopExtensionHostContext,
    shown?: Candidate | null,
  ): ClaudeCodeDesktopStatus => {
    if (!supported) {
      return UNSUPPORTED;
    }
    const key = accountKey(host);
    const found = shown !== undefined ? shown : key ? candidates.get(key) ?? null : null;
    const record = readRecord(host);
    if (!record) {
      if (!found) {
        return Object.freeze({ supported: true, found: false, consented: false, logins: NO_LOGINS });
      }
      const checked = check(host, found.binaryPath, found.env);
      return Object.freeze({
        supported: true,
        found: !checked.problem,
        ...(found.binaryPath ? { path: found.binaryPath } : {}),
        consented: false,
        ...checked,
        logins: NO_LOGINS,
      });
    }
    const candidate = found ? sharedCandidate(found) : null;
    const inUse = check(host, record.binaryPath, record.env);
    const otherCheck = candidate ? checkBesideInUse(host, record, inUse, candidate) : null;
    // New values from a find of no program show as the program in use.
    const otherPath =
      candidate && otherCheck
        ? candidate.binaryPath ?? (otherCheck.problem ? null : record.binaryPath)
        : null;
    const shellSetting = inUse.shellSetting ?? otherCheck?.shellSetting;
    return Object.freeze({
      supported: true,
      found: !inUse.problem,
      path: record.binaryPath,
      consented: true,
      ...(inUse.problem ? { problem: inUse.problem } : {}),
      ...(otherPath ? { candidatePath: otherPath } : {}),
      ...(otherCheck?.problem ? { candidateProblem: otherCheck.problem } : {}),
      ...(shellSetting ? { shellSetting } : {}),
      logins: describeLogins(host, record),
    });
  };

  return Object.freeze({
    apiVersion: 1 as const,
    id: CLAUDE_CODE_DESKTOP_FEATURE_MODULE_ID,
    desktopExtensions: Object.freeze([
      Object.freeze({
        id: CLAUDE_CODE_DESKTOP_EXTENSION_ID,
        methods: Object.freeze({
          status: (_payload: unknown, host: DesktopExtensionHostContext) => answer(host),

          async detect(_payload: unknown, host: DesktopExtensionHostContext) {
            if (!supported) {
              return UNSUPPORTED;
            }
            const account = requireAccount(host);
            const detection = await detectClaudeCode({
              ...loginShellOptions(),
              lstat: (file) => files.lstatSync(file),
            });
            candidates.set(
              account.key,
              Object.freeze({
                binaryPath: detection.binaryPath,
                pathEntries: detection.pathEntries,
                env: detection.env,
                shellAnswered: detection.shellAnswered,
              }),
            );
            return answer(host);
          },

          async locate(_payload: unknown, host: DesktopExtensionHostContext) {
            if (!supported) {
              return UNSUPPORTED;
            }
            const account = requireAccount(host);
            const chosen = await host.dialogs.pickFile({
              title: "Locate the claude program",
              buttonLabel: "Use This File",
            });
            if (!chosen) {
              return answer(host);
            }
            const picked = check(host, chosen, {});
            if (picked.problem) {
              // A pick Desktop can't use changes nothing; only this answer shows it.
              return answer(host, { binaryPath: chosen, pathEntries: [], env: {}, shellAnswered: false });
            }
            const record = readRecord(host);
            const previous = candidates.get(account.key);
            if (record) {
              // A new path for a lane already on: the grant changes, so the
              // shell replaces the runtime that holds the old one. Use for my
              // messages now confirms this path, not an older find. Picking
              // the program in use keeps a find of that same program, or of
              // no program whose login shell answered, either of whose
              // login-shell values may be what the record needs (D26).
              writeRecord(account, { ...record, binaryPath: chosen });
              const keepsFind =
                chosen === record.binaryPath &&
                previous !== undefined &&
                (previous.binaryPath === chosen || (previous.binaryPath === null && previous.shellAnswered));
              if (!keepsFind) {
                candidates.delete(account.key);
              }
              return answer(host);
            }
            // The picked program comes with the login shell's PATH and D26
            // values, as a found one does. Without a Find in this session,
            // read them now; a shell that fails leaves them empty, as for Find.
            const shell =
              previous ??
              (await runClaudeCodeLoginShell(loginShellOptions()).catch(() => null));
            candidates.set(
              account.key,
              Object.freeze({
                binaryPath: chosen,
                pathEntries: shell?.pathEntries ?? Object.freeze([]),
                env: shell?.env ?? Object.freeze({}),
                shellAnswered: previous ? previous.shellAnswered : shell !== null,
              }),
            );
            return answer(host);
          },

          /**
           * With no record, `{loginId, label}`: the native consent dialog for
           * the person's first login, in the folder the latest Find or
           * Locate read from the login shell's `CLAUDE_CONFIG_DIR`, or the
           * usual folder when it set none; on OK, the record with that one
           * login. While the lane is on it needs no payload: it confirms
           * another program or new login-shell values for every login, as
           * before logins (4.1), and never adds a login.
           */
          async enable(payload: unknown, host: DesktopExtensionHostContext) {
            if (!supported) {
              return UNSUPPORTED;
            }
            const account = requireAccount(host);
            const email = requireEmail(account);
            const record = readRecord(host);
            const candidate = candidates.get(account.key);
            if (record) {
              const chosen = renewal(host, record, candidate);
              // Nobody is asked about a program, or a login-shell value, that
              // would make every turn refuse; the answer says why.
              if (check(host, chosen.binaryPath, chosen.env).problem) {
                return answer(host);
              }
              const choice = await host.dialogs.showMessageBox(
                buildClaudeCodeConsentDialog({
                  email,
                  otherAccounts: account.store.hasOtherAccounts(),
                  binaryPath: chosen.binaryPath,
                  env: chosen.env,
                }),
              );
              // The record as it is now, so a login added or removed while
              // the dialog was open stays added or removed; none, if the lane
              // was turned off meanwhile.
              const current = choice === 0 ? readRecord(host) : null;
              if (current) {
                writeRecord(account, {
                  ...current,
                  binaryPath: chosen.binaryPath,
                  pathEntries: chosen.pathEntries,
                  env: claudeCodeSharedEnv(chosen.env),
                });
              }
              // The find stays: if the shell rolls this back, it can be
              // confirmed again without another Find.
              return answer(host);
            }
            const login = requireLogin(payload);
            if (!candidate?.binaryPath) {
              throw new Error("Find the claude program on this computer first.");
            }
            // The login shell's `CLAUDE_CONFIG_DIR` is checked here as the
            // first login's folder, with the program and the other values.
            if (check(host, candidate.binaryPath, candidate.env).problem) {
              return answer(host);
            }
            const configDir = candidate.env.CLAUDE_CONFIG_DIR ?? null;
            const env = claudeCodeSharedEnv(candidate.env);
            const choice = await host.dialogs.showMessageBox(
              buildClaudeCodeLoginConsentDialog({
                email,
                label: login.label,
                otherAccounts: account.store.hasOtherAccounts(),
                binaryPath: candidate.binaryPath,
                configDir,
                env,
              }),
            );
            if (choice !== 0) {
              return answer(host);
            }
            const consented = consentedLogin(login.id, configDir);
            // Turned on meanwhile by another call: this login joins that
            // record, as Add a login would add it.
            const current = readRecord(host);
            writeRecord(
              account,
              current
                ? withLogin(current, consented)
                : Object.freeze({
                    binaryPath: candidate.binaryPath,
                    pathEntries: candidate.pathEntries,
                    env,
                    osUser: osAccount().username,
                    logins: Object.freeze([consented]),
                  }),
            );
            return answer(host);
          },

          /**
           * `{loginId, label, folder: "usual" | "choose"}`, while the lane is
           * on: set up another of the person's logins on this computer, a new
           * one or one they set up on another computer. `choose` opens a
           * native folder picker; the folder is checked as a
           * `CLAUDE_CONFIG_DIR` is, and refused when another of this
           * account's logins here uses it. Then the native consent dialog
           * for that login, and on OK the record with it added.
           */
          async addLogin(payload: unknown, host: DesktopExtensionHostContext) {
            if (!supported) {
              return UNSUPPORTED;
            }
            const account = requireAccount(host);
            const email = requireEmail(account);
            const login = requireLogin(payload);
            const folder = requireFolderChoice(payload);
            const record = readRecord(host);
            if (!record) {
              throw new Error("Turn on Claude Code on this computer first.");
            }
            refuseLoginSetUp(record, login.id);
            // As for Use Claude Code on this computer, nobody is asked about
            // a login whose turns would refuse for the program; the answer
            // says why.
            if (check(host, record.binaryPath, record.env).problem) {
              return answer(host);
            }
            let configDir: string | null = null;
            if (folder === "choose") {
              const chosen = await host.dialogs.pickFolder({
                title: PICK_FOLDER_TEXT,
                message: PICK_FOLDER_TEXT,
                buttonLabel: "Use This Folder",
                defaultPath: osAccount().homedir,
              });
              if (!chosen) {
                return answer(host);
              }
              const problem = folderProblem(host, chosen);
              if (problem) {
                throw new Error(FOLDER_REFUSALS[problem]);
              }
              configDir = chosen;
            }
            refuseFolderInUse(record, configDir);
            const choice = await host.dialogs.showMessageBox(
              buildClaudeCodeLoginConsentDialog({
                email,
                label: login.label,
                otherAccounts: account.store.hasOtherAccounts(),
                binaryPath: record.binaryPath,
                configDir,
                env: record.env,
              }),
            );
            if (choice !== 0) {
              return answer(host);
            }
            const current = readRecord(host);
            if (!current) {
              throw new Error("Turn on Claude Code on this computer first.");
            }
            writeRecord(account, withLogin(current, consentedLogin(login.id, configDir)));
            return answer(host);
          },

          /**
           * `{loginId}`: remove that login's consent on this computer.
           * Removing the last one removes the record, as `disable` does.
           */
          removeLogin(payload: unknown, host: DesktopExtensionHostContext) {
            const account = requireAccount(host);
            const id = requireLoginId(payload);
            const record = readRecord(host);
            const remaining = record?.logins.filter((login) => login.id !== id) ?? [];
            if (record && remaining.length === 0) {
              account.store.remove();
            } else if (record && remaining.length < record.logins.length) {
              writeRecord(account, { ...record, logins: Object.freeze(remaining) });
            }
            return answer(host);
          },

          disable(_payload: unknown, host: DesktopExtensionHostContext) {
            requireAccount(host).store.remove();
            return answer(host);
          },
        }),
        // A status read waits for any consent change before it to settle, so
        // it never shows a change the person kept from being made (4.3).
        readOnlyMethods: Object.freeze(["status"]),
      }),
    ]),
    desktopRuntimeLaunchGrants: Object.freeze([
      Object.freeze({
        id: CLAUDE_CODE_LAUNCH_GRANT_ID,
        protectedEnvKeys: CLAUDE_CODE_LAUNCH_GRANT_ENV_KEYS,
        resolve(request: DesktopRuntimeLaunchGrantRequest): DesktopRuntimeLaunchGrantValue | null {
          if (!supported) {
            return null;
          }
          const record = parseClaudeCodeConsentRecord(request.consent);
          if (!record || record.osUser !== osAccount().username) {
            return null;
          }
          return Object.freeze({
            env: buildClaudeCodeLaunchGrantEnv(record, request.instafyUserId),
            localEngine: CLAUDE_CODE_LOCAL_ENGINE,
          });
        },
      }),
    ]),
  });
}

export const CLAUDE_CODE_DESKTOP_FEATURE_MODULE = createClaudeCodeDesktopFeatureModule();
