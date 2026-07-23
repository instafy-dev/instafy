export interface TerminalCommandRequest {
  command: string;
  prefix: "terminal" | "term";
}

const TERMINAL_PREFIX_PATTERN = /^\/(terminal|term)\b/i;

export function parseTerminalCommandRequest(input: string): TerminalCommandRequest | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const match = trimmed.match(TERMINAL_PREFIX_PATTERN);
  if (!match) {
    return null;
  }

  const prefixRaw = (match[1] ?? "").trim().toLowerCase();
  const prefix = prefixRaw === "terminal" ? "terminal" : "term";
  const command = trimmed.slice(match[0].length).trim();
  return {
    command,
    prefix,
  };
}
