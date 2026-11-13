import fs from "node:fs";
import os from "node:os";

import type {
  DesktopExtensionConsentStore,
  DesktopExtensionFeatureModule,
  DesktopExtensionHostContext,
  DesktopExtensionSession,
  DesktopRuntimeLaunchGrantRequest,
  DesktopRuntimeLaunchGrantValue,
} from "../desktopExtensionRegistry";
import {
  CLAUDE_CODE_LAUNCH_GRANT_ENV_KEYS,
  CLAUDE_CODE_LOCAL_ENGINE,
  buildClaudeCodeConsentDialog,
  buildClaudeCodeLaunchGrantEnv,
  parseClaudeCodeConsentRecord,
  type ClaudeCodeConsentRecord,
} from "./consent";
import {
  CLAUDE_CODE_DETECT_TIMEOUT_MS,
  CLAUDE_CODE_LOGIN_SHELL_ENV_KEYS,
  detectClaudeCode,
  runClaudeCodeLoginShell,
  type ClaudeCodeLoginShellEnv,
  type RunClaudeCodeLoginShellOptions,
} from "./detect";
import {
  MACOS_ADMIN_GROUP_ID,
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

/**
 * What every method returns. Paths show only on this computer and are never
 * sent to the controller. No method returns a login-shell value, only the
 * name of one Desktop can't use.
 */
export type ClaudeCodeDesktopStatus = Readonly<{
  /** macOS only in v1 (D18). Elsewhere nothing is detected, stored or granted. */
  supported: boolean;
  /** `path` is a program Desktop can use, with login-shell values it can use. */
  found: boolean;
  /** While the lane is on, the path in use; otherwise what Find or Locate turned up. */
  path?: string;
  consented: boolean;
  /** Why Desktop won't use `path`, or that Find found nothing. */
  problem?: ClaudeCodeDesktopProblem;
  /**
   * While the lane is on: another program Find or Locate turned up, or the
   * program in use itself (equal to `path`, with no `candidateProblem`) when
   * Find read login-shell values for it that Desktop can use in place of
   * recorded ones it no longer can. The path and values in use stay until
   * Use for my messages confirms this one.
   */
  candidatePath?: string;
  /** While the lane is on: why Desktop won't use `candidatePath`, or that Find found nothing. */
  candidateProblem?: ClaudeCodeDesktopProblem;
  /**
   * The login-shell variable a `shell_setting_unusable` problem is about:
   * `problem`'s when it is one, otherwise `candidateProblem`'s. Never its value.
   */
  shellSetting?: ClaudeCodeShellSetting;
}>;

type OsAccount = Readonly<{ username: string; homedir: string; shell: string | null }>;

type Candidate = Readonly<{
  /** Null when Find found nothing. */
  binaryPath: string | null;
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

const UNSUPPORTED: ClaudeCodeDesktopStatus = Object.freeze({
  supported: false,
  found: false,
  consented: false,
});

function defaultOsAccount(): OsAccount {
  const info = os.userInfo();
  return { username: info.username, homedir: info.homedir, shell: info.shell };
}

function defaultUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

/**
 * The Desktop side of local-engine turns: find the person's own `claude`,
 * ask for their consent in a native dialog, and grant the path to runtime
 * starts bound to their session. Studio reaches it only through
 * `instafy:desktopExtensionInvoke`; every key is the host context's
 * verified user, never anything in the payload.
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
  // What Find or Locate turned up, which Use for my messages confirms. Kept
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

  const readRecord = (host: DesktopExtensionHostContext): ClaudeCodeConsentRecord | null => {
    const record = parseClaudeCodeConsentRecord(host.consentStore?.read() ?? null);
    return record && record.osUser === osAccount().username ? record : null;
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

  // While the lane is on, what the last Find or Locate turned up, checked,
  // when it shows beside the program in use; null when it doesn't. Another
  // program, or nothing found, always shows. The program in use shows only
  // when Find read login-shell values for it that Desktop can use while the
  // recorded ones it no longer can (D26): Use for my messages then confirms
  // those through the consent dialog, as it would another program.
  const checkBesideInUse = (
    host: DesktopExtensionHostContext,
    record: ClaudeCodeConsentRecord,
    inUse: Check,
    candidate: Candidate,
  ): Check | null => {
    if (candidate.binaryPath !== record.binaryPath) {
      return check(host, candidate.binaryPath, candidate.env);
    }
    if (
      inUse.problem !== "shell_setting_unusable" ||
      CLAUDE_CODE_LOGIN_SHELL_ENV_KEYS.every((key) => candidate.env[key] === record.env[key])
    ) {
      return null;
    }
    const renewed = check(host, candidate.binaryPath, candidate.env);
    return renewed.problem ? null : renewed;
  };

  // While the lane is on, the path in use, and beside it what the last Find
  // or Locate turned up when that is anything else, or new login-shell values
  // the program in use needs; otherwise what Find or Locate turned up. So a
  // change the shell rolls back never shows as made, and a find that is not
  // in use never shows as in use.
  const answer = (
    host: DesktopExtensionHostContext,
    shown?: Candidate | null,
  ): ClaudeCodeDesktopStatus => {
    if (!supported) {
      return UNSUPPORTED;
    }
    const key = accountKey(host);
    const candidate = shown !== undefined ? shown : key ? candidates.get(key) ?? null : null;
    const record = readRecord(host);
    if (!record) {
      if (!candidate) {
        return Object.freeze({ supported: true, found: false, consented: false });
      }
      const checked = check(host, candidate.binaryPath, candidate.env);
      return Object.freeze({
        supported: true,
        found: !checked.problem,
        ...(candidate.binaryPath ? { path: candidate.binaryPath } : {}),
        consented: false,
        ...checked,
      });
    }
    const inUse = check(host, record.binaryPath, record.env);
    const otherCheck = candidate ? checkBesideInUse(host, record, inUse, candidate) : null;
    const other = otherCheck ? candidate : null;
    const shellSetting = inUse.shellSetting ?? otherCheck?.shellSetting;
    return Object.freeze({
      supported: true,
      found: !inUse.problem,
      path: record.binaryPath,
      consented: true,
      ...(inUse.problem ? { problem: inUse.problem } : {}),
      ...(other?.binaryPath ? { candidatePath: other.binaryPath } : {}),
      ...(otherCheck?.problem ? { candidateProblem: otherCheck.problem } : {}),
      ...(shellSetting ? { shellSetting } : {}),
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
              return answer(host, { binaryPath: chosen, pathEntries: [], env: {} });
            }
            const record = readRecord(host);
            if (record) {
              // A new path for a lane already on: the grant changes, so the
              // shell replaces the runtime that holds the old one. Use for my
              // messages now confirms this path, not an older find. Picking
              // the program in use keeps a find of that same program, whose
              // login-shell values may be what the record needs (D26).
              account.store.write({ ...record, binaryPath: chosen });
              if (chosen !== record.binaryPath || candidates.get(account.key)?.binaryPath !== chosen) {
                candidates.delete(account.key);
              }
              return answer(host);
            }
            // The picked program comes with the login shell's PATH and D26
            // values, as a found one does. Without a Find in this session,
            // read them now; a shell that fails leaves them empty, as for Find.
            const previous = candidates.get(account.key);
            const shell =
              previous ??
              (await runClaudeCodeLoginShell(loginShellOptions()).catch(() => null));
            candidates.set(
              account.key,
              Object.freeze({
                binaryPath: chosen,
                pathEntries: shell?.pathEntries ?? Object.freeze([]),
                env: shell?.env ?? Object.freeze({}),
              }),
            );
            return answer(host);
          },

          async enable(_payload: unknown, host: DesktopExtensionHostContext) {
            if (!supported) {
              return UNSUPPORTED;
            }
            const account = requireAccount(host);
            const email = account.session.email;
            if (!email) {
              throw new Error("Instafy couldn't read this account's email. Sign in again, then try again.");
            }
            const record = readRecord(host);
            const candidate = candidates.get(account.key);
            const chosen: Candidate | null = candidate?.binaryPath
              ? candidate
              : record
                ? { binaryPath: record.binaryPath, pathEntries: record.pathEntries, env: record.env }
                : null;
            if (!chosen?.binaryPath) {
              throw new Error("Find the claude program on this computer first.");
            }
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
            if (choice !== 0) {
              return answer(host);
            }
            account.store.write({
              binaryPath: chosen.binaryPath,
              pathEntries: [...chosen.pathEntries],
              env: { ...chosen.env },
              consentedAt: now().toISOString(),
              osUser: osAccount().username,
            });
            // The find stays: if the shell rolls this back, it can be
            // confirmed again without another Find.
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
