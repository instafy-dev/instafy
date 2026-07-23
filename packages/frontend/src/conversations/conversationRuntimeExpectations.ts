function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwnKey(map: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(map, key));
}

function hasExplicitWorkspacePolicy(metadata: Record<string, unknown>): boolean {
  if (
    hasOwnKey(metadata, [
      "writeIntent",
      "write_intent",
      "workspaceMode",
      "workspace_mode",
      "executionMode",
      "execution_mode",
    ])
  ) {
    return true;
  }

  const expectations =
    isRecord(metadata.runtimeExpectations)
      ? metadata.runtimeExpectations
      : isRecord(metadata.runtime_expectations)
        ? metadata.runtime_expectations
        : null;

  return expectations
    ? hasOwnKey(expectations, ["workspaceFileChanges", "workspace_file_changes"])
    : false;
}

// Runtime expectations are structured contract flags. Do not infer them from
// user-facing English prompts.
export function withRuntimeExpectations(
  metadata: Record<string, unknown> | null | undefined,
  expectations: Record<string, unknown>,
): Record<string, unknown> {
  const existing =
    isRecord(metadata?.runtimeExpectations)
      ? metadata.runtimeExpectations
      : {};

  return {
    ...(metadata ?? {}),
    runtimeExpectations: {
      ...existing,
      ...expectations,
    },
  };
}

// Interactive chat must default to a writable workspace: the controller
// treats absent write flags as read_only, and a read_only job silently
// reverts every file the agent writes while the reply still claims success.
// `writeIntent` grants that capability without making a file mutation a
// success requirement; `runtimeExpectations.workspaceFileChanges` is reserved
// for turns that must actually change files. Callers that want read-only
// semantics must say so explicitly (any of the policy keys above) — that stays
// fully honored here.
export function withDefaultInteractiveWorkspaceExpectations(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const base = metadata ?? {};
  if (hasExplicitWorkspacePolicy(base)) {
    return base;
  }

  return {
    ...base,
    writeIntent: true,
  };
}
