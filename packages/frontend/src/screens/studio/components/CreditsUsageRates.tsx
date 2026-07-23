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
  displayCurrency: string;
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

export function formatUnits(value: number, unitLabel: string): string {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)} ${unitLabel}`;
}

function formatUsdAmount(value: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
    minimumFractionDigits: value >= 10 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatUsdMicros(value: number, currency: string): string {
  return formatUsdAmount(value / 1_000_000, currency);
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

export function CreditsUsageRates({
  usageRateRows,
  managedAiUsage,
  unitLabel,
  displayCurrency,
}: CreditsUsageRatesProps) {
  const managedAiProviderLabel = formatProviderLabel(managedAiUsage?.provider);

  return (
    <div className="@container space-y-2" data-testid="credits-usage-rates">
      <div className="space-y-2">
        <Heading level={4} variant="caption">
          Active services
        </Heading>

        <div
          className="divide-y divide-slate-200 overflow-hidden rounded-2xl border border-slate-200 @sm:hidden dark:divide-slate-800 dark:border-slate-800"
          data-testid="credits-active-services-mobile"
        >
          {usageRateRows.map(({ key, label, rate }) => (
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
          {usageRateRows.map(({ key, label, rate }) => (
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
      </div>

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
                  {formatUnits(managedAiUsage.creditsPerPrompt, unitLabel)}/prompt
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
              <div className="col-span-2 min-w-0">
                <dt className="text-xs font-medium text-slate-500 dark:text-slate-400">Token pricing</dt>
                <dd className="mt-1 grid min-w-0 grid-cols-1 gap-1 text-xs leading-5 text-slate-600 dark:text-slate-300">
                  <span className="min-w-0 break-words">
                    Input {formatUsdMicros(managedAiUsage.inputUsdMicrosPer1k * 1000, displayCurrency)}/1M
                  </span>
                  <span className="min-w-0 break-words">
                    Cached{" "}
                    {formatUsdMicros(
                      managedAiUsage.cachedInputUsdMicrosPer1k * 1000,
                      displayCurrency,
                    )}
                    /1M
                  </span>
                  <span className="min-w-0 break-words">
                    Output {formatUsdMicros(managedAiUsage.outputUsdMicrosPer1k * 1000, displayCurrency)}/1M
                  </span>
                </dd>
              </div>
            </dl>
          </div>

          <div
            className="hidden overflow-hidden rounded-2xl border border-slate-200 @sm:block dark:border-slate-800"
            data-testid="credits-prompt-usage-table"
          >
            <div className="grid grid-cols-5 gap-2 bg-slate-50/70 px-3 py-2 text-xs font-semibold text-slate-600 dark:bg-slate-900/40 dark:text-slate-300">
              <span>Service</span>
              <span>Reserve</span>
              <span>Token pricing</span>
              <span>Daily cap</span>
              <span>Status</span>
            </div>
            <div className="grid grid-cols-5 items-center gap-2 border-t border-slate-200 px-3 py-2 text-sm text-slate-700 dark:border-slate-800 dark:text-slate-200">
              <span className="font-medium">
                {managedAiUsage.label}
                <span className="mt-0.5 block text-xs font-normal text-slate-500 dark:text-slate-400">
                  {managedAiProviderLabel ? `${managedAiProviderLabel} · ` : null}
                  {managedAiUsage.modelLabel}
                </span>
              </span>
              <span>{formatUnits(managedAiUsage.creditsPerPrompt, unitLabel)}/prompt</span>
              <span className="text-xs leading-5 text-slate-500 dark:text-slate-400">
                In {formatUsdMicros(managedAiUsage.inputUsdMicrosPer1k * 1000, displayCurrency)}/1M
                <br />
                Cached{" "}
                {formatUsdMicros(
                  managedAiUsage.cachedInputUsdMicrosPer1k * 1000,
                  displayCurrency,
                )}
                /1M
                <br />
                Out {formatUsdMicros(managedAiUsage.outputUsdMicrosPer1k * 1000, displayCurrency)}/1M
              </span>
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
            Managed AI prompt usage is charged from actual input/cached/output tokens after the run
            completes. The reserve prompt debit is reconciled against the final token-based cost on the
            shared ledger.
          </Text>
        </div>
      ) : null}
    </div>
  );
}
