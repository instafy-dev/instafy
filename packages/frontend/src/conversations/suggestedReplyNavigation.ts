type ResolveNextSuggestedReplyForTabCycleInput = {
  inputValue: string;
  suggestions: string[];
};

export function resolveNextSuggestedReplyForTabCycle({
  inputValue,
  suggestions,
}: ResolveNextSuggestedReplyForTabCycleInput): string | null {
  const normalizedSuggestions = suggestions.map((value) => value.trim()).filter((value) => value.length > 0);
  if (normalizedSuggestions.length === 0) {
    return null;
  }

  const trimmedInput = inputValue.trim();
  if (!trimmedInput) {
    return normalizedSuggestions[0] ?? null;
  }

  const currentIndex = normalizedSuggestions.findIndex((value) => value === trimmedInput);
  if (currentIndex < 0) {
    return null;
  }

  const nextIndex = (currentIndex + 1) % normalizedSuggestions.length;
  return normalizedSuggestions[nextIndex] ?? null;
}
