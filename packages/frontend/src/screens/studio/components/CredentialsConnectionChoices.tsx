import { EntityRow } from "../../../components/EntityRow";
import { DeepSeekIcon, GeminiIcon, OpenAIIcon, ZaiIcon } from "../../../components/ProviderIcons";
import type { CredentialsConnectModalStep } from "./CredentialsConnectModal";
import { shouldPromptForCodexAuthJsonUpload } from "./desktopCodexAuthJson";

type ConnectionChoiceContext = {
  canUseDesktopConnect: boolean;
  desktopCodexAuthJsonStatus: InstafyDesktopCodexAuthJsonStatus | null;
};

export function getCodexConnectionChoice({
  canUseDesktopConnect,
  desktopCodexAuthJsonStatus,
}: ConnectionChoiceContext) {
  return {
    title: canUseDesktopConnect ? "Codex on this computer" : "ChatGPT login",
    description: canUseDesktopConnect
      ? desktopCodexAuthJsonStatus?.exists
        ? "Use this computer's existing Codex login."
        : shouldPromptForCodexAuthJsonUpload(desktopCodexAuthJsonStatus)
          ? "Choose a Codex auth.json from this computer."
          : "Use this computer's Codex login."
      : "Use your ChatGPT subscription with a one-time device code.",
  };
}

/** Shared by the connection page and the chooser used elsewhere in Studio. */
export function CredentialsConnectionChoices({
  canUseDesktopConnect,
  desktopCodexAuthJsonStatus,
  isDisabled,
  onChoose,
  testIdPrefix = "credentials-connect-choice",
}: ConnectionChoiceContext & {
  isDisabled: boolean;
  onChoose: (step: CredentialsConnectModalStep) => void;
  testIdPrefix?: string;
}) {
  const codex = getCodexConnectionChoice({ canUseDesktopConnect, desktopCodexAuthJsonStatus });
  const choices = [
    { step: "codex", ...codex, Icon: OpenAIIcon },
    { step: "openai", title: "OpenAI API key", description: "Connect a key from the OpenAI API platform.", Icon: OpenAIIcon },
    { step: "deepseek", title: "DeepSeek API key", description: "Connect a key from your DeepSeek account.", Icon: DeepSeekIcon },
    { step: "zai", title: "z.ai API key", description: "Connect a key from your z.ai account.", Icon: ZaiIcon },
    { step: "gemini", title: "Google Gemini", description: "Connect a Gemini API key.", Icon: GeminiIcon },
  ] as const;

  return (
    <ul className="space-y-2" aria-label="Available AI connections">
      {choices.map(({ step, title, description, Icon }) => (
        <li key={step}>
          <EntityRow
            surface="outlined"
            density="compact"
            onPress={() => onChoose(step)}
            isDisabled={isDisabled}
            aria-label={`Connect ${title}`}
            data-testid={`${testIdPrefix}-${step}`}
            start={
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/90 text-slate-900 ring-1 ring-black/5 dark:bg-slate-950/40 dark:text-slate-50 dark:ring-white/10" aria-hidden="true">
                <Icon className="h-5 w-5" />
              </span>
            }
            title={title}
            titleClassName="!whitespace-normal"
            subtitle={description}
            subtitleClassName="!whitespace-normal"
            end={<span className="text-xs font-medium">Connect</span>}
          />
        </li>
      ))}
    </ul>
  );
}
