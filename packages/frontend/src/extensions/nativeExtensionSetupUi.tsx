import type { ReactNode } from "react";
import { Text } from "../components/Text";
import type { TextTone } from "../styles/typography";

export function NativeExtensionSetupStatus({
  title,
  detail,
  tone = "secondary",
  testId,
}: {
  title: ReactNode;
  detail?: ReactNode;
  tone?: TextTone;
  testId?: string;
}) {
  return (
    <div className="space-y-1" data-testid={testId}>
      <Text as="p" variant="bodyStrong" tone={tone}>
        {title}
      </Text>
      {detail ? (
        <Text as="p" variant="caption" tone="muted">
          {detail}
        </Text>
      ) : null}
    </div>
  );
}

export function NativeExtensionActionRow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={["flex flex-wrap items-center gap-2", className].filter(Boolean).join(" ")}>
      {children}
    </div>
  );
}

export function NativeExtensionMetaLine({
  children,
  className,
  tone = "muted",
  testId,
}: {
  children: ReactNode;
  className?: string;
  tone?: TextTone;
  testId?: string;
}) {
  return (
    <Text
      as="p"
      variant="caption"
      tone={tone}
      className={["text-xxs", className].filter(Boolean).join(" ")}
      data-testid={testId}
    >
      {children}
    </Text>
  );
}

export function NativeExtensionDetailCard({
  children,
  className,
  testId,
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      className={[
        "space-y-2 rounded-xl border border-slate-200/70 bg-white/70 px-3 py-3 dark:border-slate-800 dark:bg-slate-950/30",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

export function NativeExtensionDeviceCard({
  title,
  eyebrow,
  meta = [],
  summary,
  summaryTone = "secondary",
  end,
  children,
  className,
  testId,
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  meta?: ReactNode[];
  summary?: ReactNode;
  summaryTone?: TextTone;
  end?: ReactNode;
  children?: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <NativeExtensionDetailCard className={className} testId={testId}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          {eyebrow ? (
            <Text as="p" variant="caption" tone="secondary">
              {eyebrow}
            </Text>
          ) : null}
          <Text as="p" variant="bodyStrong" tone="primary">
            {title}
          </Text>
          {meta.filter(Boolean).map((item, index) => (
            <NativeExtensionMetaLine key={index}>{item}</NativeExtensionMetaLine>
          ))}
        </div>
        {end ? <div className="shrink-0">{end}</div> : null}
      </div>
      {summary ? (
        <Text as="p" variant="caption" tone={summaryTone} className="leading-5">
          {summary}
        </Text>
      ) : null}
      {children}
    </NativeExtensionDetailCard>
  );
}

export function NativeExtensionRawOutput({
  title = "Raw diagnostics",
  output,
  testId,
  maxHeightClassName = "max-h-72",
}: {
  title?: ReactNode;
  output: ReactNode;
  testId?: string;
  maxHeightClassName?: string;
}) {
  return (
    <div className="space-y-2">
      {title ? (
        <NativeExtensionMetaLine tone="secondary">{title}</NativeExtensionMetaLine>
      ) : null}
      <div className="overflow-hidden rounded-xl border border-slate-200/70 bg-slate-950/95 font-mono text-xs shadow-sm shadow-slate-900/10 dark:border-white/10 dark:bg-slate-950">
        <pre
          className={[
            maxHeightClassName,
            "overflow-auto whitespace-pre-wrap break-words px-3 py-2 text-slate-100",
          ]
            .filter(Boolean)
            .join(" ")}
          data-testid={testId}
        >
          {output}
        </pre>
      </div>
    </div>
  );
}

export function NativeExtensionDeveloperPanel({
  children,
  rawOutput,
  outputTestId,
  testId,
  maxHeightClassName = "max-h-64",
}: {
  children?: ReactNode;
  rawOutput?: ReactNode;
  outputTestId?: string;
  testId?: string;
  maxHeightClassName?: string;
}) {
  return (
    <NativeExtensionDetailCard
      className="rounded-2xl bg-slate-50/80 dark:bg-slate-900/40"
      testId={testId}
    >
      {children}
      {rawOutput !== undefined ? (
        <NativeExtensionRawOutput
          title={null}
          output={rawOutput}
          testId={outputTestId}
          maxHeightClassName={maxHeightClassName}
        />
      ) : null}
    </NativeExtensionDetailCard>
  );
}
