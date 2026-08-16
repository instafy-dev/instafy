import type { ReactNode } from "react";
import { Badge } from "../../components/Badge";
import { GitHubIcon } from "../../components/IntegrationIcons";
import { DeepSeekIcon, GeminiIcon, KimiIcon, OpenAIIcon, ZaiIcon } from "../../components/ProviderIcons";

type IntegrationStatus = "available" | "soon";

interface IntegrationChipDefinition {
  id: string;
  label: string;
  status: IntegrationStatus;
  icon: ReactNode;
  iconClassName: string;
  chipClassName: string;
}

const integrations: IntegrationChipDefinition[] = [
  {
    id: "openai-codex",
    label: "OpenAI Codex",
    status: "available",
    icon: <OpenAIIcon className="h-4 w-4" />,
    iconClassName: "text-slate-900 dark:text-slate-50",
    chipClassName: "-rotate-1 hover:rotate-0"
  },
  {
    id: "github",
    label: "GitHub",
    status: "available",
    icon: <GitHubIcon className="h-4 w-4" />,
    iconClassName: "text-slate-900 dark:text-slate-50",
    chipClassName: "-rotate-3 hover:rotate-0"
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    status: "available",
    icon: <DeepSeekIcon className="h-4 w-4" />,
    iconClassName: "text-emerald-600",
    chipClassName: "rotate-2 hover:rotate-0"
  },
  {
    id: "z-ai",
    label: "z.ai",
    status: "available",
    icon: <ZaiIcon className="h-4 w-4" />,
    iconClassName: "text-[#7C3AED]",
    chipClassName: "rotate-2 hover:rotate-0"
  },
  {
    id: "gemini",
    label: "Gemini",
    status: "available",
    icon: <GeminiIcon className="h-4 w-4" />,
    iconClassName: "",
    chipClassName: "-rotate-1 hover:rotate-0"
  },
  {
    id: "kimi",
    label: "Kimi",
    status: "soon",
    icon: <KimiIcon className="h-4 w-4" />,
    iconClassName: "",
    chipClassName: "rotate-1 hover:rotate-0"
  },
];

export function LandingIntegrationChips() {
  return (
    <div className="w-full">
      <ul className="flex flex-wrap items-center justify-center gap-2" data-testid="landing-integrations">
        {integrations.map((integration) => {
          const isSoon = integration.status === "soon";
          return (
            <li key={integration.id} className={integration.chipClassName}>
              <span
                className={[
                  "inline-flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-semibold shadow-sm backdrop-blur-md transition",
                  "border-slate-200/70 bg-white/70 text-slate-700 hover:-translate-y-0.5 hover:shadow-md",
                  "dark:border-slate-800/70 dark:bg-slate-950/60 dark:text-slate-100",
                  isSoon ? "opacity-80 hover:translate-y-0 hover:shadow-sm" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                data-testid={`integration-chip-${integration.id}`}
              >
                <span
                  className={[
                    "flex h-7 w-7 items-center justify-center rounded-full ring-1 ring-black/5 dark:ring-white/10",
                    "bg-white/90 dark:bg-slate-950/40",
                    integration.iconClassName,
                  ].join(" ")}
                  aria-hidden="true"
                >
                  {integration.icon}
                </span>
                <span className="whitespace-nowrap">{integration.label}</span>
                {isSoon ? (
                  <Badge size="xs">
                    Soon
                  </Badge>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
