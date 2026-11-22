// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentBackupAi } from "@instafy/sdk/agents";
import { AgentBackupAisField } from "../AgentBackupAisField";
import type { AgentBackupItem } from "../agentBackupAis";

// docs/Settings-UI.md, Bot profiles: Backups lists more of the person's own
// sign-ins after the agent's AI, in order, up to 8, each with Move up, Move
// down and Remove, and Add a backup offers the rest by name.

function id(index: number): string {
  return `8d0c4f5e-1a2b-4c3d-8e9f-0a1b2c3d4e${String(index).padStart(2, "0")}`;
}

function item(index: number, label: string, kind: "credentialId" | "claudeCodeLoginId" = "credentialId"): AgentBackupItem {
  const signIn = { [kind]: id(index) } as AgentBackupAi;
  return { key: `${kind}:${id(index)}`, signIn, label, description: kind === "credentialId" ? "Browser login (device code)" : "Claude Code" };
}

const WORK = item(1, "Work ChatGPT");
const PERSONAL = item(2, "Personal");
const STUDIO = item(3, "Studio Max", "claudeCodeLoginId");

describe("the agent editor's Backups", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("CSS", { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&") });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  /** The field as the editor holds it: what it lists, and what Add a backup still offers. */
  function Editor({ initial, all, onChange }: { initial: AgentBackupItem[]; all: AgentBackupItem[]; onChange: (next: AgentBackupAi[]) => void }) {
    const [rows, setRows] = useState(initial);
    const choices = all.filter((candidate) => !rows.some((row) => row.key === candidate.key));
    return (
      <AgentBackupAisField
        rows={rows}
        choices={choices}
        onChange={(next) => {
          onChange(next);
          setRows(next.map((signIn) => all.find((candidate) => JSON.stringify(candidate.signIn) === JSON.stringify(signIn))!));
        }}
      />
    );
  }

  async function render(initial: AgentBackupItem[], all: AgentBackupItem[] = [WORK, PERSONAL, STUDIO]) {
    const onChange = vi.fn();
    await act(async () => root.render(<Editor initial={initial} all={all} onChange={onChange} />));
    return onChange;
  }

  const button = (testId: string) => container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!;
  const labels = () =>
    [...container.querySelectorAll('[data-testid="agent-profile-backup-label"]')].map((node) => node.textContent);
  async function press(testId: string) {
    await act(async () => button(testId).click());
  }
  async function addFromMenu(label: string) {
    await press("agent-profile-backup-add");
    const option = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) =>
      node.textContent?.startsWith(label),
    );
    expect(option, `menu offers ${label}`).toBeDefined();
    await act(async () => option!.click());
  }

  it("lists the backups in order by name, with what kind each is", async () => {
    await render([WORK, STUDIO]);
    expect(labels()).toEqual(["Work ChatGPT", "Studio Max"]);
    expect(container.textContent).toContain("Claude Code");
    expect(container.querySelector('[role="group"]')?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(button("agent-profile-backup-up-0").getAttribute("aria-label")).toBe("Move Work ChatGPT up");
    expect(button("agent-profile-backup-remove-1").getAttribute("aria-label")).toBe("Remove Studio Max");
  });

  it("moves a backup up and down, never past either end, and keeps focus on it", async () => {
    const onChange = await render([WORK, PERSONAL, STUDIO]);
    expect(button("agent-profile-backup-up-0").disabled).toBe(true);
    expect(button("agent-profile-backup-down-2").disabled).toBe(true);

    await press("agent-profile-backup-down-0");
    expect(onChange).toHaveBeenLastCalledWith([PERSONAL.signIn, WORK.signIn, STUDIO.signIn]);
    expect(labels()).toEqual(["Personal", "Work ChatGPT", "Studio Max"]);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Move Work ChatGPT down");

    await press("agent-profile-backup-up-2");
    expect(onChange).toHaveBeenLastCalledWith([PERSONAL.signIn, STUDIO.signIn, WORK.signIn]);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Move Studio Max up");
    // Moved to the bottom, a backup has no Move down: its Move up takes focus.
    await press("agent-profile-backup-down-1");
    expect(labels()).toEqual(["Personal", "Work ChatGPT", "Studio Max"]);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Move Studio Max up");
  });

  it("removes a backup, handing focus to the one that took its place", async () => {
    const onChange = await render([WORK, PERSONAL]);
    await press("agent-profile-backup-remove-0");
    expect(onChange).toHaveBeenLastCalledWith([PERSONAL.signIn]);
    expect(labels()).toEqual(["Personal"]);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Remove Personal");
    await press("agent-profile-backup-remove-0");
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(labels()).toEqual([]);
    expect(document.activeElement).toBe(button("agent-profile-backup-add"));
  });

  it("adds what Add a backup offers to the end, the rest staying on offer", async () => {
    const onChange = await render([WORK]);
    await addFromMenu("Studio Max");
    expect(onChange).toHaveBeenLastCalledWith([WORK.signIn, STUDIO.signIn]);
    expect(labels()).toEqual(["Work ChatGPT", "Studio Max"]);
    await press("agent-profile-backup-add");
    const offered = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((node) => node.textContent);
    expect(offered).toEqual(["PersonalBrowser login (device code)"]);
  });

  it("holds at most 8, and says so", async () => {
    const all = Array.from({ length: 9 }, (_, index) => item(index + 1, `Sign-in ${index + 1}`));
    const onChange = await render(all.slice(0, 8), all);
    expect(labels()).toHaveLength(8);
    expect(button("agent-profile-backup-add").disabled).toBe(true);
    expect(button("agent-profile-backup-note").textContent).toBe("An agent can have up to 8 backups.");
    await press("agent-profile-backup-remove-7");
    expect(onChange).toHaveBeenLastCalledWith(all.slice(0, 7).map((entry) => entry.signIn));
    expect(button("agent-profile-backup-add").disabled).toBe(false);
    expect(container.querySelector('[data-testid="agent-profile-backup-note"]')).toBeNull();
  });

  it("points to Connections when there is nothing to add", async () => {
    await render([], []);
    expect(labels()).toEqual([]);
    expect(button("agent-profile-backup-add").disabled).toBe(true);
    expect(button("agent-profile-backup-note").textContent).toBe("Connect another AI in Connections to use it here.");
  });

  it("changes nothing while the editor saves", async () => {
    const onChange = vi.fn();
    await act(async () =>
      root.render(<AgentBackupAisField rows={[WORK, PERSONAL]} choices={[STUDIO]} onChange={onChange} disabled />),
    );
    for (const testId of ["agent-profile-backup-down-0", "agent-profile-backup-up-1", "agent-profile-backup-remove-0", "agent-profile-backup-add"]) {
      expect(button(testId).disabled, testId).toBe(true);
    }
  });
});
