/**
 * Recovery refs a finished turn reported. The runtime records them on its
 * `origin/apply` and `origin/refresh` artifacts when it kept work aside; no
 * controller event exists for ref creation, so this is how the unsaved-work
 * list learns it should refresh.
 */

const RECOVERY_ARTIFACT_KINDS = new Set(["origin/apply", "origin/refresh"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRef(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() || null;
  }
  if (isRecord(value)) {
    for (const key of ["reference", "ref"]) {
      const candidate = value[key];
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }
  }
  return null;
}

export function extractRecoveryRefsFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): string[] {
  const artifacts = metadata?.["artifacts"];
  if (!Array.isArray(artifacts)) {
    return [];
  }
  const refs = new Set<string>();
  for (const artifact of artifacts) {
    if (!isRecord(artifact) || typeof artifact.kind !== "string" || !RECOVERY_ARTIFACT_KINDS.has(artifact.kind)) {
      continue;
    }
    const artifactMetadata = isRecord(artifact.metadata) ? artifact.metadata : null;
    if (!artifactMetadata) {
      continue;
    }
    const single = readRef(artifactMetadata.recoveryRef ?? artifactMetadata.recovery_ref);
    if (single) {
      refs.add(single);
    }
    const many = artifactMetadata.recoveryRefs ?? artifactMetadata.recovery_refs;
    if (Array.isArray(many)) {
      for (const item of many) {
        const ref = readRef(item);
        if (ref) {
          refs.add(ref);
        }
      }
    }
  }
  return Array.from(refs);
}

/** Every recovery ref reported by these messages, sorted, for change detection. */
export function collectRecoveryRefs(
  messages: ReadonlyArray<{ metadata?: Record<string, unknown> | null }>,
): string[] {
  const refs = new Set<string>();
  for (const message of messages) {
    for (const ref of extractRecoveryRefsFromMetadata(message.metadata ?? null)) {
      refs.add(ref);
    }
  }
  return Array.from(refs).sort();
}
