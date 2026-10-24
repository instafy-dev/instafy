import { isUUID } from "../../utils/uuid";
import { readControllerError, resolveControllerRequestContext, runtimeControllerEnabled } from "./core";

export type UserInputQuestion = {
  id: string;
  header: string;
  question: string;
  options?: Array<{ label: string; description: string }>;
  isOther?: boolean;
};

export type UserInputRequest = {
  requestId: string;
  messageId: string;
  status: "pending" | "answered" | "resumed" | "expired";
  canAnswer: boolean;
  questions: UserInputQuestion[];
  answers?: Record<string, string[]>;
  agentHandle?: string;
  expiredReason?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === "string" && !value.includes("\0") && (allowEmpty || value.trim().length > 0) && [...value].length <= maximum;
}

function validAnswers(value: unknown): value is Record<string, string[]> {
  return isRecord(value) && Object.keys(value).length > 0 && Object.keys(value).length <= 3 &&
    Object.entries(value).every(([id, answer]) => boundedText(id, 100) && Array.isArray(answer) &&
      answer.length === 1 && boundedText(answer[0], 4000));
}

/** Accept only the controller's bounded public shape; no job, thread or provider target comes from a card. */
function parseRequest(value: unknown, requestId: string, messageId: string): UserInputRequest {
  const invalid = () => new Error("The controller returned an unreadable input request.");
  if (!isRecord(value) || value.requestId !== requestId || value.messageId !== messageId || typeof value.status !== "string" || typeof value.canAnswer !== "boolean" ||
    !["pending", "answered", "resumed", "expired"].includes(value.status) ||
    !Array.isArray(value.questions) || value.questions.length < 1 || value.questions.length > 3) throw invalid();
  const ids = new Set<string>();
  const questions = value.questions.map((question): UserInputQuestion => {
    if (!isRecord(question) || !boundedText(question.id, 100) || question.id.trim() !== question.id || ids.has(question.id) ||
      !boundedText(question.header, 100) || !boundedText(question.question, 2000) ||
      (question.isOther !== undefined && typeof question.isOther !== "boolean") ||
      (question.isSecret !== undefined && question.isSecret !== false)) throw invalid();
    ids.add(question.id);
    let options: UserInputQuestion["options"];
    if (question.options !== undefined && question.options !== null) {
      if (!Array.isArray(question.options) || question.options.length < 1 || question.options.length > 6) throw invalid();
      const labels = new Set<string>();
      options = question.options.map(option => {
        if (!isRecord(option) || !boundedText(option.label, 200) || labels.has(option.label) || !boundedText(option.description, 1000, true)) throw invalid();
        labels.add(option.label);
        return { label: option.label, description: option.description };
      });
    }
    return { id: question.id, header: question.header, question: question.question,
      ...(options ? { options } : {}), ...(typeof question.isOther === "boolean" ? { isOther: question.isOther } : {}) };
  });
  let answers: UserInputRequest["answers"];
  if (value.answers !== undefined && value.answers !== null) {
    if (!validAnswers(value.answers) || Object.keys(value.answers).length !== ids.size ||
      Object.keys(value.answers).some(id => !ids.has(id))) throw invalid();
    answers = Object.fromEntries(Object.entries(value.answers).map(([id, answer]) => [id, [...answer]]));
  }
  if (value.agentHandle !== undefined && value.agentHandle !== null && !boundedText(value.agentHandle, 120)) throw invalid();
  // Stop reasons may come from an existing freeform cancellation endpoint. An
  // oversized optional explanation must not hide the authoritative expiry.
  const expiredReason = typeof value.expiredReason === "string"
    ? [...value.expiredReason.split("\0").join("").trim()].slice(0, 2000).join("") : "";
  return { requestId, messageId, status: value.status as UserInputRequest["status"], canAnswer: value.canAnswer, questions,
    ...(answers ? { answers } : {}), ...(typeof value.agentHandle === "string" ? { agentHandle: value.agentHandle } : {}),
    ...(expiredReason ? { expiredReason } : {}) };
}

async function requestInput(requestId: string, messageId: string, answers: Record<string, string[]> | undefined, signal?: AbortSignal): Promise<UserInputRequest> {
  if (!isUUID(requestId) || !isUUID(messageId)) throw new Error("This input request is unavailable.");
  if (answers !== undefined && !validAnswers(answers)) throw new Error("Provide one answer of at most 4,000 characters for each question.");
  if (!runtimeControllerEnabled) throw new Error("Runtime controller is not configured.");
  const context = await resolveControllerRequestContext(null);
  if (!context.baseUrl || !context.accessToken) throw new Error("Missing controller session token.");
  signal?.throwIfAborted();
  const response = await fetch(`${context.baseUrl}/user-input-requests/${encodeURIComponent(requestId)}${answers ? "/answer" : ""}`, {
    method: answers ? "POST" : "GET",
    headers: { authorization: `Bearer ${context.accessToken}`, accept: "application/json", "cache-control": "no-cache",
      ...(answers ? { "content-type": "application/json" } : {}) },
    ...(answers ? { body: JSON.stringify({ answers }) } : {}), signal,
  });
  if (!response.ok) throw new Error(await readControllerError(response, answers ? "Could not send your answer." : "Could not load the question.", context));
  return parseRequest(await response.json(), requestId, messageId);
}

export function getUserInputRequest(requestId: string, messageId: string, signal?: AbortSignal): Promise<UserInputRequest> {
  return requestInput(requestId, messageId, undefined, signal);
}

export function answerUserInputRequest(requestId: string, messageId: string, answers: Record<string, string[]>, signal?: AbortSignal): Promise<UserInputRequest> {
  return requestInput(requestId, messageId, answers, signal);
}
