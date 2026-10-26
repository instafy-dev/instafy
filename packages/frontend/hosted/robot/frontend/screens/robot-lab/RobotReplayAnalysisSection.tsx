import {
  Badge,
  Button,
  Card,
  Heading,
  Input,
  Text,
  Toggle,
  type BadgeProps,
} from "@instafy/frontend/feature-api/ui";
import type {
  ReplayApplySummary,
  ReplayHarnessReport,
} from "../../robot";

type ReplayDeltaItem = {
  label: string;
  deltaText: string;
  detail: string;
};

type RobotReplayAnalysisSectionProps = {
  replayBadgeTone: BadgeProps["tone"];
  replayBusy: boolean;
  replayErrorText: string | null;
  replayStatusText: string;
  replayReportPath: string | null;
  replayReport: ReplayHarnessReport | null;
  replaySamples: number;
  replaySeed: number;
  replayApplyLastFrame: boolean;
  onReplaySamplesChange: (value: string) => void;
  onReplaySeedChange: (value: string) => void;
  onReplayApplyLastFrameChange: (value: boolean) => void;
  onRunReplayAnalysis: () => void;
  onRefreshReplayReport: () => void;
  onApplyReplayRecommendation: () => void;
  replayScoreDelta: number;
  replayEvaluationTone: BadgeProps["tone"];
  replayEvaluationDecision: string | null;
  replayEvaluationSummary: string | null;
  replayEvaluationReason: string | null;
  replayEvaluationComparisonSummary: string | null;
  replayEvaluationPath: string | null;
  replayEvaluationErrorText: string | null;
  replayEvidenceWindowText: string | null;
  replayDeltaItems: ReplayDeltaItem[];
  replayApplySummary: ReplayApplySummary | null;
};

function roundToHundredths(value: number) {
  return Math.round(value * 100) / 100;
}

export function RobotReplayAnalysisSection({
  replayBadgeTone,
  replayBusy,
  replayErrorText,
  replayStatusText,
  replayReportPath,
  replayReport,
  replaySamples,
  replaySeed,
  replayApplyLastFrame,
  onReplaySamplesChange,
  onReplaySeedChange,
  onReplayApplyLastFrameChange,
  onRunReplayAnalysis,
  onRefreshReplayReport,
  onApplyReplayRecommendation,
  replayScoreDelta,
  replayEvaluationTone,
  replayEvaluationDecision,
  replayEvaluationSummary,
  replayEvaluationReason,
  replayEvaluationComparisonSummary,
  replayEvaluationPath,
  replayEvaluationErrorText,
  replayEvidenceWindowText,
  replayDeltaItems,
  replayApplySummary,
}: RobotReplayAnalysisSectionProps) {
  const replayBadgeLabel = replayErrorText
    ? "Replay error"
    : replayReport?.has_recommended_adaptation_update
      ? "Recommendation ready"
      : replayReport
        ? "Baseline holds"
        : "Idle";

  return (
    <Card
      padding="lg"
      className="border-white/70 bg-white/72 shadow-modal backdrop-blur"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <Text variant="overline" tone="muted">
            Replay Loop
          </Text>
          <Heading level={2} variant="title" className="mt-1">
            Unity replay analysis
          </Heading>
        </div>
        <Badge tone={replayBadgeTone}>{replayBadgeLabel}</Badge>
      </div>

      <Text variant="body" tone="secondary" className="mt-3">
        Run the Unity replay harness on the current session, inspect the latest report, and
        import any recommended adaptation back through the normal session/profile path.
      </Text>

      <div className="mt-4 grid gap-4 sm:grid-cols-[0.8fr_0.8fr_1fr]">
        <div className="space-y-2">
          <Text variant="caption" tone="muted">
            Randomized samples
          </Text>
          <Input
            type="number"
            step="1"
            min="1"
            value={replaySamples}
            onChange={(event) => onReplaySamplesChange(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Text variant="caption" tone="muted">
            Random seed
          </Text>
          <Input
            type="number"
            step="1"
            value={replaySeed}
            onChange={(event) => onReplaySeedChange(event.target.value)}
          />
        </div>
        <div className="flex items-end">
          <Toggle
            isSelected={replayApplyLastFrame}
            onChange={onReplayApplyLastFrameChange}
            label="Apply final frame to Unity scene"
          />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-3">
        <Button variant="primary" onPress={onRunReplayAnalysis} isDisabled={replayBusy}>
          {replayBusy ? "Running replay…" : "Run replay harness"}
        </Button>
        <Button variant="outline" onPress={onRefreshReplayReport} isDisabled={replayBusy}>
          Refresh report
        </Button>
        <Button
          variant="secondary"
          onPress={onApplyReplayRecommendation}
          isDisabled={replayBusy || !replayReport?.has_recommended_adaptation_update}
        >
          Apply recommendation
        </Button>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-[0.9fr_1.1fr]">
        <Card tone="muted" padding="md" className="border-slate-200/70 bg-white/75">
          <Text variant="caption" tone="muted">
            Replay status
          </Text>
          <Heading level={3} variant="subtitle" className="mt-2">
            {replayStatusText}
          </Heading>
          {replayReportPath ? (
            <Text variant="caption" tone="muted" className="mt-2 break-all">
              {replayReportPath}
            </Text>
          ) : null}
          {replayErrorText ? (
            <Text variant="body" tone="danger" className="mt-3">
              {replayErrorText}
            </Text>
          ) : null}
          {replayReport ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Card tone="muted" padding="sm" className="bg-[#f7f2ea]">
                <Text variant="caption" tone="muted">
                  Baseline score
                </Text>
                <Heading level={3} variant="subtitle" className="mt-1">
                  {roundToHundredths(replayReport.baseline.score)}
                </Heading>
              </Card>
              <Card tone="muted" padding="sm" className="bg-[#f7f2ea]">
                <Text variant="caption" tone="muted">
                  Best score
                </Text>
                <Heading level={3} variant="subtitle" className="mt-1">
                  {roundToHundredths(replayReport.best_variant.score)}
                </Heading>
              </Card>
              <Card tone="muted" padding="sm" className="bg-[#f7f2ea]">
                <Text variant="caption" tone="muted">
                  Improvement
                </Text>
                <Heading level={3} variant="subtitle" className="mt-1">
                  {replayScoreDelta > 0 ? "+" : ""}
                  {roundToHundredths(replayScoreDelta)}
                </Heading>
              </Card>
              <Card tone="muted" padding="sm" className="bg-[#f7f2ea]">
                <Text variant="caption" tone="muted">
                  Sample count
                </Text>
                <Heading level={3} variant="subtitle" className="mt-1">
                  {replayReport.randomized_sample_count}
                </Heading>
              </Card>
            </div>
          ) : (
            <Text variant="body" tone="muted" className="mt-3">
              No replay report is loaded yet.
            </Text>
          )}
        </Card>

        <Card tone="muted" padding="md" className="border-slate-200/70 bg-white/75">
          <Text variant="caption" tone="muted">
            Recommendation details
          </Text>
          {replayReport ? (
            <>
              <Text variant="body" tone="secondary" className="mt-2">
                Best variant: {replayReport.best_variant.variant_id}.{" "}
                {replayReport.has_recommended_adaptation_update
                  ? `The harness found a lower-error adaptation for this session by ${roundToHundredths(
                      replayScoreDelta
                    )}.`
                  : "The current profile is still the best candidate for this session, so no adaptation import is recommended."}
              </Text>

              <div className="mt-4 rounded-2xl bg-[#f4efe6] p-3">
                <div className="flex items-center justify-between gap-3">
                  <Text variant="caption" tone="muted">
                    Neutral replay review
                  </Text>
                  <Badge tone={replayEvaluationTone} size="sm">
                    {replayEvaluationDecision ?? "Unavailable"}
                  </Badge>
                </div>
                {replayEvaluationErrorText ? (
                  <Text variant="body" tone="danger" className="mt-2">
                    {replayEvaluationErrorText}
                  </Text>
                ) : replayEvaluationSummary ? (
                  <>
                    <Text variant="body" tone="secondary" className="mt-2">
                      {replayEvaluationSummary}
                    </Text>
                    <Text variant="caption" tone="muted" className="mt-2">
                      Decision: {replayEvaluationDecision}
                      {replayEvaluationReason ? ` · Reason: ${replayEvaluationReason}` : ""}
                    </Text>
                    {replayEvidenceWindowText ? (
                      <Text variant="caption" tone="muted" className="mt-1">
                        Evidence window: {replayEvidenceWindowText}.
                      </Text>
                    ) : null}
                    {replayEvaluationComparisonSummary ? (
                      <Text variant="caption" tone="muted" className="mt-1">
                        {replayEvaluationComparisonSummary}
                      </Text>
                    ) : null}
                    {replayEvaluationPath ? (
                      <Text variant="caption" tone="subtle" className="mt-1 break-all">
                        {replayEvaluationPath}
                      </Text>
                    ) : null}
                  </>
                ) : (
                  <Text variant="body" tone="muted" className="mt-2">
                    No replay evaluation is available yet.
                  </Text>
                )}
              </div>

              {replayDeltaItems.length > 0 ? (
                <div className="mt-4 grid gap-3">
                  {replayDeltaItems.map((item) => (
                    <Card key={item.label} tone="muted" padding="sm" className="bg-[#f7f2ea]">
                      <div className="flex items-center justify-between gap-3">
                        <Heading level={4} variant="bodyStrong">
                          {item.label}
                        </Heading>
                        <Badge tone="info" size="sm">
                          {item.deltaText}
                        </Badge>
                      </div>
                      <Text variant="caption" tone="secondary" className="mt-2">
                        {item.detail}
                      </Text>
                    </Card>
                  ))}
                </div>
              ) : (
                <Text variant="body" tone="muted" className="mt-3">
                  No material robot-parameter deltas beat the baseline on this replay. That usually
                  means the learned profile already matches the recorded session closely enough.
                </Text>
              )}

              <Text variant="caption" tone="muted" className="mt-4">
                Raw replay payload
              </Text>
              <pre className="mt-2 max-h-64 overflow-auto rounded-2xl bg-[#101826] p-3 text-xs text-slate-100">
                {JSON.stringify(
                  replayReport.has_recommended_adaptation_update
                    ? replayReport.recommended_adaptation_update
                    : replayReport.best_variant.learned_adaptation,
                  null,
                  2
                )}
              </pre>
            </>
          ) : (
            <Text variant="body" tone="muted" className="mt-3">
              Run the replay harness to compare the learned profile against randomized robot
              variants.
            </Text>
          )}

          {replayApplySummary ? (
            <div className="mt-4 rounded-2xl bg-[#f4efe6] p-3">
              <Text variant="caption" tone="muted">
                Last apply result
              </Text>
              <pre className="mt-2 max-h-48 overflow-auto rounded-2xl bg-[#101826] p-3 text-xs text-slate-100">
                {JSON.stringify(replayApplySummary, null, 2)}
              </pre>
            </div>
          ) : null}
        </Card>
      </div>
    </Card>
  );
}
