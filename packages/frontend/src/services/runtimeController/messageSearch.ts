import {
  messageSearchPath,
  type ControllerMessageSearchMatch,
  type ControllerMessageSearchPage,
  type ControllerMessageSearchParams,
} from "@instafy/sdk/conversation-search";
import { readControllerError, resolveControllerRequestContext, runtimeControllerEnabled } from "./core";
import { createControllerReadBudget } from "./readBudget";

export class ControllerMessageSearchError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function validMatch(value: unknown): value is ControllerMessageSearchMatch {
  if (!value || typeof value !== "object") return false;
  const row = value as ControllerMessageSearchMatch;
  return [row.messageId, row.conversationId, row.projectId].every((id) => typeof id === "string" && id.length > 0)
    && (row.orgId === null || typeof row.orgId === "string")
    && typeof row.projectName === "string" && (row.orgName === null || typeof row.orgName === "string")
    && typeof row.conversationTitle === "string" && (row.role === "user" || row.role === "assistant")
    && typeof row.createdAt === "string" && typeof row.snippet === "string"
    && Array.isArray(row.matchRanges) && row.matchRanges.every((range) => range && Number.isInteger(range.start)
      && Number.isInteger(range.end) && range.start >= 0 && range.end > range.start && range.end <= row.snippet.length);
}

export async function searchControllerMessages(params: ControllerMessageSearchParams): Promise<ControllerMessageSearchPage> {
  const query = params.query.trim();
  const characterCount = Array.from(query).length;
  if (characterCount < 2 || characterCount > 200) throw new Error("Use between 2 and 200 characters to search messages.");
  if (!runtimeControllerEnabled) throw new ControllerMessageSearchError("Message search is not available on this controller.", 404);
  const budget = createControllerReadBudget(params.signal);
  try {
    const context = await budget.wait(() => resolveControllerRequestContext(null));
    if (!context.accessToken || !context.baseUrl) throw new ControllerMessageSearchError("Sign in to search messages.", 401);
    const response = await budget.wait(() => fetch(`${context.baseUrl}${messageSearchPath({ ...params, query })}`, {
      headers: { authorization: `Bearer ${context.accessToken}`, accept: "application/json" },
      signal: budget.signal,
    }));
    if (response.status === 404) throw new ControllerMessageSearchError("Message search is not available on this controller yet.", 404);
    if (response.status === 401 || response.status === 403) {
      const message = await budget.wait(() => readControllerError(response, "Message search access changed. Retry search.", context));
      throw new ControllerMessageSearchError(message, response.status);
    }
    if (!response.ok) throw new ControllerMessageSearchError(
      await budget.wait(() => readControllerError(response, "Unable to search messages. Retry search.", context)), response.status,
    );
    const page = await budget.wait<ControllerMessageSearchPage>(() => response.json());
    if (!page || !Array.isArray(page.matches) || !page.matches.every(validMatch)
      || typeof page.hasMore !== "boolean" || (page.nextCursor !== null && typeof page.nextCursor !== "string")
      || page.hasMore && !page.nextCursor) throw new Error("Invalid message search response. Retry search.");
    return page;
  } finally {
    budget.dispose();
  }
}
