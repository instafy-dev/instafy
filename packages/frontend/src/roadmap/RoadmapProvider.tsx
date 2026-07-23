import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode
} from "react";
import type { NextStepSuggestion } from "../types";

interface RoadmapContextValue {
  suggestions: NextStepSuggestion[];
  setSuggestions: (entries: NextStepSuggestion[]) => void;
  appendSuggestions: (entries: NextStepSuggestion[]) => void;
  completeSuggestion: (suggestionId: string) => void;
  reset: () => void;
  buildPromptRoadmap: (prompt: string) => NextStepSuggestion[];
}

const RoadmapContext = createContext<RoadmapContextValue | null>(null);

function cloneSuggestion(entry: NextStepSuggestion): NextStepSuggestion {
  return { ...entry };
}

function dedupeSuggestions(entries: NextStepSuggestion[]): NextStepSuggestion[] {
  const seen = new Set<string>();
  const result: NextStepSuggestion[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      continue;
    }
    seen.add(entry.id);
    result.push(entry);
  }
  return result;
}

export function RoadmapProvider({ children }: { children: ReactNode }) {
  const [suggestions, setSuggestionState] = useState<NextStepSuggestion[]>([]);

  const setSuggestions = useCallback((entries: NextStepSuggestion[]) => {
    setSuggestionState(dedupeSuggestions(entries.map(cloneSuggestion)));
  }, []);

  const appendSuggestions = useCallback((entries: NextStepSuggestion[]) => {
    setSuggestionState((current) =>
      dedupeSuggestions([...current, ...entries.map(cloneSuggestion)])
    );
  }, []);

  const completeSuggestion = useCallback((suggestionId: string) => {
    setSuggestionState((current) => current.filter((entry) => entry.id !== suggestionId));
  }, []);

  const reset = useCallback(() => {
    setSuggestionState([]);
  }, []);

  const buildPromptRoadmap = useCallback((prompt: string): NextStepSuggestion[] => {
    const topic = prompt.length > 60 ? `${prompt.slice(0, 57)}…` : prompt;
    return [
      {
        id: "refine-brief",
        title: "Refine your brief",
        description: "Ask Instafy to expand the site with more details or pages.",
        prompt: `Refine the site experience for: ${topic}`,
        ctaLabel: "Draft follow-up",
        icon: "💡",
        badge: "Prompt",
        kind: "prompt",
        source: "system"
      },
      {
        id: "review-files",
        title: "Review the files",
        description: "Open the Files panel to inspect or tweak the generated workspace.",
        panel: "code",
        ctaLabel: "Open Files",
        icon: "📁",
        badge: "Workspace",
        kind: "panel",
        source: "system"
      },
      {
        id: "review-credits",
        title: "Check credits",
        description: "Open Credits to review usage, refill status, or upgrade your plan.",
        panel: "credits",
        ctaLabel: "Open Credits",
        icon: "💳",
        badge: "Billing",
        kind: "panel",
        source: "system"
      }
    ];
  }, []);

  const value = useMemo<RoadmapContextValue>(
    () => ({
      suggestions,
      setSuggestions,
      appendSuggestions,
      completeSuggestion,
      reset,
      buildPromptRoadmap
    }),
    [appendSuggestions, completeSuggestion, reset, setSuggestions, suggestions, buildPromptRoadmap]
  );

  return <RoadmapContext.Provider value={value}>{children}</RoadmapContext.Provider>;
}

export function useRoadmap(): RoadmapContextValue {
  const context = useContext(RoadmapContext);
  if (!context) {
    throw new Error("useRoadmap must be used within a RoadmapProvider");
  }
  return context;
}
