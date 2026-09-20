// @vitest-environment jsdom

import { act, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSkillsImportFlow } from "../useSkillsImportFlow";

type HookOptions = Parameters<typeof useSkillsImportFlow>[0];
type HookResult = ReturnType<typeof useSkillsImportFlow>;

const SOURCE = "https://github.com/acme/skills-pack";

function Harness({
  options,
  resultRef,
}: {
  options: HookOptions;
  resultRef: MutableRefObject<HookResult | null>;
}) {
  resultRef.current = useSkillsImportFlow(options);
  return null;
}

function baseOptions(overrides: Partial<HookOptions> = {}): HookOptions {
  return {
    activeConversationId: "conversation-1",
    assistantEnabled: true,
    onSubmit: vi.fn(async () => undefined),
    showStatus: vi.fn(),
    ...overrides,
  };
}

describe("useSkillsImportFlow", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    vi.useRealTimers();
  });

  async function renderHook(options: HookOptions) {
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => {
      root.render(<Harness options={options} resultRef={resultRef} />);
    });
    return { resultRef, rerender: async (next: HookOptions) => {
      await act(async () => {
        root.render(<Harness options={next} resultRef={resultRef} />);
      });
    } };
  }

  it("takes no tab, conversation or navigation callbacks", () => {
    // The hook's param type carries none of the old navigation plumbing;
    // tab auto-add and selection sync are platform behaviour outside it.
    type ForbiddenKeys =
      | "createConversation"
      | "conversations"
      | "openConversationTab"
      | "requestUrlPush"
      | "openPanelTab"
      | "buildImportTaskPrompt";
    const check: Extract<keyof HookOptions, ForbiddenKeys> extends never ? true : false = true;
    expect(check).toBe(true);
  });

  it("sends exactly one /skills import line in place with expectedLaneIdle", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const showStatus = vi.fn();
    const { resultRef } = await renderHook(baseOptions({ onSubmit, showStatus }));

    let queued: boolean | undefined;
    await act(async () => {
      queued = await resultRef.current!.queueSkillImportTask({ source: SOURCE, overwrite: false });
    });

    expect(queued).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("conversation-1", `/skills import ${SOURCE} --start`, {
      expectedLaneIdle: true,
    });
    expect(showStatus).toHaveBeenCalledTimes(1);
    expect(showStatus).toHaveBeenCalledWith(
      "Adding skills from skills-pack.",
      "info",
      3500,
      undefined,
    );
  });

  it("passes a null conversation through so the submit path can create one", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const { resultRef } = await renderHook(baseOptions({ activeConversationId: null, onSubmit }));

    await act(async () => {
      await resultRef.current!.queueSkillImportTask({ source: SOURCE, overwrite: false });
    });

    expect(onSubmit).toHaveBeenCalledWith(null, `/skills import ${SOURCE} --start`, {
      expectedLaneIdle: true,
    });
  });

  it("reads the active conversation at send time, not from a stale closure", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const { resultRef, rerender } = await renderHook(baseOptions({ onSubmit }));
    const queue = resultRef.current!.queueSkillImportTask;
    await rerender(baseOptions({ activeConversationId: "conversation-2", onSubmit }));

    await act(async () => {
      await queue({ source: SOURCE, overwrite: false });
    });

    expect((onSubmit.mock.calls[0] as unknown[] | undefined)?.[0]).toBe("conversation-2");
  });

  it("refuses to send with AI off and keeps the modal open", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const showStatus = vi.fn();
    const { resultRef } = await renderHook(baseOptions({ assistantEnabled: false, onSubmit, showStatus }));

    await act(async () => {
      resultRef.current!.handleOpenAddSkillModal({ source: SOURCE, name: "books" });
    });
    expect(resultRef.current!.addSkillModalOpen).toBe(true);

    await act(async () => {
      await resultRef.current!.handleSubmitImport({ closeModalOnSuccess: true });
    });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(showStatus).toHaveBeenCalledWith("Turn on AI for this chat, then add skills.", "warning", 4000);
    expect(resultRef.current!.addSkillModalOpen).toBe(true);
    expect(resultRef.current!.importSource).toBe(SOURCE);
    expect(resultRef.current!.importName).toBe("books");
  });

  it("carries the Open chat action only when onOpenChat is provided and never calls it on send", async () => {
    const onOpenChat = vi.fn();
    const showStatus = vi.fn();
    const { resultRef } = await renderHook(baseOptions({ showStatus, onOpenChat }));

    await act(async () => {
      await resultRef.current!.queueSkillImportTask({ source: SOURCE, overwrite: false });
    });

    expect(onOpenChat).not.toHaveBeenCalled();
    const options = showStatus.mock.calls[0]?.[3] as { actionLabel?: string; onAction?: () => void };
    expect(options.actionLabel).toBe("Open chat");
    options.onAction?.();
    expect(onOpenChat).toHaveBeenCalledTimes(1);
  });

  it("schedules loadSkills at 2 s and 7 s only when provided", async () => {
    vi.useFakeTimers();
    const loadSkills = vi.fn(async () => undefined);
    const { resultRef } = await renderHook(baseOptions({ loadSkills }));

    await act(async () => {
      await resultRef.current!.queueSkillImportTask({ source: SOURCE, overwrite: false });
    });
    expect(loadSkills).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(loadSkills).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(loadSkills).toHaveBeenCalledTimes(2);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(loadSkills).toHaveBeenCalledTimes(2);
  });

  it("does not schedule anything without loadSkills", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const { resultRef } = await renderHook(baseOptions());

    await act(async () => {
      await resultRef.current!.queueSkillImportTask({ source: SOURCE, overwrite: false });
    });
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });

  it("resets the form and closes the modal after Add and start", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const { resultRef } = await renderHook(baseOptions({ onSubmit }));

    await act(async () => {
      resultRef.current!.handleOpenAddSkillModal();
      resultRef.current!.setImportSource("playwright/skill-import-fixture");
      resultRef.current!.setImportName("My Skill");
      resultRef.current!.setImportOverwrite(true);
    });
    await act(async () => {
      await resultRef.current!.handleSubmitImport({ closeModalOnSuccess: true });
    });

    expect(onSubmit).toHaveBeenCalledWith(
      "conversation-1",
      "/skills import playwright/skill-import-fixture --name my-skill --overwrite --start",
      { expectedLaneIdle: true },
    );
    expect(resultRef.current!.addSkillModalOpen).toBe(false);
    expect(resultRef.current!.importSource).toBe("");
    expect(resultRef.current!.importName).toBe("");
    expect(resultRef.current!.importOverwrite).toBe(false);
    expect(resultRef.current!.importPending).toBe(false);
  });

  it("keeps the modal open and shows the error toast when the send fails", async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error("Lane unavailable");
    });
    const showStatus = vi.fn();
    const { resultRef } = await renderHook(baseOptions({ onSubmit, showStatus }));

    await act(async () => {
      resultRef.current!.handleOpenAddSkillModal({ source: SOURCE });
    });
    await act(async () => {
      await resultRef.current!.handleSubmitImport({ closeModalOnSuccess: true });
    });

    expect(showStatus).toHaveBeenCalledWith("Lane unavailable", "error", 4500);
    expect(resultRef.current!.addSkillModalOpen).toBe(true);
    expect(resultRef.current!.importSource).toBe(SOURCE);
    expect(resultRef.current!.importPending).toBe(false);
  });

  it("rejects a source with spaces before sending", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const showStatus = vi.fn();
    const { resultRef } = await renderHook(baseOptions({ onSubmit, showStatus }));

    await act(async () => {
      resultRef.current!.handleOpenAddSkillModal({ source: "https://github.com/a/b c" });
    });
    await act(async () => {
      await resultRef.current!.handleSubmitImport({ closeModalOnSuccess: true });
    });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(showStatus).toHaveBeenCalledWith("Skill source cannot contain spaces.", "error", 4500);
    expect(resultRef.current!.addSkillModalOpen).toBe(true);
  });

  it("uses the product label for a tile send", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const showStatus = vi.fn();
    const { resultRef } = await renderHook(baseOptions({ onSubmit, showStatus }));
    const source = "https://github.com/instafy-dev/skills/tree/main/packs/team/.agents/skills/slack";

    await act(async () => {
      await resultRef.current!.queueSkillImportTask({
        source,
        skillName: "slack",
        overwrite: false,
        label: "Slack",
      });
    });

    expect(onSubmit).toHaveBeenCalledWith("conversation-1", `/skills import ${source} --name slack --start`, {
      expectedLaneIdle: true,
    });
    expect(showStatus).toHaveBeenCalledWith("Connecting Slack.", "info", 3500, undefined);
  });
});
