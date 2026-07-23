export const INSTAFY_FEATURE_MODULE_API_VERSION = 1;

const FEATURE_MODULE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

function requireFeatureModuleArray(modules) {
  if (!Array.isArray(modules)) {
    throw new TypeError("Instafy feature modules must be provided as an array.");
  }
  return modules;
}

function requireFeatureModule(module, index) {
  if (!module || typeof module !== "object" || Array.isArray(module)) {
    throw new TypeError(`Instafy feature module at index ${index} must be an object.`);
  }

  const id = typeof module.id === "string" ? module.id : "";
  if (!FEATURE_MODULE_ID_PATTERN.test(id)) {
    throw new Error(
      `Instafy feature module at index ${index} has invalid id ${JSON.stringify(module.id)}.`,
    );
  }

  if (module.apiVersion !== INSTAFY_FEATURE_MODULE_API_VERSION) {
    throw new Error(
      `Instafy feature module "${id}" uses unsupported apiVersion ${JSON.stringify(
        module.apiVersion,
      )}; expected ${INSTAFY_FEATURE_MODULE_API_VERSION}.`,
    );
  }

  return module;
}

export function validateInstafyFeatureModules(modules) {
  const validated = [];
  const seenIds = new Set();

  for (const [index, candidate] of requireFeatureModuleArray(modules).entries()) {
    const module = requireFeatureModule(candidate, index);
    if (seenIds.has(module.id)) {
      throw new Error(`Duplicate Instafy feature module id "${module.id}".`);
    }
    seenIds.add(module.id);
    validated.push(module);
  }

  return Object.freeze(validated);
}

export function defineInstafyFeatureModule(module) {
  return validateInstafyFeatureModules([module])[0];
}

export function collectInstafyFeatureModuleContributions(modules, contributionKey) {
  if (
    typeof contributionKey !== "string" ||
    contributionKey.length === 0 ||
    contributionKey.trim() !== contributionKey
  ) {
    throw new TypeError("Instafy feature contribution key must be a non-empty trimmed string.");
  }

  const contributions = [];
  for (const module of validateInstafyFeatureModules(modules)) {
    const values = module[contributionKey];
    if (values === undefined) {
      continue;
    }
    if (!Array.isArray(values)) {
      throw new TypeError(
        `Instafy feature module "${module.id}" contribution "${contributionKey}" must be an array.`,
      );
    }
    contributions.push(...values);
  }

  return Object.freeze(contributions);
}
