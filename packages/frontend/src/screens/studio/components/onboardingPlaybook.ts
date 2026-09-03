import type { ComponentType } from "react";
import {
  CodeBrackets,
  Github,
  GraphUp,
  Microscope,
  Page,
  Search,
} from "iconoir-react";

export type OnboardingActionKind = "prompt" | "github_import";

export type OnboardingPathId = "coding" | "finance" | "science" | "connect";

export type OnboardingAction = {
  id: string;
  title: string;
  description: string;
  kind: OnboardingActionKind;
  prompt?: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
};

export type PromptOnboardingAction = OnboardingAction & {
  kind: "prompt";
  prompt: string;
};

export type OnboardingPath = {
  id: OnboardingPathId;
  title: string;
  description: string;
  prompt: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  actions: OnboardingAction[];
};

export const ONBOARDING_PATHS: OnboardingPath[] = [
  {
    id: "coding",
    title: "Coding",
    description: "Import a repo, start from scratch, or shape a product idea into code.",
    prompt:
      "Help me build something in this space. Start by asking what I want to ship, whether I already have code or a GitHub repo, and whether I should start from scratch or import existing work.",
    icon: CodeBrackets,
    actions: [
      {
        id: "import-github-repo",
        title: "Import a GitHub repo",
        description: "Copy its files into your workspace — or just paste a repo link in chat.",
        kind: "github_import",
        icon: Github,
      },
      {
        id: "start-from-scratch",
        title: "Start from scratch",
        description: "A blank workspace — turn an idea into an app, tool, or prototype.",
        kind: "prompt",
        prompt:
          "I'm starting from a blank workspace. What I want to build: <describe it here>. Create the smallest useful first version as real files and commit it, then summarize what you built and suggest the next step.",
        icon: CodeBrackets,
      },
      {
        id: "build-with-code",
        title: "Build with code",
        description: "Turn an idea into an app, tool, or prototype.",
        kind: "prompt",
        prompt:
          "Help me build something in this space. Start by asking what I want to ship, who it is for, whether I already have code, and what the smallest useful first version should be.",
        icon: CodeBrackets,
      },
      {
        id: "build-landing-page",
        title: "Build a landing page",
        description: "Turn an offer into structure, copy, and next steps.",
        kind: "prompt",
        prompt:
          "I want to build a landing page in this space. Ask me a few sharp questions about the offer, audience, proof, and tone, then help me structure the page and the first implementation steps.",
        icon: Page,
      },
    ],
  },
  {
    id: "finance",
    title: "Finance",
    description: "Analyze a company, compare players, or track a market with structure.",
    prompt:
      "Help me with a finance workflow in this space. Start by asking whether I want company analysis, competitor comparison, market tracking, or valuation thinking.",
    icon: GraphUp,
    actions: [
      {
        id: "analyze-company",
        title: "Analyze a company",
        description: "Break down strategy, numbers, risks, and market position.",
        kind: "prompt",
        prompt:
          "Help me analyze a company. Start by asking which company I care about, whether I want strategic, financial, or competitive analysis, and what depth I want.",
        icon: GraphUp,
      },
      {
        id: "compare-companies",
        title: "Compare companies",
        description: "Evaluate competitors side by side and find the real differences.",
        kind: "prompt",
        prompt:
          "Help me compare companies. Start by asking which companies I want to compare, what matters most to me, and whether I care more about growth, margins, product quality, or competitive position.",
        icon: GraphUp,
      },
      {
        id: "track-market-news",
        title: "Track market news",
        description: "Monitor brands, sectors, and catalysts that actually matter.",
        kind: "prompt",
        prompt:
          "Help me build a finance and market tracking workflow in this space. Ask what sectors, companies, keywords, or catalysts I want to monitor, then suggest a sharp way to track them.",
        icon: Search,
      },
    ],
  },
  {
    id: "science",
    title: "Science",
    description: "Explore a topic, unpack a paper, or compare approaches without starting blank.",
    prompt:
      "Help me with a science workflow in this space. Start by asking what topic, paper, or question I care about and whether I want explanation, comparison, or a research map.",
    icon: Microscope,
    actions: [
      {
        id: "explore-science-topic",
        title: "Explore a topic",
        description: "Map a subject area and find the important concepts fast.",
        kind: "prompt",
        prompt:
          "Help me explore a science topic. Start by asking what topic I care about, my background level, and whether I want a broad overview, deep explanation, or study plan.",
        icon: Microscope,
      },
      {
        id: "explain-paper",
        title: "Explain a paper",
        description: "Turn a dense paper into a clear walkthrough.",
        kind: "prompt",
        prompt:
          "Help me understand a scientific paper. Start by asking for the paper or topic, then guide me through the claim, method, evidence, limitations, and what to read next.",
        icon: Page,
      },
      {
        id: "compare-approaches",
        title: "Compare approaches",
        description: "Contrast methods, tradeoffs, and where each one fits.",
        kind: "prompt",
        prompt:
          "Help me compare scientific approaches. Start by asking what methods, models, or theories I want to compare and which tradeoffs or constraints matter most.",
        icon: GraphUp,
      },
    ],
  },
  {
    id: "connect",
    title: "Connect GitHub",
    description: "Bring your repos, issues, and pull requests into this space.",
    prompt:
      "Help me connect GitHub to this space. Start by asking which repository or organization I want to work with, what I want to monitor or automate, and how I want updates surfaced.",
    icon: Github,
    actions: [
      {
        id: "connect-github",
        title: "Connect GitHub",
        description: "Track repos, issues, pull requests, and release activity.",
        kind: "prompt",
        prompt:
          "Help me connect GitHub to this space. Ask which repository or organization I want to work with, whether I care most about issues, pull requests, commits, or releases, and how I want updates surfaced.",
        icon: Github,
      },
    ],
  },
];

