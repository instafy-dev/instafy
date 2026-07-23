import { test, expect, type Page } from "@playwright/test";
import {
  assertGitRemoteFileText,
  clearRuntimePreference,
  prepareStudio,
  pushGitRemoteFileText,
  readWorkspaceFileText,
  requestHostedRuntime,
  resetRuntimeUserState,
  syncGitRemote,
  waitForHostedRuntimeReady,
  writeWorkspaceFile,
} from "../utils/harness.js";

async function ensureHostedRuntimeReady(page: Page, projectId: string) {
  const ready = await waitForHostedRuntimeReady(page, 10_000).then(() => true).catch(() => false);
  if (!ready) {
    await requestHostedRuntime(page, { projectId }).catch(() => {});
  }
  await waitForHostedRuntimeReady(page, 120_000);
}

async function sendChatAndWait(page: Page, message: string, options?: { timeoutMs?: number }) {
  const assistantResponses = page.locator('[data-testid="chat-bubble-assistant"]');
  const beforeCount = await assistantResponses.count();

  await page.getByTestId("chat-input").fill(message);
  await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId("chat-send-button").click();

  const timeoutMs = options?.timeoutMs ?? 180_000;
  await assistantResponses.nth(beforeCount).waitFor({ timeout: timeoutMs });
  const text = (await assistantResponses.last().innerText()).trim();

  const typingIndicator = page.getByTestId("assistant-typing-indicator");
  await typingIndicator
    .waitFor({ state: "detached", timeout: timeoutMs })
    .catch(() => {});

  return text;
}

test.describe("Agent git conflict handling (opt-in)", () => {
  test.skip(
    (process.env.GIT_CANONICAL ?? "").trim() !== "1",
    "Requires git-canonical stack (start with GIT_CANONICAL=1)."
  );
  test.skip(
    (process.env.PLAYWRIGHT_SKIP_CODEX ?? "").trim() === "1",
    "Codex backend unavailable (rate limited). Provide Codex auth (OPENAI_API_KEY or tmp/proxy-codex/auth.json)."
  );
  test.skip(
    (process.env.PLAYWRIGHT_AGENT_GIT_CONFLICTS ?? "").trim() !== "1",
    "Enable with PLAYWRIGHT_AGENT_GIT_CONFLICTS=1 (agent-driven git sync can be flaky)."
  );

  test.describe.configure({ timeout: 900_000 });
  let activeProjectId: string | null = null;

  test.beforeEach(async ({ page }) => {
    page.setDefaultTimeout(60_000);
    const projectId = await prepareStudio(page);
    activeProjectId = projectId;
    await clearRuntimePreference(page, { projectId, source: "agent-git-conflict-resolution" });
    if (projectId) {
      await ensureHostedRuntimeReady(page, projectId);
    }
  });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "agent-git-conflict-resolution:cleanup" }).catch(
      () => {}
    );
  });

  test("asks user for decision on image-like conflict", async ({ page }) => {
    if (!activeProjectId) {
      throw new Error("Active project id missing in agent git conflict test.");
    }

    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const filePath = `assets/playwright-conflict-${unique}.png`;
    const baseImage = `data:image/png;base64,base-${unique}`;
    const localImage = `data:image/png;base64,local-${unique}`;
    const remoteImage = `data:image/png;base64,remote-${unique}`;

    await writeWorkspaceFile(page, filePath, `${baseImage}\n`, { projectId: activeProjectId });
    const seeded = await syncGitRemote(page, {
      projectId: activeProjectId,
      message: `playwright: seed ${filePath}`,
    });
    if (!seeded) {
      throw new Error("Expected git sync to return a commit hash for baseline seed, but got null.");
    }
    await assertGitRemoteFileText(page, filePath, {
      projectId: activeProjectId,
      expectedText: baseImage,
      requireGitRemote: true,
    });

    // Seed the local (uncommitted) divergence deterministically via the harness.
    // This test's subject is the agent's conflict *decision* at SYNC NOW below — not
    // whether the agent can be coaxed into "edit the file but don't sync yet", which is
    // a fragile choreography that git-canonical's auto-sync default makes
    // non-deterministic: the agent either syncs the edit anyway (remote advances to
    // `local`) or never persists the write (workspace stays `base`). Writing the
    // working tree directly leaves HEAD at the `base` commit with `local` uncommitted,
    // exactly the pre-conflict state the SYNC NOW step needs, with no model in the loop.
    await writeWorkspaceFile(page, filePath, `${localImage}\n`, { projectId: activeProjectId });

    await expect
      .poll(
        async () =>
          (await readWorkspaceFileText(page, filePath, { projectId: activeProjectId }))?.trim(),
        { timeout: 120_000 }
      )
      .toBe(localImage);

    await assertGitRemoteFileText(page, filePath, {
      projectId: activeProjectId,
      expectedText: baseImage,
      requireGitRemote: true,
    });

    const remoteCommit = await pushGitRemoteFileText(page, filePath, `${remoteImage}\n`, {
      projectId: activeProjectId,
      message: `playwright: remote advance ${filePath}`,
      requireGitRemote: true,
    });
    if (!remoteCommit) {
      throw new Error("Expected remote push to return a commit hash, but got null.");
    }
    await assertGitRemoteFileText(page, filePath, {
      projectId: activeProjectId,
      expectedText: remoteImage,
      requireGitRemote: true,
    });

    const conflictReply = await sendChatAndWait(
      page,
      [
        "SYNC NOW.",
        "",
        "Sync your local changes to the canonical git remote (git-canonical workflow).",
        `If you hit a merge conflict on \`${filePath}\` (treat it like an image/binary), do not guess or auto-merge.`,
        "Ask me which version to keep (local vs remote) and stop.",
      ].join("\n"),
      { timeoutMs: 480_000 }
    );
    expect(conflictReply.length).toBeGreaterThan(0);

    await assertGitRemoteFileText(page, filePath, {
      projectId: activeProjectId,
      expectedText: remoteImage,
      requireGitRemote: true,
    });
    const localAfter = await readWorkspaceFileText(page, filePath, { projectId: activeProjectId });
    expect(localAfter).not.toBeNull();
    const localAfterTrimmed = localAfter?.trim() ?? "";
    if (localAfterTrimmed === localImage || localAfterTrimmed === remoteImage) {
      expect([localImage, remoteImage]).toContain(localAfterTrimmed);
    } else {
      expect(localAfterTrimmed).toContain(localImage);
      expect(localAfterTrimmed).toContain(remoteImage);
    }
  });

  test("resolves todo conflict by merging and pushing", async ({ page }) => {
    if (!activeProjectId) {
      throw new Error("Active project id missing in agent git conflict test.");
    }

    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const filePath = `playwright/todo-conflict-${unique}.txt`;
    const baseText = `TODO: milk`;
    const localText = `TODO: milk + eggs`;
    const remoteText = `TODO: milk + bread`;
    const mergedText = `TODO: milk + bread + eggs`;

    await writeWorkspaceFile(page, filePath, `${baseText}\n`, { projectId: activeProjectId });
    const seeded = await syncGitRemote(page, {
      projectId: activeProjectId,
      message: `playwright: seed ${filePath}`,
    });
    if (!seeded) {
      throw new Error("Expected git sync to return a commit hash for baseline seed, but got null.");
    }
    await assertGitRemoteFileText(page, filePath, {
      projectId: activeProjectId,
      expectedText: baseText,
      requireGitRemote: true,
    });

    // Seed the local (uncommitted) divergence deterministically via the harness, for the
    // same reason as the image-like test above: "edit the file but don't sync yet" is a
    // fragile choreography that git-canonical's auto-sync default makes non-deterministic
    // (the agent either syncs the edit anyway or never persists it). Writing the working
    // tree directly leaves HEAD at the base commit with `local` uncommitted, so the agent's
    // later commit+rebase still has `base` as the merge base — preserving the 3-way merge
    // (base->local vs base->remote) this test's subject depends on, with no model in the loop.
    await writeWorkspaceFile(page, filePath, `${localText}\n`, { projectId: activeProjectId });

    await expect
      .poll(
        async () =>
          (await readWorkspaceFileText(page, filePath, { projectId: activeProjectId }))?.trim(),
        { timeout: 120_000 }
      )
      .toBe(localText);

    await assertGitRemoteFileText(page, filePath, {
      projectId: activeProjectId,
      expectedText: baseText,
      requireGitRemote: true,
    });

    const remoteCommit = await pushGitRemoteFileText(page, filePath, `${remoteText}\n`, {
      projectId: activeProjectId,
      message: `playwright: remote advance ${filePath}`,
      requireGitRemote: true,
    });
    if (!remoteCommit) {
      throw new Error("Expected remote push to return a commit hash, but got null.");
    }
    await assertGitRemoteFileText(page, filePath, {
      projectId: activeProjectId,
      expectedText: remoteText,
      requireGitRemote: true,
    });

    const mergeReply = await sendChatAndWait(
      page,
      [
        "SYNC NOW.",
        "",
        "Sync your local changes to the canonical git remote (git-canonical workflow).",
        "Do NOT use `instafy git sync` for this (it can’t resolve conflicts). Use manual fetch/rebase/push.",
        `Final requirement: after the sync completes, \`${filePath}\` must contain EXACTLY:`,
        mergedText,
        "",
        `If there is a merge conflict on \`${filePath}\`, resolve it automatically by producing the merged file content EXACTLY as:`,
        mergedText,
        "",
        "Deterministic steps:",
        `- instafy git add -A`,
        `- instafy git commit -m "instafy: sync" (or commit --amend if rebase stopped at an edit)`,
        `- instafy git fetch origin main`,
        `- instafy git rebase origin/main`,
        `- if conflict: overwrite ${filePath} to exactly the merged line, instafy git add -- ${filePath}, instafy git rebase --continue`,
        `- instafy git push origin HEAD:main`,
        `- verify: instafy git show origin/main:${filePath} == ${mergedText}`,
        "",
        "Then complete the rebase/merge and push to main.",
      ].join("\n"),
      { timeoutMs: 600_000 }
    );
    expect(mergeReply.length).toBeGreaterThan(0);

    await expect
      .poll(
        async () =>
          (await readWorkspaceFileText(page, filePath, { projectId: activeProjectId }))?.trim(),
        { timeout: 180_000 }
      )
      .toBe(mergedText);

    await assertGitRemoteFileText(page, filePath, {
      projectId: activeProjectId,
      expectedText: mergedText,
      requireGitRemote: true,
      timeoutMs: 180_000,
    });
  });

  test("resolves todo conflict end-to-end without pausing", async ({ page }) => {
    if (!activeProjectId) {
      throw new Error("Active project id missing in agent git conflict test.");
    }

    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const filePath = `playwright/todo-conflict-auto-${unique}.txt`;
    const baseText = `TODO: milk`;
    const localText = `TODO: milk + eggs`;
    const remoteText = `TODO: milk + bread`;
    const mergedText = `TODO: milk + bread + eggs`;

    await writeWorkspaceFile(page, filePath, `${baseText}\n`, { projectId: activeProjectId });
    const seeded = await syncGitRemote(page, {
      projectId: activeProjectId,
      message: `playwright: seed ${filePath}`,
    });
    if (!seeded) {
      throw new Error("Expected git sync to return a commit hash for baseline seed, but got null.");
    }

    // Seed the local (uncommitted) divergence deterministically BEFORE advancing the
    // remote — matching the image-like and todo-merge tests, and removing the last
    // LLM-dependent precondition (previously the agent authored this edit in-prompt).
    // Seeding before the remote push keeps the worktree dirty when origin moves ahead,
    // so the runtime's ff-only-when-clean refresh cannot fast-forward HEAD off the base
    // commit and destroy the 3-way merge base. writeWorkspaceFile does not auto-commit
    // (autoCommitAfterApply defaults false), so HEAD stays at the base commit with
    // `local` uncommitted. The agent below only syncs + resolves.
    await writeWorkspaceFile(page, filePath, `${localText}\n`, { projectId: activeProjectId });

    await expect
      .poll(
        async () =>
          (await readWorkspaceFileText(page, filePath, { projectId: activeProjectId }))?.trim(),
        { timeout: 120_000 }
      )
      .toBe(localText);

    const remoteCommit = await pushGitRemoteFileText(page, filePath, `${remoteText}\n`, {
      projectId: activeProjectId,
      message: `playwright: remote advance ${filePath}`,
      requireGitRemote: true,
    });
    if (!remoteCommit) {
      throw new Error("Expected remote push to return a commit hash, but got null.");
    }

    await assertGitRemoteFileText(page, filePath, {
      projectId: activeProjectId,
      expectedText: remoteText,
      requireGitRemote: true,
    });

    const reply = await sendChatAndWait(
      page,
      [
        "Sync your local changes to the canonical git remote (git-canonical workflow).",
        "Do NOT use `instafy git sync` for this (it can’t resolve conflicts). Use manual fetch/rebase/push.",
        `Final requirement: after the sync completes, \`${filePath}\` must contain EXACTLY:`,
        mergedText,
        "",
        `If there is a merge conflict on \`${filePath}\`, resolve it automatically by producing the merged file content EXACTLY as:`,
        mergedText,
        "",
        "Deterministic steps:",
        `- instafy git add -A`,
        `- instafy git commit -m "instafy: sync" (or commit --amend if rebase stopped at an edit)`,
        `- instafy git fetch origin main`,
        `- instafy git rebase origin/main`,
        `- if conflict: overwrite ${filePath} to exactly the merged line, instafy git add -- ${filePath}, instafy git rebase --continue`,
        `- instafy git push origin HEAD:main`,
        `- verify: instafy git show origin/main:${filePath} == ${mergedText}`,
        "",
        "Then complete the rebase/merge and push to main.",
      ].join("\n"),
      { timeoutMs: 600_000 }
    );
    expect(reply.length).toBeGreaterThan(0);

    await expect
      .poll(
        async () =>
          (await readWorkspaceFileText(page, filePath, { projectId: activeProjectId }))?.trim(),
        { timeout: 180_000 }
      )
      .toBe(mergedText);

    await assertGitRemoteFileText(page, filePath, {
      projectId: activeProjectId,
      expectedText: mergedText,
      requireGitRemote: true,
      timeoutMs: 180_000,
    });
  });
});
