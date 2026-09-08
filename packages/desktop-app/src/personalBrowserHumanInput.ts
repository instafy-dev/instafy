export type PersonalBrowserHumanInputRequest = {
  version: 1;
  handoffId: string;
  origin: string;
  createdAtMs: number;
  expiresAtMs: number;
  fields: Array<{ label: string }>;
};

export function requireHumanInputIndices(payload: unknown): number[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Human input requires observed field indices.");
  }
  const record = payload as Record<string, unknown>;
  const indices = record.indices;
  if (Object.keys(record).some((key) => key !== "indices") ||
      !Array.isArray(indices) || indices.length < 1 || indices.length > 8 ||
      indices.some((value) => !Number.isInteger(value) || value < 0 || value > 499) ||
      new Set(indices).size !== indices.length) {
    throw new Error("Human input requires one to eight unique fresh field indices.");
  }
  return indices as number[];
}
