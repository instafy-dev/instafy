import { useRoadmap } from "../../roadmap/RoadmapProvider";

export function useNextSteps() {
  const { suggestions, completeSuggestion, setSuggestions, appendSuggestions, buildPromptRoadmap, reset } =
    useRoadmap();

  return {
    suggestions,
    completeSuggestion,
    setSuggestions,
    appendSuggestions,
    buildPromptRoadmap,
    reset
  };
}
