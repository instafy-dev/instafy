import { Button } from "../../../components/Button";
import { openExternalUrl } from "../../../utils/openExternalUrl";

const CHATGPT_DEVICE_CODE_HELP_URL =
  "https://learn.chatgpt.com/docs/auth#preferred-device-code-authentication-beta";

type ChatGptDeviceCodePrerequisiteProps = {
  busy: boolean;
  disabled?: boolean;
  onContinue: () => void;
  containerId?: string;
  containerTestId?: string;
  helpTestId?: string;
  continueTestId?: string;
  containerClassName?: string;
  continueClassName?: string;
};

export function ChatGptDeviceCodePrerequisite({
  busy,
  disabled = false,
  onContinue,
  containerId,
  containerTestId,
  helpTestId,
  continueTestId,
  containerClassName =
    "rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-300",
  continueClassName = "mt-2",
}: ChatGptDeviceCodePrerequisiteProps) {
  return (
    <div id={containerId} className={containerClassName} data-testid={containerTestId}>
      <div className="font-semibold text-slate-800 dark:text-slate-100">Before you get a code</div>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs leading-relaxed">
        <li>In ChatGPT, open Settings → Security.</li>
        <li>Turn on device-code authorization.</li>
      </ol>
      <div className="mt-2 text-xs leading-relaxed">
        Using a managed ChatGPT workspace? A workspace admin must allow device-code login in workspace
        permissions first.
      </div>
      <Button
        onPress={() => void openExternalUrl(CHATGPT_DEVICE_CODE_HELP_URL)}
        variant="ghost"
        size="sm"
        radius="full"
        fullWidth
        className="mt-2 min-h-11 justify-start px-3 text-primary-600 dark:text-primary-400"
        data-testid={helpTestId}
      >
        OpenAI setup help ↗
      </Button>
      <Button
        onPress={onContinue}
        isDisabled={disabled || busy}
        variant="primary"
        size="sm"
        radius="full"
        fullWidth
        className={continueClassName}
        data-testid={continueTestId}
      >
        {busy ? "Generating code…" : "I’ve enabled it — get a code"}
      </Button>
    </div>
  );
}
