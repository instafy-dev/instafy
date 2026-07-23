export type ComposerGhostSuggestion = {
  suggestion: string;
  remainder: string;
};

function normalizeSuggestionCandidate(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/\r/g, "").trimEnd();
  return normalized.trim().length > 0 ? normalized : null;
}

export function resolveComposerGhostSuggestion(
  inputValue: string,
  candidates: readonly string[],
): ComposerGhostSuggestion | null {
  const activeSuggestion = candidates.map(normalizeSuggestionCandidate).find((value): value is string => Boolean(value));
  if (!activeSuggestion) {
    return null;
  }

  const normalizedInput = inputValue.replace(/\r/g, "");
  if (normalizedInput.includes("\n")) {
    return null;
  }

  if (normalizedInput.length === 0) {
    return null;
  }

  if (normalizedInput.length >= activeSuggestion.length) {
    return null;
  }

  const directMatch = activeSuggestion.startsWith(normalizedInput);
  const caseInsensitiveMatch = activeSuggestion.toLocaleLowerCase().startsWith(normalizedInput.toLocaleLowerCase());
  if (!directMatch && !caseInsensitiveMatch) {
    return null;
  }

  return {
    suggestion: activeSuggestion,
    remainder: activeSuggestion.slice(normalizedInput.length),
  };
}
