import { Button } from "../../../components/Button";
import { Text } from "../../../components/Text";

type ChatGptDeviceCodeDisabledNoticeProps = {
  busy: boolean;
  onTryAgain: () => void;
  onBack: () => void;
  className?: string;
  testId?: string;
};

/**
 * Shown in place of a device code when OpenAI says device-code login is off.
 * That code can never be approved, so there is nothing to copy or open: only
 * how to turn it on, and a fresh attempt once it is.
 */
export function ChatGptDeviceCodeDisabledNotice({
  busy,
  onTryAgain,
  onBack,
  className = "rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-300",
  testId,
}: ChatGptDeviceCodeDisabledNoticeProps) {
  return (
    <div className={className} data-testid={testId}>
      <div role="alert">
        <Text as="div" variant="bodyStrong" tone="inherit" className="text-slate-800 dark:text-slate-100">
          ChatGPT device-code login is off
        </Text>
        <Text as="div" variant="caption" tone="muted" className="mt-1 text-xs leading-relaxed">
          In ChatGPT, open Settings, then Security, and turn on device-code authorization. Then try
          again.
        </Text>
      </div>
      <Text as="div" variant="caption" tone="muted" className="mt-1 text-xs leading-relaxed">
        On a ChatGPT workspace, an admin must allow device-code login in workspace permissions first.
      </Text>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button onPress={onTryAgain} variant="primary" size="sm" radius="full" isDisabled={busy}>
          Try again
        </Button>
        <Button onPress={onBack} variant="ghost" size="sm" radius="full" isDisabled={busy}>
          Back
        </Button>
      </div>
    </div>
  );
}
