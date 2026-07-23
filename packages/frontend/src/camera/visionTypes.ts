export type VisionClassifyResult = {
  label: string;
  answer: string;
  latencyMs: number;
  agentRuntime: string;
};

export type VisionObservation = {
  atMs: number;
  question: string;
  label: string;
  answer: string;
  latencyMs: number;
};

export type VisionClassifierRegistration = {
  id: string;
  classify: (
    webPath: string,
    question: string,
  ) => Promise<VisionClassifyResult>;
};
