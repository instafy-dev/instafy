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
  detectClaudeCode,
  type ClaudeCodeLoginShellEnv,
} from "./detect";
import {
  MACOS_ADMIN_GROUP_ID,
  validateClaudeCodeBinary,
  type ClaudeCodeBinaryProblem,
  type ClaudeCodeFileSystem,
} from "./validate";

export const CLAUDE_CODE_DESKTOP_FEATURE_MODULE_ID = "instafy.claude-code";
/** The id Studio passes to `invokeDesktopExtension`. */
export const CLAUDE_CODE_DESKTOP_EXTENSION_ID = "claude-code";
export const CLAUDE_CODE_LAUNCH_GRANT_ID = "claude-code";

/**
 * What every method returns. The path shows only on this computer and is
 * never sent to the controller; no method returns the login-shell values.
 */
export type ClaudeCodeDesktopStatus = Readonly<{
  /** macOS only in v1 (D18). Elsewhere nothing is detected, stored or granted. */
  supported: boolean;
  found: boolean;
  path?: string;
  consented: boolean;
  problem?: ClaudeCodeBinaryProblem | "not_found";
}>;

type OsAccount = Readonly<{ username: string; homedir: string; shell: string | null }>;

type Candidate = Readonly<{
  binaryPath: string | null;
  pathEntries: readonly string[];
  env: ClaudeCodeLoginShellEnv;
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

  const validate = (binaryPath: string, host: DesktopExtensionHostContext) =>
    validateClaudeCodeBinary(binaryPath, {
      uid: uid(),
      adminGroupId,
      desktopOwnedPaths: host.desktopOwnedPaths,
      caseInsensitivePaths: true,
      fs: files,
    });

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

  const describePath = (
    host: DesktopExtensionHostContext,
    binaryPath: string | null,
    consented: boolean,
  ): ClaudeCodeDesktopStatus => {
    if (!binaryPath) {
      return Object.freeze({ supported: true, found: false, consented });
    }
    const validation = validate(binaryPath, host);
    return validation.ok
      ? Object.freeze({ supported: true, found: true, path: binaryPath, consented })
      : Object.freeze({
          supported: true,
          found: false,
          path: binaryPath,
          consented,
          problem: validation.problem,
        });
  };

  // While the lane is on, the path in use; otherwise what Find or Locate
  // turned up. So a change the shell rolls back never shows as made.
  const status = (host: DesktopExtensionHostContext): ClaudeCodeDesktopStatus => {
    if (!supported) {
      return UNSUPPORTED;
    }
    const record = readRecord(host);
    if (record) {
      return describePath(host, record.binaryPath, true);
    }
    const key = accountKey(host);
    return describePath(host, (key ? candidates.get(key)?.binaryPath : null) ?? null, false);
  };

  return Object.freeze({
    apiVersion: 1 as const,
    id: CLAUDE_CODE_DESKTOP_FEATURE_MODULE_ID,
    desktopExtensions: Object.freeze([
      Object.freeze({
        id: CLAUDE_CODE_DESKTOP_EXTENSION_ID,
        methods: Object.freeze({
          status: (_payload: unknown, host: DesktopExtensionHostContext) => status(host),

          async detect(_payload: unknown, host: DesktopExtensionHostContext) {
            if (!supported) {
              return UNSUPPORTED;
            }
            const account = requireAccount(host);
            const osUser = osAccount();
            const detection = await detectClaudeCode({
              shell: osUser.shell,
              homeDir: osUser.homedir,
              user: osUser.username,
              lang: lang(),
              etcShellsPath: options.etcShellsPath,
              timeoutMs: options.detectTimeoutMs ?? CLAUDE_CODE_DETECT_TIMEOUT_MS,
              lstat: (file) => files.lstatSync(file),
            });
            const consented = readRecord(host) !== null;
            if (!detection.binaryPath) {
              candidates.set(account.key, {
                binaryPath: null,
                pathEntries: detection.pathEntries,
                env: detection.env,
              });
              return Object.freeze({
                supported: true,
                found: false,
                consented,
                problem: "not_found" as const,
              });
            }
            const found = describePath(host, detection.binaryPath, consented);
            candidates.set(account.key, {
              binaryPath: found.found ? detection.binaryPath : null,
              pathEntries: detection.pathEntries,
              env: detection.env,
            });
            return found;
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
              return status(host);
            }
            const record = readRecord(host);
            const located = describePath(host, chosen, record !== null);
            if (!located.found) {
              return located;
            }
            if (record) {
              // A new path for a lane already on: the grant changes, so the
              // shell replaces the runtime that holds the old one. Use for my
              // messages now confirms this path, not an older find.
              account.store.write({ ...record, binaryPath: chosen });
              candidates.delete(account.key);
            } else {
              const previous = candidates.get(account.key);
              candidates.set(account.key, {
                binaryPath: chosen,
                pathEntries: previous?.pathEntries ?? [],
                env: previous?.env ?? {},
              });
            }
            return status(host);
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
            const checked = describePath(host, chosen.binaryPath, record !== null);
            if (!checked.found) {
              return checked;
            }
            const answer = await host.dialogs.showMessageBox(
              buildClaudeCodeConsentDialog({
                email,
                otherAccounts: account.store.hasOtherAccounts(),
                binaryPath: chosen.binaryPath,
                env: chosen.env,
              }),
            );
            if (answer !== 0) {
              return status(host);
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
            return status(host);
          },

          disable(_payload: unknown, host: DesktopExtensionHostContext) {
            requireAccount(host).store.remove();
            return status(host);
          },
        }),
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
