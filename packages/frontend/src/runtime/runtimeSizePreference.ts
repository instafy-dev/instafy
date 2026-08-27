/**
 * Per-project hosted machine size preference. The id is validated server-side
 * (unknown ids fall back to standard) and applies the next time a runtime is
 * provisioned for the project.
 */
export type RuntimeSizeId = "standard" | "boost";

export interface RuntimeSizeChoice {
  id: RuntimeSizeId;
  label: string;
  specs: string;
  costNote: string;
}

// Mirrors the server catalog (runtime-controller/src/runtime/sizes.rs). The
// exact credits/hour figure comes from the credit policy where available; the
// multiplier here keeps the cost honest even without a policy fetch. Standard
// carries no costNote — a 1× baseline reads as noise; only deviations from it
// are labeled.
export const RUNTIME_SIZE_CHOICES: RuntimeSizeChoice[] = [
  {
    id: "standard",
    label: "Standard",
    specs: "2 CPU · 4 GB",
    costNote: "",
  },
  {
    id: "boost",
    label: "Boost",
    specs: "4 CPU · 8 GB",
    costNote: "2× credits",
  },
];

function storageKey(projectId: string): string {
  return `instafy.runtimeSize.${projectId}`;
}

export function getRuntimeSizePreference(
  projectId: string | null | undefined,
): RuntimeSizeId {
  if (!projectId || typeof window === "undefined") {
    return "standard";
  }
  try {
    return window.localStorage.getItem(storageKey(projectId)) === "boost"
      ? "boost"
      : "standard";
  } catch {
    return "standard";
  }
}

export function setRuntimeSizePreference(projectId: string, size: RuntimeSizeId) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(storageKey(projectId), size);
  } catch {
    // Storage may be unavailable (private mode); the preference just won't stick.
  }
}
