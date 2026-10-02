import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/Button";
import { Text } from "../../../components/Text";
import {
  listSpaceRecommendations,
  setSpaceRecommendationOutcome,
  SpaceRecommendationOutcomeConflictError,
  type SpaceRecommendation,
  type SpaceRecommendationEvidence,
} from "../../../services/runtimeController/spaceRecommendations";

export type SpaceRecommendationsProps = {
  projectId: string;
  canWrite: boolean;
  refreshKey?: string | number;
  /** Stage the review prompt in a chat; true means the draft was handed off. */
  onReview: () => Promise<boolean>;
  /** Stage an editable draft, without sending; false leaves the suggestion proposed. */
  onUseRecommendation: (recommendation: SpaceRecommendation) => Promise<boolean | { acceptedConversationId: string }>;
  onOpenEvidence: (evidence: SpaceRecommendationEvidence) => void;
  /** Navigate to the staged draft after its outcome has been saved. */
  onHandoffComplete?: () => void;
};

export function SpaceRecommendations(props: SpaceRecommendationsProps) {
  // Scope all pending UI and requests to the space, including A -> B -> A navigation.
  return <SpaceRecommendationsForProject key={props.projectId} {...props} />;
}

function recordedChoiceNotice(row: SpaceRecommendation, hasDraft: boolean, draftId?: string) {
  if (row.status === "dismissed") {
    return hasDraft ? "This suggestion was already dismissed. Your extra draft remains unsent."
      : "This suggestion was already dismissed.";
  }
  if (hasDraft && row.acceptedConversationId === (draftId ?? null)) {
    return "Your choice was saved. The draft is still unsent.";
  }
  return hasDraft ? "This suggestion was already added to another chat. Your extra draft remains unsent."
    : "This suggestion was already added to a chat.";
}

function SpaceRecommendationsForProject({ projectId, canWrite, refreshKey, onReview,
  onUseRecommendation, onOpenEvidence, onHandoffComplete }: SpaceRecommendationsProps) {
  const [recommendations, setRecommendations] = useState<SpaceRecommendation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [chosenConversationId, setChosenConversationId] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const aliveRef = useRef(true);
  // If saving fails after a successful handoff, retry only the outcome, not the draft.
  const handedOffRef = useRef(new Map<string, string | undefined>());
  const handledRef = useRef(new Set<string>());
  const conflictingChoiceRef = useRef<string | null>(null);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    void listSpaceRecommendations(projectId, controller.signal).then((rows) => {
      if (!controller.signal.aborted) {
        const reconciled = rows.find((row) => row.status !== "proposed"
          && (handedOffRef.current.has(row.id) || conflictingChoiceRef.current === row.id));
        if (reconciled) {
          setNotice(recordedChoiceNotice(reconciled, handedOffRef.current.has(reconciled.id), handedOffRef.current.get(reconciled.id)));
          setChosenConversationId(reconciled.status === "accepted" ? reconciled.acceptedConversationId : null);
        } else if (conflictingChoiceRef.current) {
          setNotice("This suggestion is no longer available. Any draft you prepared remains unsent.");
        }
        for (const row of rows) {
          if (row.status !== "proposed") {
            handledRef.current.add(row.id);
            handedOffRef.current.delete(row.id);
          }
        }
        conflictingChoiceRef.current = null;
        setActionError(null);
        setRecommendations(rows.filter((row) => row.status === "proposed" && !handledRef.current.has(row.id)));
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        if (conflictingChoiceRef.current) setNotice(null);
        setLoadError(error instanceof Error ? error.message : "Unable to load suggestions. Try again.");
      }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [projectId, refreshKey, reload]);

  const startAction = (key: string) => {
    if (!canWrite || busyRef.current) return false;
    busyRef.current = true;
    setBusy(key);
    setActionError(null);
    setNotice(null);
    setChosenConversationId(null);
    return true;
  };
  const finishAction = () => {
    busyRef.current = false;
    if (aliveRef.current) setBusy(null);
  };
  const review = async () => {
    if (!startAction("review")) return;
    try {
      const staged = await onReview();
      if (aliveRef.current) {
        if (staged) {
          setNotice("Review prompt added to your private review chat. Send it to start the review.");
          onHandoffComplete?.();
        } else setActionError("The review prompt was not added. Keep your current draft and try again when ready.");
      }
    } catch (error) {
      if (aliveRef.current) setActionError(error instanceof Error ? error.message : "Unable to add the review prompt. Try again.");
    } finally { finishAction(); }
  };
  const decide = async (recommendation: SpaceRecommendation, status: "accepted" | "dismissed") => {
    if (loading || loadError) return;
    if (!startAction(`${status}:${recommendation.id}`)) return;
    try {
      if (status === "accepted" && !handedOffRef.current.has(recommendation.id)) {
        const handoff = await onUseRecommendation(recommendation);
        if (!handoff) {
          if (aliveRef.current) setActionError("The suggestion was not added. Keep your current draft and try again when ready.");
          return;
        }
        handedOffRef.current.set(recommendation.id, typeof handoff === "object" ? handoff.acceptedConversationId : undefined);
      }
      // A successful handoff may close this panel. Finish its authorized outcome
      // write even then, but never update the next space's UI.
      const acceptedConversationId = handedOffRef.current.get(recommendation.id);
      const saved = await setSpaceRecommendationOutcome(projectId, recommendation.id, {
        status,
        ...(status === "accepted" && acceptedConversationId ? { acceptedConversationId } : {}),
      });
      handledRef.current.add(recommendation.id);
      handedOffRef.current.delete(recommendation.id);
      if (aliveRef.current) {
        setRecommendations((rows) => rows.filter((row) => row.id !== recommendation.id));
        if (status === "accepted" && saved.acceptedConversationId !== (acceptedConversationId ?? null)) {
          setNotice(recordedChoiceNotice(saved, true, acceptedConversationId));
          setChosenConversationId(saved.acceptedConversationId);
        } else {
          setNotice(status === "accepted" ? "Suggestion added to chat. You can edit it before sending." : "Suggestion dismissed.");
          if (status === "accepted") onHandoffComplete?.();
        }
      }
    } catch (error) {
      if (aliveRef.current) {
        if (error instanceof SpaceRecommendationOutcomeConflictError) {
          conflictingChoiceRef.current = recommendation.id;
          setNotice("This suggestion was already handled. Checking the saved choice…");
          setReload((value) => value + 1);
        } else setActionError(status === "accepted" && handedOffRef.current.has(recommendation.id)
          ? "The draft is in your chat, but your choice could not be saved. Select Save choice to retry."
          : error instanceof Error ? error.message : "Unable to save your choice. Try again.");
      }
    } finally { finishAction(); }
  };

  return (
    <section className="space-y-4" aria-label="Space suggestions" data-testid="space-recommendations">
      <Text variant="caption" tone="muted">
        Octo reviews shared chats and this review’s history. Other private chats aren’t included.
      </Text>
      <Text variant="caption" tone="muted">
        Suggestions open as drafts in new private chats. You can edit them; nothing runs until you send it.
      </Text>
      <div className="flex flex-wrap items-center gap-2">
        {canWrite ? <Button variant="primary" size="sm" onPress={() => void review()}
          isPending={busy === "review"} isDisabled={busy !== null && busy !== "review"}
          data-testid="space-review-start">Prepare review</Button> : null}
        <Button variant="ghost" size="sm" onPress={() => setReload((value) => value + 1)}
          isDisabled={loading || busy !== null} data-testid="space-review-reload">Reload suggestions</Button>
      </div>
      {loading ? <Text variant="caption" role="status">Loading suggestions…</Text> : null}
      {loadError ? <Text variant="caption" role="alert">{loadError}</Text> : null}
      {actionError ? <Text variant="caption" role="alert">{actionError}</Text> : null}
      {notice ? <Text variant="caption" role="status">{notice}</Text> : null}
      {chosenConversationId ? <Button variant="outline" size="sm"
        onPress={() => onOpenEvidence({ conversationId: chosenConversationId })}
        data-testid="space-recommendation-open-chosen">Open chosen chat</Button> : null}
      {!loading && !loadError && recommendations.length === 0 ? (
        <Text variant="body" tone="muted" data-testid="space-recommendations-empty">
          No suggestions to review. Start with a chat about what you want to do, or review this space’s existing chats.
        </Text>
      ) : null}
      <ul className="divide-y divide-slate-200 dark:divide-[var(--color-studio-dark-panel-border)]">
        {recommendations.slice(0, 3).map((recommendation) => (
          <li key={recommendation.id} className="space-y-2 py-4 first:pt-0 last:pb-0"
            data-testid={`space-recommendation-${recommendation.id}`}>
            <Text as="h3" variant="bodyStrong" tone="primary">{recommendation.title}</Text>
            <Text variant="body" tone="secondary">{recommendation.reason}</Text>
            <div className="flex flex-wrap gap-1" aria-label="Sources">
              {recommendation.evidence.map((source, index) => (
                <Button key={`${source.conversationId}:${source.messageId ?? ""}:${index}`} variant="ghost" size="xs"
                  onPress={() => onOpenEvidence(source)} className="underline underline-offset-2">
                  {recommendation.evidence.length === 1 ? "Source chat" : `Source chat ${index + 1}`}
                </Button>
              ))}
            </div>
            {canWrite ? <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onPress={() => void decide(recommendation, "accepted")}
                isPending={busy === `accepted:${recommendation.id}`}
                isDisabled={busy !== `accepted:${recommendation.id}` && (loading || Boolean(loadError) || busy !== null)}
                data-testid={`space-recommendation-use-${recommendation.id}`}>
                {handedOffRef.current.has(recommendation.id) ? "Save choice" : "Add to new chat"}
              </Button>
              <Button variant="ghost" size="sm" onPress={() => void decide(recommendation, "dismissed")}
                isPending={busy === `dismissed:${recommendation.id}`}
                isDisabled={busy !== `dismissed:${recommendation.id}` && (loading || Boolean(loadError) || handedOffRef.current.has(recommendation.id) || busy !== null)}
                data-testid={`space-recommendation-dismiss-${recommendation.id}`}>Dismiss</Button>
            </div> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
