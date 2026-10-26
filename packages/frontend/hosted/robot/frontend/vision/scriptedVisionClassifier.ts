import type {
  VisionClassifierRegistration,
  VisionClassifyResult,
} from "@instafy/frontend/feature-api";

/**
 * Scripted vision classifier for the knosh camera/vision leg.
 *
 * Mirrors the knosh.vision_classify_response.v1 contract (camelCase):
 * { label, answer, latencyMs, agentRuntime }.
 *
 * The scripted implementation decodes the captured image, averages the RGB of
 * the non-background (chroma >= 24) pixels, and maps the mean hue to a small
 * fruit vocabulary: yellow -> banana, orange -> orange, green -> lime,
 * red -> apple. When no chromatic pixels exist or the hue falls outside the
 * mapped bands, the deterministic fallback label is "unclear" with an honest
 * answer (no fruit guess is invented).
 *
 * The classifier is pluggable via setVisionClassifierOverride so future live
 * backends (and unit tests) can replace the scripted path without touching
 * callers.
 */

export type VisionClassifierFn = (
  webPath: string,
  question: string,
) => Promise<VisionClassifyResult>;

export const SCRIPTED_VISION_AGENT_RUNTIME = "scripted_vision_client_v1";
export const VISION_UNCLEAR_LABEL = "unclear";

/**
 * Pixels with max(R,G,B) - min(R,G,B) below this are treated as background.
 *
 * Source of truth: NON_BACKGROUND_CHROMA_THRESHOLD in the sim scripted host
 * (knosh repo, tools/learning/vision_classify_scripted_host). The device
 * classifier must stay bit-identical to the sim so fixture runs agree.
 */
export const VISION_CHROMA_THRESHOLD = 24;

let visionClassifierOverride: VisionClassifierFn | null = null;

export function setVisionClassifierOverride(fn: VisionClassifierFn | null) {
  visionClassifierOverride = fn;
}

function rgbToHueDegrees(r: number, g: number, b: number): number | null {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta <= 0) {
    return null;
  }
  let hue: number;
  if (max === r) {
    hue = ((g - b) / delta) % 6;
  } else if (max === g) {
    hue = (b - r) / delta + 2;
  } else {
    hue = (r - g) / delta + 4;
  }
  hue *= 60;
  if (hue < 0) {
    hue += 360;
  }
  return hue;
}

/**
 * Hue bands (degrees) → fruit labels.
 *
 * Source of truth: HUE_LABELS in the sim scripted host (knosh repo,
 * tools/learning/vision_classify_scripted_host):
 *   apple  345–360 and 0–20 (red wraparound)
 *   orange  20–45
 *   banana  45–80
 *   lime    80–170
 * Anything outside those bands maps to the deterministic "unclear" fallback
 * (the sim host fails hard there; the device answers honestly instead).
 */
function mapHueToVisionLabel(hue: number): string {
  if (hue < 20 || hue >= 345) {
    return "apple";
  }
  if (hue < 45) {
    return "orange";
  }
  if (hue < 80) {
    return "banana";
  }
  if (hue < 170) {
    return "lime";
  }
  return VISION_UNCLEAR_LABEL;
}

/**
 * Pure hue-mapping core: mean RGB over non-background (chroma >= 24, alpha > 0)
 * pixels of an RGBA byte array, mapped to the fruit vocabulary. Exported so
 * unit tests can exercise the mapping on synthetic pixel data without a real
 * canvas backend.
 */
export function resolveVisionLabelFromRgbaPixels(
  data: Uint8ClampedArray | Uint8Array,
): string {
  let redSum = 0;
  let greenSum = 0;
  let blueSum = 0;
  let count = 0;
  for (let index = 0; index + 3 < data.length; index += 4) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const alpha = data[index + 3];
    if (alpha === 0) {
      continue;
    }
    const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
    if (chroma < VISION_CHROMA_THRESHOLD) {
      continue;
    }
    redSum += red;
    greenSum += green;
    blueSum += blue;
    count += 1;
  }
  if (count === 0) {
    return VISION_UNCLEAR_LABEL;
  }
  const hue = rgbToHueDegrees(redSum / count, greenSum / count, blueSum / count);
  if (hue === null) {
    return VISION_UNCLEAR_LABEL;
  }
  return mapHueToVisionLabel(hue);
}

/**
 * Article-aware answer templates. Source of truth: ANSWER_TEMPLATES in the sim
 * scripted host (knosh repo, tools/learning/vision_classify_scripted_host) —
 * mirrored exactly ("an orange", "an apple", not "a orange"/"a apple").
 */
const VISION_ANSWER_TEMPLATES: Record<string, string> = {
  banana: "That looks like a banana.",
  orange: "That looks like an orange.",
  lime: "That looks like a lime.",
  apple: "That looks like an apple.",
};

export function formatVisionAnswer(label: string): string {
  if (label === VISION_UNCLEAR_LABEL) {
    return "I could not make out what that is from the photo.";
  }
  const template = VISION_ANSWER_TEMPLATES[label];
  if (template) {
    return template;
  }
  // Defensive fallback for labels outside the scripted vocabulary: pick the
  // article by leading vowel so we never say "a apple"-style answers.
  const article = /^[aeiou]/iu.test(label) ? "an" : "a";
  return `That looks like ${article} ${label}.`;
}

type VisionCanvas2dContext = Pick<
  CanvasRenderingContext2D,
  "getImageData"
> & {
  drawImage: (image: CanvasImageSource, dx: number, dy: number) => void;
};

function createVisionCanvasContext(width: number, height: number): VisionCanvas2dContext {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (context) {
      return context as unknown as VisionCanvas2dContext;
    }
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context) {
      return context;
    }
  }
  throw new Error("This client cannot create a canvas for scripted vision classification.");
}

async function decodeCapturedImagePixels(webPath: string): Promise<Uint8ClampedArray> {
  const response = await fetch(webPath);
  if (!response.ok) {
    throw new Error(`Unable to load the captured image for classification (${response.status}).`);
  }
  const blob = await response.blob();
  if (typeof createImageBitmap !== "function") {
    throw new Error("This client cannot decode captured images for scripted vision.");
  }
  const bitmap = await createImageBitmap(blob);
  try {
    const width = Math.max(1, bitmap.width);
    const height = Math.max(1, bitmap.height);
    const context = createVisionCanvasContext(width, height);
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, width, height).data;
  } finally {
    bitmap.close?.();
  }
}

export async function classifyCapturedImage(
  webPath: string,
  question: string,
): Promise<VisionClassifyResult> {
  if (visionClassifierOverride) {
    return visionClassifierOverride(webPath, question);
  }
  const startedAtMs = Date.now();
  const pixels = await decodeCapturedImagePixels(webPath);
  const label = resolveVisionLabelFromRgbaPixels(pixels);
  return {
    label,
    answer: formatVisionAnswer(label),
    latencyMs: Math.max(0, Date.now() - startedAtMs),
    agentRuntime: SCRIPTED_VISION_AGENT_RUNTIME,
  };
}

export function resetScriptedVisionClassifierForTest(): void {
  visionClassifierOverride = null;
}

export const KNOSH_SCRIPTED_VISION_CLASSIFIER: VisionClassifierRegistration = {
  id: "knosh.scripted-vision",
  classify: classifyCapturedImage,
};
