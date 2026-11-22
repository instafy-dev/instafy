import { controllerJsonRequest } from "./client";

/**
 * The person's Claude Code logins (docs/Local-Engine-Turns.md 11.19): each a
 * Claude Code folder they signed in to themselves on one of their computers,
 * one subscription each. The controller keeps only an id and the name the
 * person gave it, never a folder, path, account or sign-in; which folder is
 * which login on a computer stays with that computer's Instafy Desktop. Only
 * the person's own session reads or changes them.
 */
export interface ControllerClaudeCodeLogin {
  /** A lowercase UUID. */
  id: string;
  /** The name the person gave it: 1-60 characters, on one line, with no double quote or invisible character. */
  label: string;
  createdAt: string;
}

export type ClaudeCodeLoginsFailure = {
  success: false;
  error: string;
  /** The controller's error code, when it refused with one. */
  code: string | null;
};

export type ListClaudeCodeLoginsResult =
  | { success: true; logins: ControllerClaudeCodeLogin[] }
  | ClaudeCodeLoginsFailure;

export type ClaudeCodeLoginResult = { success: true; login: ControllerClaudeCodeLogin } | ClaudeCodeLoginsFailure;

export type DeleteClaudeCodeLoginResult = { success: true } | ClaudeCodeLoginsFailure;

/** The most logins a person has (runtime-contracts' MAX_LOGINS). */
export const CLAUDE_CODE_MAX_LOGINS = 10;
/** The longest name a login takes, in characters, once trimmed. */
export const CLAUDE_CODE_LOGIN_LABEL_MAX_LENGTH = 60;

const LOGIN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// What a name never holds, as Desktop refuses it in the name its consent
// dialog shows, quoted, and the controller with it: a control character or a
// line or paragraph separator, which would break the dialog's line; half of
// a surrogate pair; a Unicode format character other than the zero-width
// joiner and non-joiner, which is invisible, and among which the
// text-direction marks, embeddings, overrides and isolates can make the
// dialog's question read as other words; and a double quote, since the
// dialog quotes the name. A name with any of them could be kept but set up
// on no computer.
const REFUSED_CHARACTER = /[\p{Cc}\p{Cs}\u2028\u2029"]|(?![\u200c\u200d])\p{Cf}/u;

/**
 * A name as the controller takes one: trimmed, 1-60 characters, on one line,
 * with no double quote and no invisible character; null for anything else.
 */
export function normalizeClaudeCodeLoginLabel(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const label = value.trim();
  const length = Array.from(label).length;
  return length >= 1 && length <= CLAUDE_CODE_LOGIN_LABEL_MAX_LENGTH && !REFUSED_CHARACTER.test(label)
    ? label
    : null;
}

function mapLogin(value: unknown): ControllerClaudeCodeLogin | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" && LOGIN_ID.test(record.id) ? record.id.toLowerCase() : null;
  const label = normalizeClaudeCodeLoginLabel(record.label);
  if (!id || !label) {
    return null;
  }
  return { id, label, createdAt: typeof record.createdAt === "string" ? record.createdAt : "" };
}

function failure(response: { error: string; code?: string }): ClaudeCodeLoginsFailure {
  return { success: false, error: response.error, code: response.code?.trim() || null };
}

/** The person's logins, oldest first, as the controller orders them: the first is their first login. */
export async function listClaudeCodeLogins(params?: { accessToken?: string | null }): Promise<ListClaudeCodeLoginsResult> {
  const response = await controllerJsonRequest<unknown>({
    path: "/me/claude-code-logins",
    accessToken: params?.accessToken ?? null,
    fallbackError: "Unable to load Claude Code logins",
  });
  if (!response.success) {
    return failure(response);
  }
  const listed = response.value && typeof response.value === "object"
    ? (response.value as { logins?: unknown }).logins
    : undefined;
  if (!Array.isArray(listed)) {
    return { success: false, error: "Controller response missing logins.", code: null };
  }
  const seen = new Set<string>();
  const logins: ControllerClaudeCodeLogin[] = [];
  for (const entry of listed) {
    const login = mapLogin(entry);
    if (login && !seen.has(login.id)) {
      seen.add(login.id);
      logins.push(login);
    }
  }
  return { success: true, logins };
}

/**
 * Adds a login named `label`: refused while local-engine turns aren't on for
 * the person (403 `claude_code_turn_not_allowed`), for a name that isn't one
 * (400 `claude_code_login_label_invalid`) or that another of their logins has
 * (409 `claude_code_login_label_taken`), and past ten (409 `claude_code_login_limit`).
 */
export async function createClaudeCodeLogin(
  label: string,
  params?: { accessToken?: string | null },
): Promise<ClaudeCodeLoginResult> {
  const response = await controllerJsonRequest<unknown>({
    path: "/me/claude-code-logins",
    method: "POST",
    accessToken: params?.accessToken ?? null,
    body: { label },
    fallbackError: "Unable to add a Claude Code login",
  });
  if (!response.success) {
    return failure(response);
  }
  const login = mapLogin(response.value);
  return login ? { success: true, login } : { success: false, error: "Controller response missing login.", code: null };
}

/** Renames one of the person's logins; 404 when it is not theirs. */
export async function renameClaudeCodeLogin(
  loginId: string,
  label: string,
  params?: { accessToken?: string | null },
): Promise<ClaudeCodeLoginResult> {
  const id = loginId.trim();
  if (!LOGIN_ID.test(id)) {
    return { success: false, error: "Missing login id.", code: null };
  }
  const response = await controllerJsonRequest<unknown>({
    path: `/me/claude-code-logins/${encodeURIComponent(id)}`,
    method: "PATCH",
    accessToken: params?.accessToken ?? null,
    body: { label },
    fallbackError: "Unable to rename the Claude Code login",
  });
  if (!response.success) {
    return failure(response);
  }
  const login = mapLogin(response.value);
  return login ? { success: true, login } : { success: false, error: "Controller response missing login.", code: null };
}

/**
 * Deletes one of the person's logins everywhere: agents that name it go back
 * to the person's first login. 404 when it is not theirs.
 */
export async function deleteClaudeCodeLogin(
  loginId: string,
  params?: { accessToken?: string | null },
): Promise<DeleteClaudeCodeLoginResult> {
  const id = loginId.trim();
  if (!LOGIN_ID.test(id)) {
    return { success: false, error: "Missing login id.", code: null };
  }
  const response = await controllerJsonRequest<unknown>({
    path: `/me/claude-code-logins/${encodeURIComponent(id)}`,
    method: "DELETE",
    accessToken: params?.accessToken ?? null,
    fallbackError: "Unable to delete the Claude Code login",
    allowEmptyResponse: true,
  });
  return response.success ? { success: true } : failure(response);
}
