import type { CapabilityDefinition } from "@instafy/sdk/capabilities";
import {
  CAMERA_OBSERVATION_ACTIONS,
  CAMERA_OBSERVATION_CAPABILITY_ID,
} from "./cameraCapabilityMetadata";
import type { CameraLensId } from "./types";

export interface ResolvedCameraObservationPrompt {
  mode: "single" | "series";
  lens: CameraLensId;
  count: number;
  normalizedPrompt: string;
  summary: string;
}

function stripLeadingMention(prompt: string) {
  return prompt.trim().replace(/^@\S+\s*/u, "");
}

function normalizePrompt(prompt: string) {
  return stripLeadingMention(prompt).toLowerCase().replace(/\s+/gu, " ").trim();
}

function resolveRequestedLens(normalizedPrompt: string): CameraLensId {
  if (/\b(selfie|front)\b/u.test(normalizedPrompt)) {
    return "front";
  }
  if (/\b(external|usb|webcam)\b/u.test(normalizedPrompt)) {
    return "external";
  }
  return "rear";
}

function resolveSeriesCount(normalizedPrompt: string) {
  const mentionsPhotoSeries = /\b(photos?|pictures?|shots?|images?)\b/u.test(normalizedPrompt);
  const explicitCountMatch = normalizedPrompt.match(/\b([2-5])\b/u);
  if (mentionsPhotoSeries && explicitCountMatch) {
    return Number(explicitCountMatch[1]);
  }
  if (
    mentionsPhotoSeries &&
    /\b(series|burst|few|multiple|couple|several)\b/u.test(normalizedPrompt)
  ) {
    return 3;
  }
  return 1;
}

function isCameraCapturePrompt(normalizedPrompt: string) {
  return (
    /\b(take|capture|snap|shoot)\b[\w\s]*(photos?|pictures?|pics?|images?|selfies?)\b/u.test(
      normalizedPrompt,
    ) ||
    /\b(use|open)\b[\w\s]*\bcamera\b[\w\s]*(photos?|pictures?|selfies?)\b/u.test(
      normalizedPrompt,
    ) ||
    /\b(photos?|pictures?|selfies?)\b[\w\s]*\b(with|from)\b[\w\s]*\bcamera\b/u.test(
      normalizedPrompt,
    )
  );
}

function formatLensLabel(lens: CameraLensId) {
  if (lens === "front") {
    return "front";
  }
  if (lens === "external") {
    return "external";
  }
  return "rear";
}

export function resolveCameraObservationPrompt(
  prompt: string,
): ResolvedCameraObservationPrompt | null {
  const normalizedPrompt = normalizePrompt(prompt);
  if (!normalizedPrompt || !isCameraCapturePrompt(normalizedPrompt)) {
    return null;
  }

  const lens = resolveRequestedLens(normalizedPrompt);
  const count = resolveSeriesCount(normalizedPrompt);
  const mode = count > 1 ? "series" : "single";
  const lensLabel = formatLensLabel(lens);
  const noun = lens === "front" ? "selfie" : "photo";

  return {
    mode,
    lens,
    count,
    normalizedPrompt,
    summary:
      mode === "series"
        ? `Capture ${count} ${lensLabel} ${noun}${count === 1 ? "" : "s"}`
        : `Capture a ${lensLabel} ${noun}`,
  };
}

export interface ResolvedVisualQuestionPrompt {
  question: string;
  normalizedPrompt: string;
  summary: string;
}

/**
 * Visual-question patterns for the answer_visual_question action. They are
 * unanchored on purpose so lead-ins like "hey camera, what fruit is this?"
 * still match. Plain capture prompts ("take a photo") intentionally do NOT
 * match any of these.
 *
 * Deliberately NO bare "what is this" / "what's this" patterns: those hijack
 * non-visual prompts ("what is this error in my logs?", "what's this setting
 * for?") into camera captures. A visual question must name a shown object
 * ("what fruit is this"), reference sight ("what do you see", "look at this",
 * "what am I holding"), or explicitly ask for identification of "this"
 * ("tell me what this is").
 */
const VISUAL_QUESTION_PATTERNS: RegExp[] = [
  /\bwhat\s+(?:kind\s+of\s+|sort\s+of\s+)?(?:fruit|food|object|thing|item)\s+is\s+(?:this|that|it)\b/u,
  /\bwhat\s+(?:do|can)\s+you\s+see\b/u,
  /\bwhat\s+am\s+i\s+(?:holding|showing)(?:\s+you)?\b/u,
  /\blook\s+at\s+(?:this|that)\b/u,
  /\btell\s+me\s+what\s+(?:this|that)\s+is\b/u,
];

export function resolveVisualQuestionPrompt(
  prompt: string,
): ResolvedVisualQuestionPrompt | null {
  const normalizedPrompt = normalizePrompt(prompt);
  if (!normalizedPrompt) {
    return null;
  }
  if (!VISUAL_QUESTION_PATTERNS.some((pattern) => pattern.test(normalizedPrompt))) {
    return null;
  }
  const question = stripLeadingMention(prompt).replace(/\s+/gu, " ").trim();
  return {
    question: question || normalizedPrompt,
    normalizedPrompt,
    summary: "Look at what you are shown and answer",
  };
}

export const CAMERA_OBSERVATION_CAPABILITY: CapabilityDefinition = {
  id: CAMERA_OBSERVATION_CAPABILITY_ID,
  title: "Camera observation",
  description: "Allows an agent to request a fresh camera capture through an attached provider.",
  actions: CAMERA_OBSERVATION_ACTIONS,
  promptContext: {
    summary:
      "Capture a fresh camera observation when the user explicitly asks for a photo, or asks what a shown object is.",
    instructions: [
      "Use this capability only when the user asks for a new photo, picture, selfie, or short photo series.",
      "Also use it when the user shows an object and asks a visual question like 'what fruit is this' or 'what do you see'.",
      "Keep the response grounded in the captured lens, count, and latest metadata returned by the provider.",
    ],
    constraints: [
      "Do not invent visual analysis that has not been captured yet.",
      "If the request is not clearly asking for a fresh capture, let the normal assistant flow handle it.",
    ],
    examples: [
      "@octo take a photo",
      "@octo capture a front selfie",
      "@octo take 3 rear photos",
      "@octo what fruit is this?",
    ],
  },
};
