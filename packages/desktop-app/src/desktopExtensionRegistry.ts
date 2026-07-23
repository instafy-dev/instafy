import {
  collectInstafyFeatureModuleContributions,
  validateInstafyFeatureModules,
  type InstafyFeatureModule,
} from "@instafy/sdk/feature-modules";

const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const METHOD_ID_PATTERN = /^[a-z][A-Za-z0-9]*$/;

export type DesktopExtensionMethod = (
  payload: unknown,
) => unknown | Promise<unknown>;

export type DesktopExtensionRegistration = Readonly<{
  id: string;
  methods: Readonly<Record<string, DesktopExtensionMethod>>;
  shutdown?: () => void | Promise<void>;
}>;

export type DesktopExtensionFeatureContributions = Readonly<{
  desktopExtensions?: readonly DesktopExtensionRegistration[];
}>;

export type DesktopExtensionFeatureModule =
  InstafyFeatureModule<DesktopExtensionFeatureContributions>;

export type DesktopExtensionRegistry = Readonly<{
  extensionIds: readonly string[];
  invoke: (
    extensionId: string,
    methodId: string,
    payload?: unknown,
  ) => Promise<unknown>;
  shutdownAll: () => Promise<void>;
}>;

type ValidatedDesktopExtension = Readonly<{
  id: string;
  methods: ReadonlyMap<string, DesktopExtensionMethod>;
  shutdown?: () => void | Promise<void>;
}>;

function validateDesktopExtensionRegistration(
  registration: DesktopExtensionRegistration,
  index: number,
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
  if (registration.shutdown !== undefined && typeof registration.shutdown !== "function") {
    throw new TypeError(
      `Desktop extension "${registration.id}" shutdown hook must be a function.`,
    );
  }

  return Object.freeze({
    id: registration.id,
    methods,
    shutdown: registration.shutdown,
  });
}

export function createDesktopExtensionRegistry(
  featureModules: readonly DesktopExtensionFeatureModule[],
): DesktopExtensionRegistry {
  const modules = validateInstafyFeatureModules(featureModules);
  const contributions = collectInstafyFeatureModuleContributions(
    modules,
    "desktopExtensions",
  );
  const extensions = new Map<string, ValidatedDesktopExtension>();

  for (const [index, contribution] of contributions.entries()) {
    const extension = validateDesktopExtensionRegistration(contribution, index);
    if (extensions.has(extension.id)) {
      throw new Error(`Duplicate desktop extension id "${extension.id}".`);
    }
    extensions.set(extension.id, extension);
  }

  return Object.freeze({
    extensionIds: Object.freeze([...extensions.keys()]),
    async invoke(extensionId: string, methodId: string, payload?: unknown) {
      if (!EXTENSION_ID_PATTERN.test(extensionId)) {
        throw new Error(`Invalid desktop extension id ${JSON.stringify(extensionId)}.`);
      }
      if (!METHOD_ID_PATTERN.test(methodId)) {
        throw new Error(`Invalid desktop extension method id ${JSON.stringify(methodId)}.`);
      }
      const extension = extensions.get(extensionId);
      if (!extension) {
        throw new Error(`Unknown desktop extension "${extensionId}".`);
      }
      const method = extension.methods.get(methodId);
      if (!method) {
        throw new Error(
          `Unknown method "${methodId}" for desktop extension "${extensionId}".`,
        );
      }
      return await method(payload);
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
  });
}
