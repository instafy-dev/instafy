import { APPLICATION_FRONTEND_FEATURES } from "../features/applicationFrontendFeatureComposition";
import type {
  VisionClassifyResult,
  VisionObservation,
} from "./visionTypes";

export type {
  VisionClassifierRegistration,
  VisionClassifyResult,
  VisionObservation,
} from "./visionTypes";

export async function classifyCapturedImage(
  webPath: string,
  question: string,
): Promise<VisionClassifyResult> {
  const classifier = APPLICATION_FRONTEND_FEATURES.visionClassifierRegistrations[0];
  if (!classifier) {
    throw new Error("No vision classifier is registered for this application composition.");
  }
  return classifier.classify(webPath, question);
}

type VisionObservationSubscriber = (observation: VisionObservation) => void;

const visionObservationSubscribers = new Set<VisionObservationSubscriber>();
let latestVisionObservation: VisionObservation | null = null;

export function recordVisionObservation(observation: VisionObservation): void {
  latestVisionObservation = observation;
  for (const subscriber of Array.from(visionObservationSubscribers)) {
    try {
      subscriber(observation);
    } catch {
      // A misbehaving subscriber must not break the observation bus.
    }
  }
}

export function subscribeVisionObservations(
  subscriber: VisionObservationSubscriber,
): () => void {
  visionObservationSubscribers.add(subscriber);
  return () => {
    visionObservationSubscribers.delete(subscriber);
  };
}

export function getLatestVisionObservation(): VisionObservation | null {
  return latestVisionObservation;
}

export function resetVisionRuntimeForTest(): void {
  latestVisionObservation = null;
  visionObservationSubscribers.clear();
}
