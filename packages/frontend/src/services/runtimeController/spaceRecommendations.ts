import { readControllerError, resolveControllerRequestContext, runtimeControllerEnabled } from "./core";
import { createControllerReadBudget } from "./readBudget";

export type SpaceRecommendationEvidence = { conversationId: string; messageId?: string | null };
export type SpaceRecommendation = {
  id: string;
  projectId: string;
  key: string;
  title: string;
  reason: string;
  prompt: string;
  evidence: SpaceRecommendationEvidence[];
  status: "proposed" | "accepted" | "dismissed";
  acceptedConversationId: string | null;
  createdAt: string;
  updatedAt: string;
};

export class SpaceRecommendationOutcomeConflictError extends Error {
  constructor() {
    super("This suggestion has already been handled. Reload to see the latest choices.");
    this.name = "SpaceRecommendationOutcomeConflictError";
  }
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecommendation(value: unknown, projectId: string): value is SpaceRecommendation {
  if (!value || typeof value !== "object") return false;
  const row = value as SpaceRecommendation;
  return row.projectId === projectId
    && [row.id, row.key, row.title, row.reason, row.prompt, row.createdAt, row.updatedAt].every(isNonemptyString)
    && ["proposed", "accepted", "dismissed"].includes(row.status)
    && (row.acceptedConversationId === null || isNonemptyString(row.acceptedConversationId))
    && Array.isArray(row.evidence) && row.evidence.length > 0 && row.evidence.length <= 8
    && row.evidence.every((source) => source && isNonemptyString(source.conversationId)
      && (source.messageId == null || isNonemptyString(source.messageId)));
}

async function requestRecommendations(projectId: string, options: {
  signal?: AbortSignal;
  recommendationId?: string;
  prepareReview?: boolean;
  prepareRecommendation?: boolean;
  outcome?: { status: "accepted" | "dismissed"; acceptedConversationId?: string | null };
} = {}): Promise<unknown> {
  if (!isNonemptyString(projectId)) throw new Error("Select a space to review.");
  if (!runtimeControllerEnabled) throw new Error("Space review is unavailable on this controller.");
  const budget = createControllerReadBudget(options.signal);
  try {
    const context = await budget.wait(() => resolveControllerRequestContext(null));
    if (!context.accessToken || !context.baseUrl) throw new Error("Sign in to review this space.");
    const path = `/projects/${encodeURIComponent(projectId)}/recommendations`
      + (options.prepareReview ? "/review-conversation"
        : options.recommendationId ? `/${encodeURIComponent(options.recommendationId)}${options.prepareRecommendation ? "/prepare-conversation" : ""}` : "");
    const response = await budget.wait(() => fetch(`${context.baseUrl}${path}`, {
      method: options.prepareReview || options.prepareRecommendation ? "POST" : options.outcome ? "PATCH" : "GET",
      headers: {
        authorization: `Bearer ${context.accessToken}`,
        accept: "application/json",
        ...(options.outcome ? { "content-type": "application/json" } : {}),
      },
      ...(options.outcome ? { body: JSON.stringify(options.outcome) } : {}),
      signal: budget.signal,
    }));
    if (!response.ok) {
      await budget.wait(() => readControllerError(response, "Unable to load space suggestions.", context));
      if (response.status === 409 && (options.outcome || options.prepareRecommendation)) throw new SpaceRecommendationOutcomeConflictError();
      throw new Error(response.status === 409
        ? options.prepareReview
          ? "The review chat’s sharing has changed. Restore its private access before reviewing again."
          : "This suggestion has already been handled. Reload to see the latest choices."
        : response.status === 403
          ? "You no longer have permission to use these space suggestions."
          : response.status === 404
            ? "Space review is unavailable or you no longer have access."
            : options.prepareReview ? "Unable to prepare the review chat. Try again."
              : options.prepareRecommendation ? "Unable to prepare a private chat for this suggestion. Try again."
              : options.outcome ? "Unable to save your choice. Try again." : "Unable to load suggestions. Try again.");
    }
    return await budget.wait(() => response.json());
  } finally {
    budget.dispose();
  }
}

export async function prepareSpaceReviewConversation(projectId: string): Promise<{ conversationId: string }> {
  const result = await requestRecommendations(projectId, { prepareReview: true }) as { conversationId?: unknown };
  if (!result || !isNonemptyString(result.conversationId)) throw new Error("Unable to open the review chat. Try again.");
  return { conversationId: result.conversationId };
}

export async function prepareSpaceRecommendationConversation(projectId: string, recommendationId: string): Promise<{ conversationId: string }> {
  if (!isNonemptyString(recommendationId)) throw new Error("This suggestion is unavailable.");
  const result = await requestRecommendations(projectId, { recommendationId, prepareRecommendation: true }) as { conversationId?: unknown };
  if (!result || !isNonemptyString(result.conversationId)) throw new Error("Unable to open the suggestion’s private chat. Try again.");
  return { conversationId: result.conversationId };
}

export async function listSpaceRecommendations(projectId: string, signal?: AbortSignal): Promise<SpaceRecommendation[]> {
  const result = await requestRecommendations(projectId, { signal }) as { recommendations?: unknown };
  if (!result || !Array.isArray(result.recommendations)
    || !result.recommendations.every((row) => isRecommendation(row, projectId))) {
    throw new Error("Unable to read space suggestions. Try again.");
  }
  return result.recommendations;
}

export async function setSpaceRecommendationOutcome(projectId: string, recommendationId: string,
  outcome: { status: "accepted" | "dismissed"; acceptedConversationId?: string | null },
): Promise<SpaceRecommendation> {
  if (!isNonemptyString(recommendationId)) throw new Error("This suggestion is unavailable.");
  const result = await requestRecommendations(projectId, { recommendationId, outcome });
  if (!isRecommendation(result, projectId) || result.id !== recommendationId || result.status !== outcome.status) {
    throw new Error("Unable to confirm your saved choice. Reload suggestions.");
  }
  // An idempotent acceptance keeps the first saved destination, even if this
  // tab prepared another draft. The caller must reconcile that authoritative ID.
  return result;
}
