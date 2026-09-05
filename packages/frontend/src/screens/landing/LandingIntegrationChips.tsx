import { GitHubIcon } from "../../components/IntegrationIcons";
import { DeepSeekIcon, GeminiIcon, KimiIcon, OpenAIIcon, ZaiIcon } from "../../components/ProviderIcons";

const integrations = [
  { id: "openai-codex", label: "OpenAI Codex", Icon: OpenAIIcon },
  { id: "github", label: "GitHub", Icon: GitHubIcon },
  { id: "deepseek", label: "DeepSeek", Icon: DeepSeekIcon },
  { id: "z-ai", label: "z.ai", Icon: ZaiIcon },
  { id: "gemini", label: "Gemini", Icon: GeminiIcon },
  { id: "kimi", label: "Kimi", Icon: KimiIcon, soon: true },
];

export function LandingIntegrationChips() {
  return (
    <ul className="flex flex-wrap items-center justify-center gap-x-6 gap-y-4" data-testid="landing-integrations">
      {integrations.map(({ id, label, Icon, soon }) => (
        <li
          key={id}
          className="inline-flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-400"
          data-testid={`integration-chip-${id}`}
        >
          <span aria-hidden="true"><Icon className="h-4 w-4" /></span>
          <span>{label}</span>
          {soon ? <span className="rounded border border-slate-200 px-1 py-0.5 text-[9px] dark:border-white/15">Soon</span> : null}
        </li>
      ))}
    </ul>
  );
}
