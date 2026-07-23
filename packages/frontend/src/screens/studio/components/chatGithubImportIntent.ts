import { parseGithubRepoOwnerName } from "../../../services/runtimeController/githubImportPath";

const DIRECT_IMPORT_INTENT =
  /(?:^|[.!?]\s+|\b(?:please|also|then|now)\s*,?\s*|\band\s+)(?:import|clone|pull|load)\b|\b(?:can|could|would|will)\s+(?:you|we)\s+(?:please\s+)?(?:import|clone|pull|load)\b|\bi\s+(?:want|need|would\s+like|plan)\s+to\s+(?:import|clone|pull|load)\b|\blet'?s\s+(?:import|clone|pull|load)\b|\b(?:we|you)\s+should\s+(?:import|clone|pull|load)\b/i;
const REPO_ADD_INTENT =
  /\b(?:bring|add)\b.{0,40}\b(?:repo|repository|project)\b/i;
const REQUESTED_WORK_INTENT =
  /\b(?:(?:i\s+(?:want|need|would\s+like|plan)\s+to)|(?:(?:can|could|would)\s+(?:you|we))|please|let'?s)\s+(?:(?:start|continue)(?:\s+to)?\s+)?work(?:ing)?\s+(?:on|with)\b|\b(?:start|continue)\s+working\s+(?:on|with)\b/i;
const DELIBERATIVE_IMPORT_INTENT =
  /\b(?:do|did|can|could|would)\s+(?:you|we)\s+(?:(?:really|actually)\s+)?(?:think|believe|feel|agree|recommend|suggest|advise|discuss|consider|decide|tell)\b[^.!?\n]{0,120}\b(?:we|you)\s+should\s+(?:import|clone|pull|load)\b|\bwhat\s+do\s+you\s+think\b[^.!?\n]{0,120}\b(?:we|you)\s+should\s+(?:import|clone|pull|load)\b/i;
const NEGATED_IMPORT_INTENT =
  /\b(?:(?:do\s+not|don't|dont|never|no\s+need\s+to)\b.{0,48}|not\b.{0,48})(?:import|clone|pull|load|bring|add|work)\b|\bwithout\s+(?:importing|cloning|pulling|loading|adding|working)\b/i;

/**
 * Returns a root GitHub repository URL only when the message also contains an
 * affirmative import/workspace intent. Merely discussing, reviewing, or
 * linking a repository must never mutate the workspace.
 */
export function extractExplicitGithubRepoReference(message: string): string | null {
  const affirmative =
    DIRECT_IMPORT_INTENT.test(message) ||
    REPO_ADD_INTENT.test(message) ||
    REQUESTED_WORK_INTENT.test(message);
  if (
    !affirmative ||
    DELIBERATIVE_IMPORT_INTENT.test(message) ||
    NEGATED_IMPORT_INTENT.test(message)
  ) {
    return null;
  }
  const candidates = message
    .split(/\s+/)
    .map((part) => part.trim().replace(/^[<([{]+|[>),.]+$/g, ""))
    .filter((part) => part.length > 0);

  for (const candidate of candidates) {
    if (!/^https?:\/\/(?:www\.)?github\.com\//i.test(candidate)) {
      continue;
    }
    if (parseGithubRepoOwnerName(candidate)) {
      return candidate;
    }
  }
  return null;
}
