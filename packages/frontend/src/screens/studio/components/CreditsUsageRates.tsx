import { Badge } from "../../../components/Badge";
import { Heading } from "../../../components/Heading";
import { Text } from "../../../components/Text";
import type { CreditUsageRate, ManagedAiUsageRate } from "../../../credits/creditService";

export interface CreditsUsageRateRow {
  key: string;
  label: string;
  rate: Pick<CreditUsageRate, "enabled" | "intervalSeconds" | "creditsPerMinute">;
}

interface CreditsUsageRatesProps {
  usageRateRows: CreditsUsageRateRow[];
  managedAiUsage: ManagedAiUsageRate | null;
  unitLabel: string;
}

export function formatIntervalSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "—";
  }
  const minutes = seconds / 60;
  if (minutes >= 60) {
    const hours = minutes / 60;
    return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
  }
  return Number.isInteger(minutes) ? `${minutes}m` : `${minutes.toFixed(1)}m`;
}

export function formatCreditsPerMinute(value: number): string {
  if (!Number.isFinite(value)) {
    return "—";
  }
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

/** `unitLabel` for an amount of `value`: "1 credit", "2 credits". */
export function unitFor(value: number, unitLabel: string): string {
  return Math.abs(value) === 1 ? unitLabel.replace(/s$/, "") : unitLabel;
}

export function formatUnits(value: number, unitLabel: string): string {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)} ${unitFor(value, unitLabel)}`;
}

export function formatProviderLabel(provider: string | null | undefined): string | null {
  const trimmed = provider?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.toLowerCase() === "openai" ? "OpenAI" : trimmed;
}

function UsageStatus({ enabled, disabledLabel }: { enabled: boolean; disabledLabel: string }) {
  return enabled ? (
    <Badge size="sm" tone="success">
      Metered
    </Badge>
  ) : (
    <Badge size="sm">{disabledLabel}</Badge>
  );
}

/**
 * What a message and a running service cost, in the person's units. Prices
 * per million tokens are the operator's, and a service that costs nothing a
 * minute is no rate: neither shows.
 */
export function CreditsUsageRates({
  usageRateRows,
  managedAiUsage,
  unitLabel,
}: CreditsUsageRatesProps) {
  const managedAiProviderLabel = formatProviderLabel(managedAiUsage?.provider);
  const meteredRows = usageRateRows.filter(({ rate }) => rate.enabled && rate.creditsPerMinute > 0);

  return (
    <div className="@container space-y-2" data-testid="credits-usage-rates">
      {meteredRows.length > 0 ? <div className="space-y-2">
        <Heading level={4} variant="caption">
          Active services
        </Heading>

        <div
          className="divide-y divide-slate-200 overflow-hidden rounded-2xl border border-slate-200 @sm:hidden dark:divide-slate-800 dark:border-slate-800"
          data-testid="credits-active-services-mobile"
        >
          {meteredRows.map(({ key, label, rate }) => (
            <div className="min-w-0 space-y-3 px-3 py-3" key={key}>
              <div className="flex min-w-0 items-start justify-between gap-3">
                <span className="min-w-0 break-words text-sm font-medium text-slate-700 dark:text-slate-200">
                  {label}
                </span>
                <span className="shrink-0">
                  <UsageStatus enabled={rate.enabled} disabledLabel="Not metered" />
                </span>
              </div>
              <dl className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-2 text-sm">
                <div className="min-w-0">
                  <dt className="text-xs font-medium text-slate-500 dark:text-slate-400">Credits/min</dt>
                  <dd className="mt-0.5 break-words text-slate-700 dark:text-slate-200">
                    {formatCreditsPerMinute(rate.creditsPerMinute)}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs font-medium text-slate-500 dark:text-slate-400">Billing interval</dt>
                  <dd className="mt-0.5 break-words text-slate-700 dark:text-slate-200">
                    {formatIntervalSeconds(rate.intervalSeconds)}
                  </dd>
                </div>
              </dl>
            </div>
          ))}
        </div>

        <div
          className="hidden overflow-hidden rounded-2xl border border-slate-200 @sm:block dark:border-slate-800"
          data-testid="credits-active-services-table"
        >
          <div className="grid grid-cols-4 gap-2 bg-slate-50/70 px-3 py-2 text-xs font-semibold text-slate-600 dark:bg-slate-900/40 dark:text-slate-300">
            <span>Service</span>
            <span>Credits/min</span>
            <span>Billing interval</span>
            <span>Status</span>
          </div>
          {meteredRows.map(({ key, label, rate }) => (
            <div
              key={key}
              className="grid grid-cols-4 items-center gap-2 border-t border-slate-200 px-3 py-2 text-sm text-slate-700 dark:border-slate-800 dark:text-slate-200"
            >
              <span className="font-medium">{label}</span>
              <span>{formatCreditsPerMinute(rate.creditsPerMinute)}</span>
              <span>{formatIntervalSeconds(rate.intervalSeconds)}</span>
              <span>
                <UsageStatus enabled={rate.enabled} disabledLabel="Not metered" />
              </span>
            </div>
          ))}
        </div>
      </div> : null}

      {managedAiUsage ? (
        <div className="space-y-2">
          <Heading level={4} variant="caption">
            Prompt usage
          </Heading>

          <div
            className="overflow-hidden rounded-2xl border border-slate-200 p-3 @sm:hidden dark:border-slate-800"
            data-testid="credits-prompt-usage-mobile"
          >
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="break-words text-sm font-medium text-slate-700 dark:text-slate-200">
                  {managedAiUsage.label}
                </div>
                <div className="mt-0.5 break-words text-xs text-slate-500 dark:text-slate-400">
                  {managedAiProviderLabel ? `${managedAiProviderLabel} · ` : null}
                  {managedAiUsage.modelLabel}
                </div>
              </div>
              <span className="shrink-0">
                <UsageStatus enabled={managedAiUsage.enabled} disabledLabel="Disabled" />
              </span>
            </div>

            <dl className="mt-3 grid min-w-0 grid-cols-2 gap-x-3 gap-y-3 text-sm">
              <div className="min-w-0">
                <dt className="text-xs font-medium text-slate-500 dark:text-slate-400">Reserve</dt>
                <dd className="mt-0.5 break-words text-slate-700 dark:text-slate-200">
                  From {formatUnits(managedAiUsage.creditsPerPrompt, unitLabel)} a message
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs font-medium text-slate-500 dark:text-slate-400">Daily cap</dt>
                <dd className="mt-0.5 break-words text-slate-700 dark:text-slate-200">
                  {managedAiUsage.dailyPromptLimit > 0
                    ? `${managedAiUsage.dailyPromptLimit} prompts/day`
                    : "No daily cap"}
                </dd>
              </div>
            </dl>
          </div>

          <div
            className="hidden overflow-hidden rounded-2xl border border-slate-200 @sm:block dark:border-slate-800"
            data-testid="credits-prompt-usage-table"
          >
            <div className="grid grid-cols-4 gap-2 bg-slate-50/70 px-3 py-2 text-xs font-semibold text-slate-600 dark:bg-slate-900/40 dark:text-slate-300">
              <span>Service</span>
              <span>Reserve</span>
              <span>Daily cap</span>
              <span>Status</span>
            </div>
            <div className="grid grid-cols-4 items-center gap-2 border-t border-slate-200 px-3 py-2 text-sm text-slate-700 dark:border-slate-800 dark:text-slate-200">
              <span className="font-medium">
                {managedAiUsage.label}
                <span className="mt-0.5 block text-xs font-normal text-slate-500 dark:text-slate-400">
                  {managedAiProviderLabel ? `${managedAiProviderLabel} · ` : null}
                  {managedAiUsage.modelLabel}
                </span>
              </span>
              <span>From {formatUnits(managedAiUsage.creditsPerPrompt, unitLabel)} a message</span>
              <span>
                {managedAiUsage.dailyPromptLimit > 0
                  ? `${managedAiUsage.dailyPromptLimit} prompts/day`
                  : "No daily cap"}
              </span>
              <span>
                <UsageStatus enabled={managedAiUsage.enabled} disabledLabel="Disabled" />
              </span>
            </div>
          </div>

          <Text variant="caption" tone="muted">
            Each message holds {formatUnits(managedAiUsage.creditsPerPrompt, unitLabel)}, then costs what it used.
          </Text>
        </div>
      ) : null}
    </div>
  );
}
