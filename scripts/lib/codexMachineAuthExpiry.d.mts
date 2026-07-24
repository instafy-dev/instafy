export const CODEX_MACHINE_AUTH_MINIMUM_REMAINING_MS: number;

export class CodexMachineAuthPreflightError extends Error {}

export function defaultCodexMachineAuthPath(): string;

export function requireFreshCodexMachineAuth(options?: {
  authPath?: string;
  minimumRemainingMs?: number;
  nowMs?: number;
}): {
  expiresAtMs: number;
  remainingMs: number;
};
