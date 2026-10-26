import type { LocalCapabilityArtifactRegistration } from "@instafy/frontend/feature-api";
import {
  isLearnDraftPayload,
  promoteRobotLearnDraftToProjectMemory,
} from "../robot/projectMemoryPromotion";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export const KNOSH_LEARNING_ARTIFACT_REGISTRATION: LocalCapabilityArtifactRegistration = {
  id: "knosh.learning-draft",
  extract(message) {
    const metadata = isRecord(message.metadata) ? message.metadata : null;
    const robotLearning = isRecord(metadata?.robotLearning)
      ? metadata.robotLearning
      : null;
    const learnDraft = robotLearning?.learnDraft;
    if (!isLearnDraftPayload(learnDraft)) {
      return null;
    }
    return {
      value: learnDraft,
      suggestedPath: learnDraft.project_memory_candidate.suggested_block_path,
      readyLabel: "Robot learn draft ready",
      savedLabel: "Project memory updated",
      saveSuccessMessage: "Saved robot learning to project memory.",
      saveErrorMessage: "Unable to save robot learning.",
    };
  },
  async promote({ projectId, artifact }) {
    if (!isLearnDraftPayload(artifact.value)) {
      throw new Error("The Knosh learning artifact is malformed.");
    }
    await promoteRobotLearnDraftToProjectMemory({
      projectId,
      learnDraft: artifact.value,
    });
  },
};
