export function normalizeTrimmedString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function normalizeStringArray(values) {
  if (!Array.isArray(values)) {
    return undefined;
  }

  const normalized = Array.from(
    new Set(
      values
        .filter((value) => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );

  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeBoolean(value) {
  return typeof value === "boolean" ? value : undefined;
}

export function normalizeRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

export function normalizeNonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function normalizeFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function normalizeProviderAliases(value, allowedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const aliases = {};
  for (const key of allowedKeys) {
    const normalized = normalizeTrimmedString(value[key]);
    if (normalized) {
      aliases[key] = normalized;
    }
  }

  return Object.keys(aliases).length > 0 ? aliases : undefined;
}
