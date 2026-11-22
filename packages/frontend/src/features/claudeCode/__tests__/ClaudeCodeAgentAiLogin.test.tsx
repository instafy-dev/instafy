// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerAgentProfile } from "@instafy/sdk/agents";
import type { TurnEngineAgentAiRequestFields } from "../../frontendFeatureModule";
import { ClaudeCodeAgentAiLabel, ClaudeCodeAgentAiLogin } from "../ClaudeCodeAgentAiLogin";
import { setClaudeCodeLoginsLoaderForTests } from "../claudeCodeLoginsStore";
import { bannedWordIn } from "./claudeCodeBannedWords";

// docs/Settings-UI.md (Bot profiles), docs/Local-Engine-Turns.md 11.19: with
// Claude Code chosen and more than one login, the agent editor offers which
// login the agent's turns run on, and the agents list names it.

const PERSONAL = { id: "6f1c2a43-7b7e-4c51-9a0e-2d4b1f6a8c01", label: "Personal", createdAt: "2026-11-01T09:00:00Z" };
const WORK = { id: "0b8e5d27-91a4-4f6c-b3d2-5e7a9c1f4e02", label: "Work", createdAt: "2026-11-02T09:00:00Z" };

function agent(claudeCodeLoginId: string | null): ControllerAgentProfile {
  return {
    id: "agent-1",
    handle: "reviewer",
    displayName: "Reviewer",
    description: null,
    bio: null,
    avatarSeed: "hatchling:3",
    provider: "claude-code",
    model: null,
    reasoningEffort: null,
    credentialId: null,
    claudeCodeLoginId,
    runtimeId: null,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
  };
}

describe("which Claude Code login an agent uses", () => {
  let container: HTMLDivElement;
  let root: Root;
  let logins: Array<typeof PERSONAL>;
  let loader: ReturnType<typeof vi.fn>;
  let onFieldsChange: ReturnType<typeof vi.fn<(fields: TurnEngineAgentAiRequestFields) => void>>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("CSS", { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&") });
    logins = [PERSONAL, WORK];
    loader = vi.fn(async () => ({ success: true, logins: [...logins] }));
    setClaudeCodeLoginsLoaderForTests(loader as never);
    onFieldsChange = vi.fn<(fields: TurnEngineAgentAiRequestFields) => void>();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    setClaudeCodeLoginsLoaderForTests(null);
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderChoice(
    editing: ControllerAgentProfile | null,
    fields: TurnEngineAgentAiRequestFields | null = null,
  ) {
    await act(async () => {
      root.render(
        <ClaudeCodeAgentAiLogin
          agent={editing}
          fields={fields}
          onFieldsChange={onFieldsChange}
          disabled={false}
          resolveControllerUrl={async () => "https://controller.example.test"}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  const trigger = () => container.querySelector<HTMLButtonElement>('[data-testid="agent-profile-claude-code-login"]');
  const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => option.textContent);

  async function pick(label: string) {
    await act(async () => trigger()?.click());
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent === label);
    expect(option, label).toBeDefined();
    await act(async () => option?.click());
  }

  it("lists the person's logins by name, the oldest marked as the first, under a Login label", async () => {
    await renderChoice(agent(null));
    expect(container.textContent).toContain("Login");
    // An agent that names no login runs on the first one.
    expect(trigger()?.textContent).toContain("Personal (first login)");
    await act(async () => trigger()?.click());
    expect(options()).toEqual(["Personal (first login)", "Work"]);
    expect(bannedWordIn(container.textContent ?? "")).toBeNull();
    // The list is asked for each time the editor opens: a login added elsewhere shows.
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("sets the login chosen, and null for the first one", async () => {
    await renderChoice(agent(null));
    await pick("Work");
    expect(onFieldsChange).toHaveBeenLastCalledWith({ claudeCodeLoginId: WORK.id });

    await renderChoice(agent(WORK.id));
    expect(trigger()?.textContent).toContain("Work");
    await pick("Personal (first login)");
    expect(onFieldsChange).toHaveBeenLastCalledWith({ claudeCodeLoginId: null });
  });

  it("shows what the editor's draft set over what the agent saved", async () => {
    await renderChoice(agent(null), { claudeCodeLoginId: WORK.id });
    expect(trigger()?.textContent).toContain("Work");
    await renderChoice(agent(WORK.id), { claudeCodeLoginId: null });
    expect(trigger()?.textContent).toContain("Personal (first login)");
    // A login the person no longer has reads as the first, which the agent runs on.
    await renderChoice(agent("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"));
    expect(trigger()?.textContent).toContain("Personal (first login)");
  });

  it("offers no choice to a person with one login or none", async () => {
    logins = [PERSONAL];
    await renderChoice(agent(null));
    expect(container.innerHTML).toBe("");
    logins = [];
    await renderChoice(null);
    expect(container.innerHTML).toBe("");
    expect(onFieldsChange).not.toHaveBeenCalled();
  });

  it("names the login in the agents list only when the agent names one and the person has more than one", async () => {
    const renderLabel = async (claudeCodeLoginId: string | null) => {
      await act(async () => {
        root.render(<ClaudeCodeAgentAiLabel agent={agent(claudeCodeLoginId)} />);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      return container.textContent;
    };
    expect(await renderLabel(WORK.id)).toBe("Claude Code (Work)");
    expect(await renderLabel(null)).toBe("Claude Code");
    expect(await renderLabel("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")).toBe("Claude Code");
    setClaudeCodeLoginsLoaderForTests(async () => ({ success: true, logins: [WORK] }));
    expect(await renderLabel(WORK.id)).toBe("Claude Code");
  });
});
