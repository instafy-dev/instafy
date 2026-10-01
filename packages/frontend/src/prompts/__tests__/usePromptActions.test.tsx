/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NEW_SPACE_ID = "11111111-2222-4333-8444-555555555555";

const mocks = vi.hoisted(() => ({
  createControllerProject: vi.fn(),
  createProject: vi.fn(),
  onSubmit: vi.fn(),
}));

vi.mock("../../sdk/instafy", () => ({ controllerClient: { projects: { create: mocks.createControllerProject } } }));
// The new space is already active, so the submit does not wait for the switch.
vi.mock("../../projects/ProjectStateProvider", () => ({
  useProjectState: () => ({ createProject: mocks.createProject, activeProjectId: NEW_SPACE_ID }),
}));
vi.mock("../../conversations/useConversation", () => ({ useConversation: () => ({ onSubmit: mocks.onSubmit }) }));

import { usePromptActions } from "../usePromptActions";

type SubmitPrompt = ReturnType<typeof usePromptActions>["submitPrompt"];

function Harness({ onReady }: { onReady: (submit: SubmitPrompt) => void }) {
  onReady(usePromptActions().submitPrompt);
  return null;
}

describe("usePromptActions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let submitPrompt: SubmitPrompt;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.createControllerProject.mockReset().mockImplementation(async ({ projectName }) => ({
      projectId: NEW_SPACE_ID,
      projectName: projectName ?? null,
      orgId: "org-1",
      orgName: "Personal",
    }));
    mocks.createProject.mockReset();
    mocks.onSubmit.mockReset().mockResolvedValue(undefined);
    await act(async () => root.render(<Harness onReady={(submit) => { submitPrompt = submit; }} />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("names a space made from a connector link after the connector", async () => {
    const prompt =
      "/skills import https://github.com/instafy-dev/skills/tree/main/packs/bookkeeping/.agents/skills/freefinance --name freefinance --start";
    await expect(submitPrompt(prompt)).resolves.toEqual({ status: "success", projectId: NEW_SPACE_ID });
    expect(mocks.createControllerProject).toHaveBeenCalledWith({ projectType: "customer", projectName: "FreeFinance" });
    expect(mocks.createProject).toHaveBeenCalledWith(expect.objectContaining({ projectId: NEW_SPACE_ID, projectName: "FreeFinance" }));
    expect(mocks.onSubmit).toHaveBeenCalledWith(null, prompt);
  });

  it("names a space made from a pack link after the pack", async () => {
    await submitPrompt("/skills import https://github.com/instafy-dev/skills/tree/main/packs/bookkeeping --start");
    expect(mocks.createControllerProject).toHaveBeenLastCalledWith({ projectType: "customer", projectName: "Bookkeeping" });
  });

  it("keeps the name it sends for a long pack name to 60 characters", async () => {
    const slug = Array.from({ length: 40 }, (_, index) => `word${index}`).join("-");
    await submitPrompt(`/skills import https://github.com/acme/tools/tree/main/skills/x --name ${slug} --start`);
    const expected = "Word0 Word1 Word2 Word3 Word4 Word5 Word6 Word7 Word8 Word9";
    expect(mocks.createControllerProject).toHaveBeenLastCalledWith({ projectType: "customer", projectName: expected });
    expect(mocks.createProject).toHaveBeenLastCalledWith(expect.objectContaining({ projectName: expected }));
  });

  it("leaves the space unnamed for a plain prompt, whose words are not for everyone in the space", async () => {
    for (const prompt of ["hi", "draft a launch plan for the spring sale"]) {
      await submitPrompt(prompt);
      expect(mocks.createControllerProject).toHaveBeenLastCalledWith({ projectType: "customer", projectName: undefined });
      expect(mocks.createProject).toHaveBeenLastCalledWith(expect.objectContaining({ projectName: undefined }));
    }
  });
});
