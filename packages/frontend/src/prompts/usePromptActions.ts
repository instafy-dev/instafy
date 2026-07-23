import { useCallback, useRef } from "react";
import { useProjectState } from "../projects/ProjectStateProvider";
import { useConversation } from "../conversations/useConversation";
import { controllerClient } from "../sdk/instafy";

export type SubmitPromptStatus = "skipped" | "success" | "error";

export interface SubmitPromptResult {
  status: SubmitPromptStatus;
  projectId?: string;
  error?: unknown;
}

export function usePromptActions() {
  const { create: createControllerProject } = controllerClient.projects;
  const { createProject, activeProjectId } = useProjectState();
  const { onSubmit } = useConversation();
  const activeProjectIdRef = useRef(activeProjectId);
  const submitRef = useRef(onSubmit);
  activeProjectIdRef.current = activeProjectId;
  submitRef.current = onSubmit;

  const submitPrompt = useCallback(
    async (rawPrompt: string): Promise<SubmitPromptResult> => {
      const prompt = rawPrompt.trim();
      if (!prompt) {
        return { status: "skipped" };
      }

      try {
        const projectInfo = await createControllerProject({ projectType: "customer" });
        if (!projectInfo?.projectId) {
          return { status: "error", error: new Error("Unable to create project") };
        }
        createProject({
          projectId: projectInfo.projectId,
          orgId: projectInfo.orgId ?? null,
          orgName: projectInfo.orgName ?? null
        });
        const deadline = Date.now() + 2_000;
        while (activeProjectIdRef.current !== projectInfo.projectId && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
        await submitRef.current(null, prompt);
        return { status: "success", projectId: projectInfo.projectId };
      } catch (error) {
        return { status: "error", error };
      }
    },
    [createControllerProject, createProject]
  );

  return { submitPrompt };
}
