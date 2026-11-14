import {
  collectInstafyFeatureModuleContributions,
  validateInstafyFeatureModules,
  type InstafyFeatureModule,
} from "@instafy/sdk/feature-modules";

const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const METHOD_ID_PATTERN = /^[a-z][A-Za-z0-9]*$/;
const FEATURE_MODULE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const INSTAFY_USER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// A launch grant may only carry Instafy-namespaced values, and never one the
// runtime launcher owns itself (desktop-runtime-agent enforces the same).
const LAUNCH_GRANT_ENV_KEY_PATTERN = /^INSTAFY_[A-Z0-9_]+$/;
const LAUNCH_GRANT_RESERVED_ENV_KEY_PREFIXES = ["INSTAFY_RUNTIME_", "INSTAFY_PERSONAL_BROWSER_"];
const LAUNCH_GRANT_LOCAL_ENGINE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** The signed-in Instafy account of the calling top-level frame. */
export type DesktopExtensionSession = Readonly<{
  /** Read from the visible session and checked against its token; lower case. */
  userId: string;
  /** For wording only, such as naming the account in a dialog. Never a key. */
  email: string | null;
}>;

/**
 * A module's consent records, kept in Desktop's own config and scoped by the
 * shell to the calling module, the trusted controller origin and the visible
 * session's user. A method can never read or write another key.
 */
export type DesktopExtensionConsentStore = Readonly<{
  read: () => unknown;
  write: (record: unknown) => void;
  remove: () => void;
  /** Whether this module holds a record for any other Instafy account on this OS account. */
  hasOtherAccounts: () => boolean;
}>;

export type DesktopExtensionMessageBoxOptions = Readonly<{
  type?: "none" | "info" | "error" | "question" | "warning";
  title?: string;
  message: string;
  detail?: string;
  buttons: readonly string[];
  defaultId?: number;
  cancelId?: number;
}>;

export type DesktopExtensionPickFileOptions = Readonly<{
  title?: string;
  buttonLabel?: string;
  defaultPath?: string;
}>;

/** Native dialogs shown by the main process, which web content cannot answer or fake. */
export type DesktopExtensionDialogs = Readonly<{
  /** Resolves to the index of the button the person chose. */
  showMessageBox: (options: DesktopExtensionMessageBoxOptions) => Promise<number>;
  /** A file picker that returns a chosen symlink itself, not its target; null when cancelled. */
  pickFile: (options: DesktopExtensionPickFileOptions) => Promise<string | null>;
}>;

/** What the shell knows about one call, before it is scoped to a module. */
export type DesktopExtensionHost = Readonly<{
  session: DesktopExtensionSession | null;
  /** The renderer's controller, after the shell's trust policy accepted it. */
  controllerOrigin: string | null;
  consents: DesktopExtensionConsentBackend | null;
  dialogs: DesktopExtensionDialogs;
  /** Folders Desktop owns: the workspace root, each space's folder, the app bundle and Instafy's home folder. */
  desktopOwnedPaths: readonly string[];
}>;

/** What a method receives beside the renderer's payload. */
export type DesktopExtensionHostContext = Readonly<{
  session: DesktopExtensionSession | null;
  controllerOrigin: string | null;
  /** Null unless the call has both a session and a trusted controller origin. */
  consentStore: DesktopExtensionConsentStore | null;
  dialogs: DesktopExtensionDialogs;
  desktopOwnedPaths: readonly string[];
}>;

export type DesktopExtensionMethod = (
  payload: unknown,
  host: DesktopExtensionHostContext,
) => unknown | Promise<unknown>;

export type DesktopExtensionRegistration = Readonly<{
  id: string;
  methods: Readonly<Record<string, DesktopExtensionMethod>>;
  /**
   * Methods that change no consent record, such as a status read. When the
   * module also grants runtime launch values, the shell runs them only once
   * every consent change queued before them has settled, made or put back, so
   * they never answer with a change the person kept from being made.
   */
  readOnlyMethods?: readonly string[];
  shutdown?: () => void | Promise<void>;
}>;

export type DesktopRuntimeLaunchGrantRequest = Readonly<{
  projectId: string;
  controllerOrigin: string;
  instafyUserId: string;
  /** What this module's own methods stored for that controller and user, or null. */
  consent: unknown;
}>;

export type DesktopRuntimeLaunchGrantValue = Readonly<{
  env: Readonly<Record<string, string>>;
  localEngine?: string;
}>;

/**
 * Values a module grants a runtime start. The shell asks only for a start
 * bound to the visible session, for that session's user, and strips every
 * declared key from every start whatever the answer.
 */
export type DesktopRuntimeLaunchGrantContribution = Readonly<{
  id: string;
  protectedEnvKeys: readonly string[];
  resolve: (
    request: DesktopRuntimeLaunchGrantRequest,
  ) => DesktopRuntimeLaunchGrantValue | null | Promise<DesktopRuntimeLaunchGrantValue | null>;
}>;

export type DesktopExtensionFeatureContributions = Readonly<{
  desktopExtensions?: readonly DesktopExtensionRegistration[];
  desktopRuntimeLaunchGrants?: readonly DesktopRuntimeLaunchGrantContribution[];
}>;

export type DesktopExtensionFeatureModule =
  InstafyFeatureModule<DesktopExtensionFeatureContributions>;

/** One contribution's answer for one start; `grant` is null when nothing was granted. */
export type DesktopRuntimeResolvedLaunchGrant = Readonly<{
  id: string;
  moduleId: string;
  protectedEnvKeys: readonly string[];
  grant: Readonly<{
    env: Readonly<Record<string, string>>;
    localEngine: string | null;
  }> | null;
}>;

/** The shape desktop-runtime-agent's `launchGrants` option takes. */
export type DesktopRuntimeLaunchGrantForStart = Readonly<{
  protectedEnvKeys: readonly string[];
  env?: Readonly<Record<string, string>>;
  localEngine?: string;
}>;

export type DesktopExtensionConsentData = Record<
  string,
  Record<string, Record<string, Record<string, unknown>>>
>;

/** Where the shell keeps consent records: Desktop's own config. */
export type DesktopExtensionConsentBackend = Readonly<{
  read: () => unknown;
  write: (data: DesktopExtensionConsentData) => void;
}>;

export type DesktopExtensionConsentSnapshot = Readonly<{
  moduleId: string;
  origins: Record<string, Record<string, Record<string, unknown>>> | null;
}>;

export type DesktopExtensionRegistry = Readonly<{
  extensionIds: readonly string[];
  invoke: (
    extensionId: string,
    methodId: string,
    payload?: unknown,
    host?: DesktopExtensionHost,
  ) => Promise<unknown>;
  shutdownAll: () => Promise<void>;
  /** The feature module that registered an extension. */
  moduleIdForExtension: (extensionId: string) => string;
  /** Whether an extension declared a method as one that changes no consent record. */
  methodIsReadOnly: (extensionId: string, methodId: string) => boolean;
  moduleContributesLaunchGrants: (moduleId: string) => boolean;
  /** Every registered contribution with nothing granted: what a start that may not be granted anything passes. */
  launchGrantsWithoutValues: () => readonly DesktopRuntimeResolvedLaunchGrant[];
  resolveLaunchGrants: (request: {
    projectId: string;
    controllerOrigin: string;
    /** The user the start is bound to; null for a start that is not bound to the visible session. */
    instafyUserId: string | null;
    consents: DesktopExtensionConsentBackend | null;
    onError?: (grantId: string, error: unknown) => void;
  }) => Promise<readonly DesktopRuntimeResolvedLaunchGrant[]>;
}>;

type ValidatedDesktopExtension = Readonly<{
  id: string;
  moduleId: string;
  methods: ReadonlyMap<string, DesktopExtensionMethod>;
  readOnlyMethods: ReadonlySet<string>;
  shutdown?: () => void | Promise<void>;
}>;

type ValidatedLaunchGrantContribution = Readonly<{
  id: string;
  moduleId: string;
  protectedEnvKeys: readonly string[];
  resolve: DesktopRuntimeLaunchGrantContribution["resolve"];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateDesktopExtensionRegistration(
  registration: DesktopExtensionRegistration,
  index: number,
  moduleId: string,
): ValidatedDesktopExtension {
  if (!registration || typeof registration !== "object" || Array.isArray(registration)) {
    throw new TypeError(
      `Desktop extension contribution at index ${index} must be an object.`,
    );
  }
  if (!EXTENSION_ID_PATTERN.test(registration.id)) {
    throw new Error(
      `Desktop extension contribution at index ${index} has invalid id ${JSON.stringify(
        registration.id,
      )}.`,
    );
  }
  if (
    !registration.methods ||
    typeof registration.methods !== "object" ||
    Array.isArray(registration.methods)
  ) {
    throw new TypeError(
      `Desktop extension "${registration.id}" requires a methods object.`,
    );
  }

  const methods = new Map<string, DesktopExtensionMethod>();
  for (const [methodId, method] of Object.entries(registration.methods)) {
    if (!METHOD_ID_PATTERN.test(methodId)) {
      throw new Error(
        `Desktop extension "${registration.id}" has invalid method id ${JSON.stringify(
          methodId,
        )}.`,
      );
    }
    if (typeof method !== "function") {
      throw new TypeError(
        `Desktop extension "${registration.id}" method "${methodId}" must be a function.`,
      );
    }
    methods.set(methodId, method);
  }
  if (methods.size === 0) {
    throw new Error(
      `Desktop extension "${registration.id}" must register at least one method.`,
    );
  }
  const readOnlyMethods = new Set<string>();
  if (registration.readOnlyMethods !== undefined) {
    if (!Array.isArray(registration.readOnlyMethods)) {
      throw new TypeError(
        `Desktop extension "${registration.id}" readOnlyMethods must be an array.`,
      );
    }
    for (const methodId of registration.readOnlyMethods) {
      if (typeof methodId !== "string" || !methods.has(methodId)) {
        throw new Error(
          `Desktop extension "${registration.id}" lists ${JSON.stringify(
            methodId,
          )} as read-only, but registers no such method.`,
        );
      }
      readOnlyMethods.add(methodId);
    }
  }
  if (registration.shutdown !== undefined && typeof registration.shutdown !== "function") {
    throw new TypeError(
      `Desktop extension "${registration.id}" shutdown hook must be a function.`,
    );
  }

  return Object.freeze({
    id: registration.id,
    moduleId,
    methods,
    readOnlyMethods,
    shutdown: registration.shutdown,
  });
}

function isReservedLaunchGrantEnvKey(key: string): boolean {
  return LAUNCH_GRANT_RESERVED_ENV_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function validateLaunchGrantContribution(
  contribution: DesktopRuntimeLaunchGrantContribution,
  moduleId: string,
  declaredKeys: Set<string>,
): ValidatedLaunchGrantContribution {
  if (!isRecord(contribution) || !EXTENSION_ID_PATTERN.test(String(contribution.id))) {
    throw new Error(
      `Feature module "${moduleId}" has a runtime launch grant with an invalid id.`,
    );
  }
  if (typeof contribution.resolve !== "function") {
    throw new TypeError(`Runtime launch grant "${contribution.id}" requires a resolve function.`);
  }
  if (!Array.isArray(contribution.protectedEnvKeys) || contribution.protectedEnvKeys.length === 0) {
    throw new Error(
      `Runtime launch grant "${contribution.id}" must declare its protectedEnvKeys.`,
    );
  }
  const protectedEnvKeys: string[] = [];
  for (const key of contribution.protectedEnvKeys) {
    if (
      typeof key !== "string" ||
      !LAUNCH_GRANT_ENV_KEY_PATTERN.test(key) ||
      isReservedLaunchGrantEnvKey(key)
    ) {
      throw new Error(
        `Runtime launch grant "${contribution.id}" declares a key it cannot set: ${JSON.stringify(key)}.`,
      );
    }
    if (declaredKeys.has(key)) {
      throw new Error(`Runtime launch grants declare ${key} more than once.`);
    }
    declaredKeys.add(key);
    protectedEnvKeys.push(key);
  }
  return Object.freeze({
    id: contribution.id,
    moduleId,
    protectedEnvKeys: Object.freeze(protectedEnvKeys),
    resolve: contribution.resolve,
  });
}

function validateLaunchGrantValue(
  contribution: ValidatedLaunchGrantContribution,
  value: unknown,
): DesktopRuntimeResolvedLaunchGrant["grant"] {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isRecord(value) || !isRecord(value.env)) {
    throw new Error(`Runtime launch grant "${contribution.id}" returned no env object.`);
  }
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value.env)) {
    if (!contribution.protectedEnvKeys.includes(key)) {
      throw new Error(
        `Runtime launch grant "${contribution.id}" sets ${key}, which it does not declare.`,
      );
    }
    if (typeof entry !== "string" || entry.includes("\0")) {
      throw new Error(
        `Runtime launch grant "${contribution.id}" sets ${key} to a value that is not a string.`,
      );
    }
    env[key] = entry;
  }
  let localEngine: string | null = null;
  if (value.localEngine !== undefined) {
    if (
      typeof value.localEngine !== "string" ||
      !LAUNCH_GRANT_LOCAL_ENGINE_PATTERN.test(value.localEngine)
    ) {
      throw new Error(`Runtime launch grant "${contribution.id}" names an invalid localEngine.`);
    }
    localEngine = value.localEngine;
  }
  return Object.freeze({ env: Object.freeze(env), localEngine });
}

function ungranted(
  contribution: ValidatedLaunchGrantContribution,
): DesktopRuntimeResolvedLaunchGrant {
  return Object.freeze({
    id: contribution.id,
    moduleId: contribution.moduleId,
    protectedEnvKeys: contribution.protectedEnvKeys,
    grant: null,
  });
}

function normalizeInstafyUserId(value: string | null | undefined): string | null {
  const userId = typeof value === "string" ? value.trim().toLowerCase() : "";
  return INSTAFY_USER_ID_PATTERN.test(userId) ? userId : null;
}

function isControllerOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Read consent data as stored, keeping only well-formed entries: a module id,
 * then a controller origin, then a lower-case Instafy user id, then an object.
 */
export function normalizeDesktopExtensionConsentData(value: unknown): DesktopExtensionConsentData {
  const data: DesktopExtensionConsentData = {};
  if (!isRecord(value)) {
    return data;
  }
  for (const [moduleId, origins] of Object.entries(value)) {
    if (!FEATURE_MODULE_ID_PATTERN.test(moduleId) || !isRecord(origins)) {
      continue;
    }
    const moduleOrigins: Record<string, Record<string, Record<string, unknown>>> = {};
    for (const [origin, users] of Object.entries(origins)) {
      if (!isControllerOrigin(origin) || !isRecord(users)) {
        continue;
      }
      const originUsers: Record<string, Record<string, unknown>> = {};
      for (const [userId, record] of Object.entries(users)) {
        if (INSTAFY_USER_ID_PATTERN.test(userId) && isRecord(record)) {
          originUsers[userId] = record;
        }
      }
      if (Object.keys(originUsers).length > 0) {
        moduleOrigins[origin] = originUsers;
      }
    }
    if (Object.keys(moduleOrigins).length > 0) {
      data[moduleId] = moduleOrigins;
    }
  }
  return data;
}

function readConsentRecord(
  backend: DesktopExtensionConsentBackend,
  moduleId: string,
  controllerOrigin: string,
  userId: string,
): unknown {
  const record = normalizeDesktopExtensionConsentData(backend.read())[moduleId]?.[
    controllerOrigin
  ]?.[userId];
  return record ? cloneJson(record) : null;
}

/** The consent store for one module, controller origin and Instafy user. */
export function createDesktopExtensionConsentStore(
  backend: DesktopExtensionConsentBackend,
  scope: { moduleId: string; controllerOrigin: string; userId: string },
): DesktopExtensionConsentStore {
  const userId = normalizeInstafyUserId(scope.userId);
  if (
    !FEATURE_MODULE_ID_PATTERN.test(scope.moduleId) ||
    !isControllerOrigin(scope.controllerOrigin) ||
    !userId
  ) {
    throw new Error("A consent store needs a module, a controller origin and an Instafy user.");
  }
  const { moduleId, controllerOrigin } = scope;
  return Object.freeze({
    read: () => readConsentRecord(backend, moduleId, controllerOrigin, userId),
    write(record: unknown) {
      if (!isRecord(record)) {
        throw new TypeError("A consent record must be an object.");
      }
      const copy = cloneJson(record);
      const data = normalizeDesktopExtensionConsentData(backend.read());
      const origins = data[moduleId] ?? {};
      data[moduleId] = {
        ...origins,
        [controllerOrigin]: { ...(origins[controllerOrigin] ?? {}), [userId]: copy },
      };
      backend.write(data);
    },
    remove() {
      const data = normalizeDesktopExtensionConsentData(backend.read());
      const origins = data[moduleId];
      const users = origins?.[controllerOrigin];
      if (!origins || !users || !Object.prototype.hasOwnProperty.call(users, userId)) {
        return;
      }
      delete users[userId];
      if (Object.keys(users).length === 0) {
        delete origins[controllerOrigin];
      }
      if (Object.keys(origins).length === 0) {
        delete data[moduleId];
      }
      backend.write(data);
    },
    hasOtherAccounts() {
      const origins = normalizeDesktopExtensionConsentData(backend.read())[moduleId] ?? {};
      return Object.entries(origins).some(([origin, users]) =>
        Object.keys(users).some((user) => origin !== controllerOrigin || user !== userId),
      );
    },
  });
}

export function snapshotDesktopExtensionConsents(
  backend: DesktopExtensionConsentBackend,
  moduleId: string,
): DesktopExtensionConsentSnapshot {
  const origins = normalizeDesktopExtensionConsentData(backend.read())[moduleId];
  return Object.freeze({ moduleId, origins: origins ? cloneJson(origins) : null });
}

/** Put one module's consent records back exactly as a snapshot found them. */
export function restoreDesktopExtensionConsents(
  backend: DesktopExtensionConsentBackend,
  snapshot: DesktopExtensionConsentSnapshot,
): void {
  const data = normalizeDesktopExtensionConsentData(backend.read());
  if (snapshot.origins) {
    data[snapshot.moduleId] = cloneJson(snapshot.origins);
  } else {
    delete data[snapshot.moduleId];
  }
  backend.write(data);
}

async function refuseDialog(): Promise<never> {
  throw new Error("Desktop dialogs are unavailable for this call.");
}

const NO_DESKTOP_EXTENSION_HOST: DesktopExtensionHost = Object.freeze({
  session: null,
  controllerOrigin: null,
  consents: null,
  dialogs: Object.freeze({ showMessageBox: refuseDialog, pickFile: refuseDialog }),
  desktopOwnedPaths: Object.freeze([]),
});

/** Scope what the shell knows about a call to one feature module. */
export function createDesktopExtensionHostContext(
  host: DesktopExtensionHost,
  moduleId: string,
): DesktopExtensionHostContext {
  const userId = normalizeInstafyUserId(host.session?.userId);
  const session = userId
    ? Object.freeze({ userId, email: host.session?.email?.trim() || null })
    : null;
  const controllerOrigin =
    host.controllerOrigin && isControllerOrigin(host.controllerOrigin)
      ? host.controllerOrigin
      : null;
  return Object.freeze({
    session,
    controllerOrigin,
    consentStore:
      session && controllerOrigin && host.consents
        ? createDesktopExtensionConsentStore(host.consents, {
            moduleId,
            controllerOrigin,
            userId: session.userId,
          })
        : null,
    dialogs: host.dialogs,
    desktopOwnedPaths: Object.freeze([...host.desktopOwnedPaths]),
  });
}

export function createDesktopExtensionRegistry(
  featureModules: readonly DesktopExtensionFeatureModule[],
): DesktopExtensionRegistry {
  const modules = validateInstafyFeatureModules(featureModules);
  const extensions = new Map<string, ValidatedDesktopExtension>();
  const launchGrants: ValidatedLaunchGrantContribution[] = [];
  const launchGrantIds = new Set<string>();
  const declaredLaunchGrantKeys = new Set<string>();
  let extensionIndex = 0;

  for (const module of modules) {
    for (const contribution of collectInstafyFeatureModuleContributions(
      [module],
      "desktopExtensions",
    )) {
      const extension = validateDesktopExtensionRegistration(
        contribution,
        extensionIndex,
        module.id,
      );
      extensionIndex += 1;
      if (extensions.has(extension.id)) {
        throw new Error(`Duplicate desktop extension id "${extension.id}".`);
      }
      extensions.set(extension.id, extension);
    }
    for (const contribution of collectInstafyFeatureModuleContributions(
      [module],
      "desktopRuntimeLaunchGrants",
    )) {
      const grant = validateLaunchGrantContribution(
        contribution,
        module.id,
        declaredLaunchGrantKeys,
      );
      if (launchGrantIds.has(grant.id)) {
        throw new Error(`Duplicate runtime launch grant id "${grant.id}".`);
      }
      launchGrantIds.add(grant.id);
      launchGrants.push(grant);
    }
  }

  const requireExtension = (extensionId: string): ValidatedDesktopExtension => {
    if (!EXTENSION_ID_PATTERN.test(extensionId)) {
      throw new Error(`Invalid desktop extension id ${JSON.stringify(extensionId)}.`);
    }
    const extension = extensions.get(extensionId);
    if (!extension) {
      throw new Error(`Unknown desktop extension "${extensionId}".`);
    }
    return extension;
  };
  const launchGrantsWithoutValues = () => Object.freeze(launchGrants.map(ungranted));

  return Object.freeze({
    extensionIds: Object.freeze([...extensions.keys()]),
    async invoke(
      extensionId: string,
      methodId: string,
      payload?: unknown,
      host: DesktopExtensionHost = NO_DESKTOP_EXTENSION_HOST,
    ) {
      const extension = requireExtension(extensionId);
      if (!METHOD_ID_PATTERN.test(methodId)) {
        throw new Error(`Invalid desktop extension method id ${JSON.stringify(methodId)}.`);
      }
      const method = extension.methods.get(methodId);
      if (!method) {
        throw new Error(
          `Unknown method "${methodId}" for desktop extension "${extensionId}".`,
        );
      }
      return await method(payload, createDesktopExtensionHostContext(host, extension.moduleId));
    },
    async shutdownAll() {
      const errors: unknown[] = [];
      for (const extension of [...extensions.values()].reverse()) {
        if (!extension.shutdown) {
          continue;
        }
        try {
          await extension.shutdown();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "One or more desktop extensions failed to shut down.");
      }
    },
    moduleIdForExtension: (extensionId: string) => requireExtension(extensionId).moduleId,
    methodIsReadOnly: (extensionId: string, methodId: string) =>
      requireExtension(extensionId).readOnlyMethods.has(methodId),
    moduleContributesLaunchGrants: (moduleId: string) =>
      launchGrants.some((grant) => grant.moduleId === moduleId),
    launchGrantsWithoutValues,
    async resolveLaunchGrants(request) {
      const userId = normalizeInstafyUserId(request.instafyUserId);
      if (!userId || !request.consents || !isControllerOrigin(request.controllerOrigin)) {
        return launchGrantsWithoutValues();
      }
      const resolved: DesktopRuntimeResolvedLaunchGrant[] = [];
      for (const contribution of launchGrants) {
        let grant: DesktopRuntimeResolvedLaunchGrant["grant"] = null;
        try {
          grant = validateLaunchGrantValue(
            contribution,
            await contribution.resolve(
              Object.freeze({
                projectId: request.projectId,
                controllerOrigin: request.controllerOrigin,
                instafyUserId: userId,
                consent: readConsentRecord(
                  request.consents,
                  contribution.moduleId,
                  request.controllerOrigin,
                  userId,
                ),
              }),
            ),
          );
        } catch (error) {
          // A grant that cannot be resolved is not granted; the start goes on without it.
          request.onError?.(contribution.id, error);
          grant = null;
        }
        resolved.push(Object.freeze({ ...ungranted(contribution), grant }));
      }
      return Object.freeze(resolved);
    },
  });
}

/** The `launchGrants` a runtime start passes to desktop-runtime-agent. */
export function desktopRuntimeLaunchGrantsForStart(
  grants: readonly DesktopRuntimeResolvedLaunchGrant[],
): DesktopRuntimeLaunchGrantForStart[] {
  return grants.map((entry) => ({
    protectedEnvKeys: [...entry.protectedEnvKeys],
    ...(entry.grant
      ? {
          env: { ...entry.grant.env },
          ...(entry.grant.localEngine ? { localEngine: entry.grant.localEngine } : {}),
        }
      : {}),
  }));
}

/** Whether a start was granted anything at all. */
export function desktopRuntimeLaunchGrantsHeld(
  grants: readonly DesktopRuntimeResolvedLaunchGrant[],
): boolean {
  return grants.some((entry) => entry.grant !== null);
}

function sameLaunchGrantValue(
  left: DesktopRuntimeResolvedLaunchGrant["grant"],
  right: DesktopRuntimeResolvedLaunchGrant["grant"],
): boolean {
  if (!left || !right) {
    return left === right;
  }
  const leftKeys = Object.keys(left.env).sort();
  const rightKeys = Object.keys(right.env).sort();
  return (
    left.localEngine === right.localEngine &&
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left.env[key] === right.env[key])
  );
}

/** Compare two starts' grants, optionally only one module's. */
export function desktopRuntimeLaunchGrantsEqual(
  left: readonly DesktopRuntimeResolvedLaunchGrant[],
  right: readonly DesktopRuntimeResolvedLaunchGrant[],
  moduleId?: string,
): boolean {
  const pick = (grants: readonly DesktopRuntimeResolvedLaunchGrant[]) =>
    new Map(
      grants
        .filter((entry) => moduleId === undefined || entry.moduleId === moduleId)
        .map((entry) => [entry.id, entry.grant] as const),
    );
  const leftById = pick(left);
  const rightById = pick(right);
  for (const id of new Set([...leftById.keys(), ...rightById.keys()])) {
    if (!sameLaunchGrantValue(leftById.get(id) ?? null, rightById.get(id) ?? null)) {
      return false;
    }
  }
  return true;
}

/**
 * Thrown when the person kept the running work: the change is undone, not
 * made. Its name stays "Error": Electron hands a renderer only
 * `error.toString()`, "<name>: <message>", and Studio shows what follows
 * "Error: ". In-process code tells it apart by `code`.
 */
export class DesktopExtensionChangeNotMadeError extends Error {
  readonly code = "desktop_extension_change_not_made";

  constructor() {
    super("Instafy is still working on this computer, so that change was not made.");
  }
}

export type DesktopExtensionRunningRuntime<T> = Readonly<{
  handle: T;
  projectId: string;
  controllerOrigin: string;
  /** The user its start was bound to; null when it was not bound to the visible session. */
  instafyUserId: string | null;
  launchGrants: readonly DesktopRuntimeResolvedLaunchGrant[];
}>;

/**
 * Run an extension method. When its module also grants runtime launch values,
 * resolve that grant again for the running runtime once the method returns,
 * and replace the runtime only when the grant changed. If the person keeps
 * the running work instead, put the module's consent records back as they
 * were before the method ran and report the change as not made.
 *
 * A method the extension declares read-only runs inside the runtime lock, so
 * it answers only once every consent change queued before it has settled. A
 * replacement that fails is not a change the person kept from being made:
 * the change stays, the method answers as usual, and the failure goes to
 * `onReplaceError`.
 */
export async function invokeDesktopExtensionWithLaunchGrants<T>(options: {
  registry: DesktopExtensionRegistry;
  extensionId: string;
  methodId: string;
  payload: unknown;
  host: DesktopExtensionHost;
  withRuntimeLock: <R>(operation: () => Promise<R>) => Promise<R>;
  runningRuntime: () => DesktopExtensionRunningRuntime<T> | null;
  /** Fence, ask and replace; "kept" when the person chose to keep working. */
  replaceRuntime: (runtime: DesktopExtensionRunningRuntime<T>) => Promise<"replaced" | "kept">;
  onGrantError?: (grantId: string, error: unknown) => void;
  /**
   * A replacement failed after nobody chose to keep the work: the old runtime
   * is stopped, or still held fenced when it could not be stopped, and the
   * next call that finds its grant changed tries again.
   */
  onReplaceError?: (error: unknown) => void;
}): Promise<unknown> {
  const { registry, host } = options;
  const moduleId = registry.moduleIdForExtension(options.extensionId);
  const consents = host.consents;
  const invoke = () =>
    registry.invoke(options.extensionId, options.methodId, options.payload, host);
  if (!consents || !registry.moduleContributesLaunchGrants(moduleId)) {
    return await invoke();
  }
  // Replace the running runtime when this module's grant for it changed;
  // true when the person kept the running work instead.
  const keptRunningWork = async (): Promise<boolean> => {
    const runtime = options.runningRuntime();
    if (!runtime?.instafyUserId) {
      return false;
    }
    const next = await registry.resolveLaunchGrants({
      projectId: runtime.projectId,
      controllerOrigin: runtime.controllerOrigin,
      instafyUserId: runtime.instafyUserId,
      consents,
      onError: options.onGrantError,
    });
    if (desktopRuntimeLaunchGrantsEqual(runtime.launchGrants, next, moduleId)) {
      return false;
    }
    try {
      return (await options.replaceRuntime(runtime)) === "kept";
    } catch (error) {
      options.onReplaceError?.(error);
      return false;
    }
  };
  if (registry.methodIsReadOnly(options.extensionId, options.methodId)) {
    // It changed nothing, so there is nothing to put back if the person keeps
    // the work a replacement would stop.
    return await options.withRuntimeLock(async () => {
      const result = await invoke();
      await keptRunningWork();
      return result;
    });
  }
  const before = snapshotDesktopExtensionConsents(consents, moduleId);
  const result = await invoke();
  await options.withRuntimeLock(async () => {
    if (await keptRunningWork()) {
      restoreDesktopExtensionConsents(consents, before);
      throw new DesktopExtensionChangeNotMadeError();
    }
  });
  return result;
}
