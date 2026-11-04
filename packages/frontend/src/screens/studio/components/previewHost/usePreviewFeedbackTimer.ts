import { useVisibleReadingTimer } from "../../../../status/useVisibleReadingTimer";

export { useVisibleReadingTimer as usePreviewFeedbackTimer };
export type PreviewFeedbackTiming = ReturnType<typeof useVisibleReadingTimer>;
