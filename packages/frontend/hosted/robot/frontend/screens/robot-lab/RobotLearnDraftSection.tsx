import {
  Badge,
  Button,
  Card,
  Heading,
  Text,
  type BadgeProps,
} from "@instafy/frontend/feature-api/ui";
import type { LearnDraftPayload } from "../../robot";

type LearnPromotionState = "idle" | "saving" | "saved";

type RobotLearnDraftSectionProps = {
  learnBadgeTone: BadgeProps["tone"];
  learnErrorText: string | null;
  learnDraft: LearnDraftPayload | null;
  learnBusy: boolean;
  learnStatusText: string;
  learnPromotionState: LearnPromotionState;
  activeProjectId: string | null;
  activeProjectName: string | null;
  onRefreshLearnDraft: () => void;
  onPromoteLearnDraft: () => void;
  onOpenLearnDraft: () => void;
};

export function RobotLearnDraftSection({
  learnBadgeTone,
  learnErrorText,
  learnDraft,
  learnBusy,
  learnStatusText,
  learnPromotionState,
  activeProjectId,
  activeProjectName,
  onRefreshLearnDraft,
  onPromoteLearnDraft,
  onOpenLearnDraft,
}: RobotLearnDraftSectionProps) {
  const learnBadgeLabel = learnErrorText ? "Draft error" : learnDraft ? "Draft ready" : "Idle";

  return (
    <Card
      padding="lg"
      className="border-white/70 bg-white/72 shadow-modal backdrop-blur"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <Text variant="overline" tone="muted">
            Project Memory
          </Text>
          <Heading level={2} variant="title" className="mt-1">
            Robot /learn draft
          </Heading>
        </div>
        <Badge tone={learnBadgeTone}>{learnBadgeLabel}</Badge>
      </div>

      <Text variant="body" tone="secondary" className="mt-3">
        This turns the current robot session, profile, and replay state into the compact
        project-memory style that Instafy&apos;s `/learn` loop is already built around.
      </Text>

      <div className="mt-4 flex flex-wrap gap-3">
        <Button variant="primary" onPress={onRefreshLearnDraft} isDisabled={learnBusy}>
          {learnBusy ? "Drafting…" : "Refresh /learn draft"}
        </Button>
        <Button
          variant="outline"
          onPress={onPromoteLearnDraft}
          isDisabled={
            !activeProjectId ||
            !learnDraft ||
            learnPromotionState === "saving" ||
            learnPromotionState === "saved"
          }
        >
          {learnPromotionState === "saving"
            ? "Saving…"
            : learnPromotionState === "saved"
              ? "Saved"
              : "Save to memory"}
        </Button>
        <Button
          variant="ghost"
          onPress={onOpenLearnDraft}
          isDisabled={!learnDraft || learnPromotionState !== "saved"}
        >
          Open block
        </Button>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-[0.85fr_1.15fr]">
        <Card tone="muted" padding="md" className="border-slate-200/70 bg-white/75">
          <Text variant="caption" tone="muted">
            Draft status
          </Text>
          <Heading level={3} variant="subtitle" className="mt-2">
            {learnStatusText}
          </Heading>
          <Text variant="caption" tone="muted" className="mt-3">
            Active project
          </Text>
          <Text variant="body" tone="secondary" className="mt-1 break-all">
            {activeProjectId
              ? `${activeProjectName} (${activeProjectId})`
              : "Select or create a project before saving robot learning."}
          </Text>
          {learnErrorText ? (
            <Text variant="body" tone="danger" className="mt-3">
              {learnErrorText}
            </Text>
          ) : null}
          {learnDraft && learnPromotionState === "saved" ? (
            <Text variant="body" tone="secondary" className="mt-3">
              Robot Lab saved this draft into Instafy project memory and updated the learned
              index/usage ledger.
            </Text>
          ) : null}
          {learnDraft ? (
            <>
              <Text variant="caption" tone="muted" className="mt-3">
                Suggested block path
              </Text>
              <Text variant="body" tone="secondary" className="mt-1 break-all">
                {learnDraft.project_memory_candidate.suggested_block_path}
              </Text>
              <div className="mt-4 flex flex-wrap gap-2">
                {learnDraft.project_memory_candidate.tags.map((tag) => (
                  <Badge key={tag} tone="info" size="sm">
                    {tag}
                  </Badge>
                ))}
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <Card tone="muted" padding="sm" className="bg-[#f7f2ea]">
                  <Text variant="caption" tone="muted">
                    Telemetry events
                  </Text>
                  <Heading level={3} variant="subtitle" className="mt-1">
                    {learnDraft.session_summary.telemetry_count}
                  </Heading>
                </Card>
                <Card tone="muted" padding="sm" className="bg-[#f7f2ea]">
                  <Text variant="caption" tone="muted">
                    Feedback signals
                  </Text>
                  <Heading level={3} variant="subtitle" className="mt-1">
                    {learnDraft.session_summary.user_feedback_count}
                  </Heading>
                </Card>
              </div>
              <Text variant="caption" tone="muted" className="mt-4">
                Source artifacts
              </Text>
              <Text variant="body" tone="secondary" className="mt-1 break-all">
                {learnDraft.session_path}
              </Text>
              <Text variant="body" tone="secondary" className="mt-1 break-all">
                {learnDraft.profile_path}
              </Text>
              {learnDraft.report_path ? (
                <Text variant="body" tone="secondary" className="mt-1 break-all">
                  {learnDraft.report_path}
                </Text>
              ) : null}
            </>
          ) : (
            <Text variant="body" tone="muted" className="mt-3">
              Build a draft after you have session evidence or replay data worth distilling into
              project memory.
            </Text>
          )}
        </Card>

        <Card tone="muted" padding="md" className="border-slate-200/70 bg-white/75">
          <Text variant="caption" tone="muted">
            Draft markdown
          </Text>
          {learnDraft ? (
            <pre className="mt-3 max-h-[34rem] overflow-auto rounded-2xl bg-[#101826] p-3 text-xs text-slate-100">
              {learnDraft.project_memory_candidate.markdown}
            </pre>
          ) : (
            <Text variant="body" tone="muted" className="mt-3">
              The generated project-memory draft will appear here.
            </Text>
          )}
        </Card>
      </div>
    </Card>
  );
}
