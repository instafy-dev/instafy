import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assertGitRemoteFileText,
  assertGitRemotePathIsNotGitlink,
  clearRuntimePreference,
  ensureRealDefaultCodexCredential,
  expectAssistantReplyOrSkipRateLimit,
  prepareStudio,
  readWorkspaceFileText,
  requestHostedRuntime,
  purgeRealUserCredential,
  resetRuntimeUserState,
  syncGitRemote,
  type HostedRuntimeReadyResult,
  waitForHostedRuntimeReady,
  writeWorkspaceFile,
} from "../utils/harness.js";

// This suite may onboard the machine's real Codex credential. Never retain a
// Playwright trace containing credential or session material.
test.use({ trace: "off" });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../../../..");
const dockerDir = path.join(repoRoot, "docker");
const defaultWorkspaceRoot = path.join(repoRoot, "tmp", "runtime-sandbox");
const defaultOriginWorkspaceRoot = path.join(repoRoot, "tmp", "origin-gateway-workspaces");

function resolveWorkspacePath(value: string | undefined, fallback: string): string {
  if (!value || value.trim().length === 0) {
    return fallback;
  }
  const trimmed = value.trim();
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(dockerDir, trimmed);
}

function workspaceRootsForTests(): string[] {
  return [
    resolveWorkspacePath(process.env.WORKSPACE_ROOT, defaultWorkspaceRoot),
    resolveWorkspacePath(process.env.ORIGIN_GATEWAY_WORKSPACE_VOLUME, defaultOriginWorkspaceRoot),
  ];
}

function initEmbeddedGitRepo(projectId: string, repoDir: string): void {
  for (const root of new Set(workspaceRootsForTests())) {
    const target = path.join(root, projectId, ...repoDir.split("/"));
    fs.mkdirSync(target, { recursive: true });
    const init = spawnSync("git", ["init"], { cwd: target, encoding: "utf8" });
    if ((init.status ?? 1) !== 0) {
      throw new Error(
        `Failed to initialize embedded git repo at ${target}: ${(init.stderr || init.stdout || "").trim()}`
      );
    }
  }
}

async function ensureHostedRuntimeReady(
  page: Page,
  projectId: string
): Promise<HostedRuntimeReadyResult> {
  const ready = await waitForHostedRuntimeReady(page, 10_000, { projectId })
    .then(() => true)
    .catch(() => false);
  if (!ready) {
    await requestHostedRuntime(page, { projectId, source: "chat", timeoutMs: 180_000 }).catch(
      () => {}
    );
  }
  return await waitForHostedRuntimeReady(page, 180_000, { projectId });
}

async function selectHostedRuntimeForChat(page: Page, runtime: HostedRuntimeReadyResult) {
  const refreshRuntimeStatuses = async () => {
    await page
      .evaluate(async () => {
        const runtimeApi = (window as any)?.__INSTAFY_RUNTIME__;
        if (runtimeApi?.refreshRuntimeStatuses) {
          await runtimeApi.refreshRuntimeStatuses();
        }
      })
      .catch(() => {});
  };

  await refreshRuntimeStatuses();
  const runtimeButton = page.getByTestId("runtime-selector-button").first();
  await runtimeButton.scrollIntoViewIfNeeded().catch(() => {});
  await runtimeButton.click();
  const popover = page.getByTestId("runtime-selector-popover");
  await expect(popover).toBeVisible({ timeout: 10_000 });

  const deadline = Date.now() + 30_000;
  let selected = false;

  while (Date.now() < deadline && !selected) {
    const runtimeOption = popover.locator('[role="button"]').filter({ hasText: /rt:/i }).first();
    if (await runtimeOption.isVisible().catch(() => false)) {
      await runtimeOption.click();
      selected = true;
      break;
    }
    await refreshRuntimeStatuses();
    await page.waitForTimeout(500);
  }

  if (!selected) {
    throw new Error(
      `Unable to find hosted runtime option in runtime menu. runtimeId=${runtime.runtimeId ?? "null"} displayName=${runtime.displayName ?? "null"}`
    );
  }

  await expect(page.getByTestId("runtime-selector-popover")).toBeHidden({ timeout: 10_000 });
  await expect(runtimeButton).not.toContainText(/missing runtime/i, { timeout: 30_000 });
}

async function setAssistantAutoSync(page: Page, enabled: boolean) {
  await page.evaluate((value) => {
    window.localStorage.setItem("instafy.git.autoSyncAfterApply", value ? "1" : "0");
  }, enabled);
}

async function sendChatAndWait(
  page: Page,
  message: string,
  options?: { timeoutMs?: number; expected?: RegExp }
) {
  const assistantResponses = page.locator('[data-testid="chat-bubble-assistant"]');
  const beforeCount = await assistantResponses.count();

  await page.getByTestId("chat-input").fill(message);
  await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId("chat-send-button").click();

  const timeoutMs = options?.timeoutMs ?? 240_000;
  const expected = options?.expected;
  const matchesExpected = (value: string) => {
    if (!expected) {
      return value.trim().length > 0;
    }
    if (expected.test(value)) {
      return true;
    }
    return value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .some((line) => line.length > 0 && expected.test(line));
  };
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    const count = await assistantResponses.count();
    if (count > beforeCount) {
      for (let index = beforeCount; index < count; index += 1) {
        const candidateBubble = assistantResponses.nth(index);
        const candidateText = (await candidateBubble.innerText().catch(() => "")).trim();
        const messageType = await candidateBubble.getAttribute("data-message-type");
        if (messageType === "error") {
          const lowered = candidateText.toLowerCase();
          const rateLimited =
            lowered.includes("usage_limit_reached") ||
            lowered.includes("too many requests") ||
            lowered.includes("rate limit") ||
            lowered.includes("upstream 429") ||
            lowered.includes("429");
          if (rateLimited) {
            test.skip(
              true,
              `Codex backend rate-limited; skipping Codex-dependent assertion. (${candidateText.replace(/\s+/g, " ").slice(0, 240)})`
            );
          }
          await expectAssistantReplyOrSkipRateLimit(page, /[\s\S]+/, { timeout: timeoutMs });
        }
        if (matchesExpected(candidateText)) {
          text = candidateText;
          break;
        }
        if (!text && candidateText) {
          text = candidateText;
        }
      }
    }
    if (matchesExpected(text)) {
      break;
    }
    await page.waitForTimeout(500);
  }
  if (!matchesExpected(text)) {
    throw new Error(
      `Timed out waiting for assistant reply${
        expected ? ` matching ${expected.toString()}` : ""
      }. Last text: ${text.slice(0, 240)}`
    );
  }

  const typingIndicator = page.getByTestId("assistant-typing-indicator");
  await typingIndicator.waitFor({ state: "detached", timeout: timeoutMs }).catch(() => {});
  await page.getByRole("button", { name: "Stop run" }).waitFor({ state: "detached", timeout: timeoutMs }).catch(() => {});

  return text;
}

test.describe("Embedded git repo (git-inside-git) sync", () => {
  test.skip(
    (process.env.GIT_CANONICAL ?? "").trim() !== "1",
    "Requires git-canonical stack (start with GIT_CANONICAL=1)."
  );

  test.describe.configure({ timeout: 360_000 });
  let activeProjectId: string | null = null;
  let seededCredentialId: string | null = null;
  let seededCredentialCreated = false;

  test.beforeEach(async ({ page }) => {
    page.setDefaultTimeout(60_000);
    const projectId = await prepareStudio(page, { waitForHostedRuntime: false });
    activeProjectId = projectId;
    seededCredentialId = null;
    seededCredentialCreated = false;
    await clearRuntimePreference(page, { projectId, source: "agent-embedded-git-repo" });
    await setAssistantAutoSync(page, false);
  });

  test.afterEach(async ({ page }) => {
    try {
      if (seededCredentialCreated && seededCredentialId) {
        await purgeRealUserCredential(page, seededCredentialId);
      }
    } finally {
      await resetRuntimeUserState(page, { source: "agent-embedded-git-repo:cleanup" }).catch(() => {});
    }
  });

  test("sync commits embedded repo working tree (not a gitlink)", async ({ page }) => {
    if (!activeProjectId) {
      throw new Error("Active project id missing in embedded git repo test.");
    }

    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const repoDir = `playwright/embedded-repo-${unique}`;
    const filePath = `${repoDir}/README.md`;
    const firstText = `hello embedded ${unique}`;
    const secondText = `hello embedded updated ${unique}`;

    await syncGitRemote(page, { projectId: activeProjectId, message: `playwright: ensure clean ${unique}` });
    await writeWorkspaceFile(page, filePath, `${firstText}\n`, { projectId: activeProjectId });
    initEmbeddedGitRepo(activeProjectId, repoDir);

    await syncGitRemote(page, {
      projectId: activeProjectId,
      message: `playwright: sync embedded ${unique}`,
    });

    await assertGitRemoteFileText(page, filePath, {
      projectId: activeProjectId,
      expectedText: firstText,
      requireGitRemote: true,
      timeoutMs: 180_000,
    });

    await writeWorkspaceFile(page, filePath, `${secondText}\n`, { projectId: activeProjectId });

    await syncGitRemote(page, {
      projectId: activeProjectId,
      message: `playwright: resync embedded ${unique}`,
    });

    await assertGitRemoteFileText(page, filePath, {
      projectId: activeProjectId,
      expectedText: secondText,
      requireGitRemote: true,
      timeoutMs: 120_000,
    });

    await assertGitRemotePathIsNotGitlink(page, repoDir, {
      projectId: activeProjectId,
      requireGitRemote: true,
      timeoutMs: 120_000,
    });
  });

  test("protected checkpoint commits and pushes embedded repo changes through the canonical repo", async ({
    page
  }) => {
    test.skip(
      (process.env.PLAYWRIGHT_SKIP_CODEX ?? "").trim() === "1",
      "Codex backend unavailable (rate limited). Provide Codex auth (OPENAI_API_KEY or tmp/proxy-codex/auth.json)."
    );
    if (!activeProjectId) {
      throw new Error("Active project id missing in embedded git repo test.");
    }

    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const repoDir = `playwright/embedded-agent-${unique}`;
    const filePath = `${repoDir}/notes.md`;
    const expectedText = `outer canonical sync ${unique}`;
    const seedText = `seed before agent ${unique}`;

    await syncGitRemote(page, {
      projectId: activeProjectId,
      message: `playwright: ensure clean embedded-agent ${unique}`,
    });
    await writeWorkspaceFile(page, filePath, `${seedText}\n`, { projectId: activeProjectId });
    initEmbeddedGitRepo(activeProjectId, repoDir);
    await setAssistantAutoSync(page, true);
    const seededCredential = await ensureRealDefaultCodexCredential(page);
    seededCredentialId = seededCredential.credentialId;
    seededCredentialCreated = seededCredential.created;
    await expect(page.getByTestId("credentials-status-indicator")).toHaveCount(0, {
      timeout: 30_000,
    });
    const hostedRuntime = await ensureHostedRuntimeReady(page, activeProjectId);
    await selectHostedRuntimeForChat(page, hostedRuntime);

    const reply = await sendChatAndWait(
      page,
      [
        `An embedded git repository already exists at \`${repoDir}\`.`,
        `Create or overwrite \`${filePath}\` with EXACTLY this single line and nothing else:`,
        expectedText,
        "",
        `Write the file in the outer workspace path \`${filePath}\`.`,
        "",
        "Important constraints:",
        `- \`${repoDir}\` is only a nested local repo boundary for files inside the workspace.`,
        "- Do NOT create a gitlink or submodule entry in the outer canonical repo.",
        "- Do NOT run git commands, commit, or push; the protected runtime checkpoint owns canonical sync.",
        "",
        "When finished writing the exact file contents, reply with a short confirmation.",
      ].join("\n"),
      { timeoutMs: 240_000 }
    );
    expect(reply.length).toBeGreaterThan(0);

    await expect
      .poll(
        async () =>
          (await readWorkspaceFileText(page, filePath, { projectId: activeProjectId }))?.trim(),
        { timeout: 180_000 }
      )
      .toBe(expectedText);

    await assertGitRemoteFileText(page, filePath, {
      projectId: activeProjectId,
      expectedText,
      requireGitRemote: true,
      timeoutMs: 240_000,
    });

    await assertGitRemotePathIsNotGitlink(page, repoDir, {
      projectId: activeProjectId,
      requireGitRemote: true,
      timeoutMs: 240_000,
    });
  });
});
