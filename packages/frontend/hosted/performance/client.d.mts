export interface PerformanceSample {
  version: 1;
  operation: "studio_startup" | "conversation_switch" | "space_switch" | "organization_switch";
  outcome: "ready" | "error" | "timeout" | "superseded" | "hidden";
  durationMs: number;
  loadingShown: boolean;
  messageCountBucket: "0" | "1-50" | "51-200" | "201-1000" | "1001+";
  viewport: "narrow" | "wide";
}
export function createPerformanceReporter(options?: {
  releaseId?: string;
  fetchImpl?: typeof fetch;
  random?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}): { record: (sample: PerformanceSample) => void; flush: () => void; finish: () => void; dispose: () => void };
