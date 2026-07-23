export type GithubImportRetrySnapshot =
  | { phase: "idle" }
  | { phase: "running"; operation: "github_import" }
  | { phase: "failed"; operation: "github_import"; error: string }
  | {
      phase: "succeeded";
      operation: "github_import";
      repo: string;
      ref: string | null;
      targetPath: string | null;
      fileCount: number | null;
    };

export type GithubImportRetryOutcome =
  | {
      success: true;
      repo: string;
      ref: string | null;
      targetPath: string | null;
      fileCount: number | null;
    }
  | { success: false; error: string };

type GithubImportRetryEntry = {
  snapshot: GithubImportRetrySnapshot;
  flight: Promise<GithubImportRetryOutcome> | null;
  updatedAt: number;
};

type GithubImportRetryIdentity = {
  projectId: string;
  sourceMessageId: string;
  repo: string;
  ref: string | null;
  targetPath: string | null;
};

const IDLE_SNAPSHOT: GithubImportRetrySnapshot = Object.freeze({ phase: "idle" });
const entries = new Map<string, GithubImportRetryEntry>();
const listeners = new Map<string, Set<() => void>>();
const MAX_SETTLED_ENTRIES = 64;
const SETTLED_ENTRY_TTL_MS = 24 * 60 * 60 * 1000;

function normalizeRepo(value: string): string {
  return value
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

function normalizedIdentity(identity: GithubImportRetryIdentity): GithubImportRetryIdentity {
  return {
    projectId: identity.projectId.trim(),
    sourceMessageId: identity.sourceMessageId.trim(),
    repo: normalizeRepo(identity.repo),
    ref: identity.ref?.trim() || null,
    targetPath: identity.targetPath?.trim().replace(/^\/+|\/+$/g, "") || null,
  };
}

// Two independent 32-bit FNV-1a passes keep the transport key compact while
// retaining a stable identity across reloads. The controller also compares the
// saved repo/ref/target before accepting a cached result, so a key collision can
// never return an unrelated import.
function stableIdentityHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ (code + index), 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

export function buildGithubImportRetryIdentity(identity: GithubImportRetryIdentity): {
  registryKey: string;
  idempotencyKey: string;
} {
  const normalized = normalizedIdentity(identity);
  const serialized = JSON.stringify([
    normalized.projectId,
    normalized.sourceMessageId,
    normalized.repo,
    normalized.ref,
    normalized.targetPath,
  ]);
  return {
    registryKey: serialized,
    idempotencyKey: `github-import-v1:${stableIdentityHash(serialized)}`,
  };
}

function emit(key: string) {
  listeners.get(key)?.forEach((listener) => listener());
}

function pruneSettledEntries(now = Date.now()) {
  const settled: Array<[string, GithubImportRetryEntry]> = [];
  entries.forEach((entry, key) => {
    if (entry.flight || (listeners.get(key)?.size ?? 0) > 0) {
      return;
    }
    if (now - entry.updatedAt > SETTLED_ENTRY_TTL_MS) {
      entries.delete(key);
      return;
    }
    settled.push([key, entry]);
  });
  if (settled.length <= MAX_SETTLED_ENTRIES) {
    return;
  }
  settled
    .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
    .slice(0, settled.length - MAX_SETTLED_ENTRIES)
    .forEach(([key]) => entries.delete(key));
}

export function getGithubImportRetrySnapshot(key: string | null): GithubImportRetrySnapshot {
  return (key ? entries.get(key)?.snapshot : null) ?? IDLE_SNAPSHOT;
}

export function subscribeGithubImportRetry(key: string | null, listener: () => void): () => void {
  if (!key) {
    return () => undefined;
  }
  const keyListeners = listeners.get(key) ?? new Set<() => void>();
  keyListeners.add(listener);
  listeners.set(key, keyListeners);
  return () => {
    keyListeners.delete(listener);
    if (keyListeners.size === 0) {
      listeners.delete(key);
    }
  };
}

export function runGithubImportRetry(
  key: string,
  operation: () => Promise<GithubImportRetryOutcome>,
): Promise<GithubImportRetryOutcome> {
  pruneSettledEntries();
  const current = entries.get(key);
  if (current?.flight) {
    return current.flight;
  }
  if (current?.snapshot.phase === "succeeded") {
    return Promise.resolve({
      success: true,
      repo: current.snapshot.repo,
      ref: current.snapshot.ref,
      targetPath: current.snapshot.targetPath,
      fileCount: current.snapshot.fileCount,
    });
  }

  const entry: GithubImportRetryEntry = current ?? {
    snapshot: IDLE_SNAPSHOT,
    flight: null,
    updatedAt: Date.now(),
  };
  entry.snapshot = { phase: "running", operation: "github_import" };
  entry.updatedAt = Date.now();
  entries.set(key, entry);
  emit(key);

  const flight = operation()
    .then((outcome) => {
      entry.snapshot = outcome.success
        ? {
            phase: "succeeded",
            operation: "github_import",
            repo: outcome.repo,
            ref: outcome.ref,
            targetPath: outcome.targetPath,
            fileCount: outcome.fileCount,
          }
        : {
            phase: "failed",
            operation: "github_import",
            error: outcome.error,
          };
      return outcome;
    })
    .catch((error: unknown) => {
      const message =
        error instanceof Error && error.message.trim()
          ? error.message.trim()
          : "GitHub import failed.";
      const outcome: GithubImportRetryOutcome = { success: false, error: message };
      entry.snapshot = {
        phase: "failed",
        operation: "github_import",
        error: message,
      };
      return outcome;
    })
    .finally(() => {
      entry.flight = null;
      entry.updatedAt = Date.now();
      pruneSettledEntries(entry.updatedAt);
      emit(key);
    });
  entry.flight = flight;
  return flight;
}

export function resetGithubImportRetryRegistryForTests() {
  entries.clear();
  listeners.clear();
}
