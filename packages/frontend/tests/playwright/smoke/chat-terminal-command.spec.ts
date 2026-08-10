import { test, expect, type Page } from "@playwright/test";
import {
  clearRuntimePreference,
  expectAssistantReplyOrSkipRateLimit,
  getControllerUrl,
  prepareStudio,
  readWorkspaceFileText,
  requestHostedRuntime,
  resetRuntimeUserState,
  waitForHostedRuntimeReady,
} from "../utils/harness.js";
import { clickQueuedSendNowIfAvailable } from "../utils/chatUi.js";
import { disableAssistantIfPossible, enableAssistant } from "../utils/runtimeAi.js";

async function ensureHostedRuntimeReady(projectId: string, page: Page) {
  const ready = await waitForHostedRuntimeReady(page, 10_000).then(() => true).catch(() => false);
  if (!ready) {
    await requestHostedRuntime(page, {
      projectId,
      source: "chat",
      existingRuntimeStrategy: "launch-new",
      timeoutMs: 180_000,
    }).catch(() => {});
  }
  await waitForHostedRuntimeReady(page, 180_000, { projectId });
}

async function sendAssistantPrompt(
  page: Page,
  prompt: string,
  options?: { timeoutMs?: number; userEcho?: string; expectedAssistantPattern?: RegExp },
): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? 300_000;
  const assistantBubbles = page.locator('[data-testid="chat-bubble-assistant"]');
  const baselineAssistantCount = await assistantBubbles.count();
  const userBubbles = page.getByTestId("chat-bubble-user");
  const baselineUserCount = await userBubbles.count();
  const sendQueue = page.getByTestId("chat-send-queue");

  await page.getByTestId("chat-input").fill(prompt);
  await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId("chat-send-button").click();
  const expectedEcho = options?.userEcho ?? prompt.slice(0, 40);

  const submitDeadline = Date.now() + Math.min(timeoutMs, 30_000);
  while (Date.now() < submitDeadline) {
    const userCount = await userBubbles.count().catch(() => baselineUserCount);
    if (userCount > baselineUserCount) {
      const newest = (await userBubbles.last().innerText().catch(() => "")).trim();
      if (!expectedEcho || newest.includes(expectedEcho)) {
        break;
      }
    }

    const latestUserText = (await userBubbles.last().innerText().catch(() => "")).trim();
    if (!expectedEcho || latestUserText.includes(expectedEcho)) {
      break;
    }

    const queued = await sendQueue.isVisible().catch(() => false);
    if (queued) {
      await clickQueuedSendNowIfAvailable(page);
    }

    const assistantCount = await assistantBubbles.count().catch(() => baselineAssistantCount);
    if (assistantCount > baselineAssistantCount) {
      break;
    }

    if (options?.expectedAssistantPattern) {
      const latestAssistantText = (await assistantBubbles.last().innerText().catch(() => "")).trim();
      if (options.expectedAssistantPattern.test(latestAssistantText)) {
        break;
      }
    }
    await page.waitForTimeout(250);
  }

  await expectAssistantReplyOrSkipRateLimit(page, /[\s\S]+/, { timeout: timeoutMs });
  const typingIndicator = page.getByTestId("assistant-typing-indicator");
  await typingIndicator.waitFor({ state: "detached", timeout: timeoutMs }).catch(() => {});

  if (options?.expectedAssistantPattern) {
    await expect
      .poll(async () => (await assistantBubbles.last().innerText().catch(() => "")).trim(), {
        timeout: timeoutMs,
      })
      .toMatch(options.expectedAssistantPattern);
  }

  return (await assistantBubbles.last().innerText().catch(() => "")).trim();
}

function extractFirstIsoTimestamp(value: string): string | null {
  const matches = value.match(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)/g
  );
  if (!matches || matches.length === 0) {
    return null;
  }
  return matches[0] ?? null;
}

function extractLastIsoTimestamp(value: string): string | null {
  const matches = value.match(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)/g
  );
  if (!matches || matches.length === 0) {
    return null;
  }
  return matches[matches.length - 1] ?? null;
}

async function runTerminalCommand(
  page: Page,
  command: string,
  options?: { timeoutMs?: number },
): Promise<string> {
  const prompt = `/terminal ${command}`;
  // Hosted runtime handoff can take noticeably longer under full-suite load,
  // especially for the first terminal dispatch after a runtime is (re)ensured.
  const timeoutMs = options?.timeoutMs ?? 180_000;
  const outputBlocks = page.getByTestId("chat-command-output");
  const baselineOutputBlocks = await outputBlocks.count();
  const baselineOutputTexts = new Set(
    (await outputBlocks.allInnerTexts().catch(() => []))
      .map((text) => text.trim())
      .filter((text) => text.length > 0),
  );
  const userBubbles = page.getByTestId("chat-bubble-user");
  const baselineUserCount = await userBubbles.count();
  const assistantBubbles = page.locator('[data-testid="chat-bubble-assistant"]');
  const baselineAssistantCount = await assistantBubbles.count();
  const baselineAssistantText =
    baselineAssistantCount > 0 ? (await assistantBubbles.last().innerText().catch(() => "")).trim() : "";
  const sendQueue = page.getByTestId("chat-send-queue");

  await page.getByTestId("chat-input").fill(prompt);
  await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId("chat-send-button").click();
  await expect
    .poll(
      async () => {
        const queued = await sendQueue.isVisible().catch(() => false);
        if (queued) {
          await clickQueuedSendNowIfAvailable(page);
        }

        const userTexts = (await userBubbles.allInnerTexts().catch(() => []))
          .map((text) => text.trim())
          .filter((text) => text.length > 0);
        if (userTexts.some((text) => text.includes(prompt))) {
          return prompt;
        }

        const userCount = await userBubbles.count().catch(() => baselineUserCount);
        if (userCount > baselineUserCount) {
          const latestUserText = userTexts[userTexts.length - 1] ?? "";
          if (latestUserText) {
            return latestUserText;
          }
        }

        const outputTexts = (await outputBlocks.allInnerTexts().catch(() => []))
          .map((text) => text.trim())
          .filter((text) => text.length > 0);
        if (outputTexts.some((text) => !baselineOutputTexts.has(text))) {
          return prompt;
        }
        return "";
      },
      // Hosted runtime re-ensure can delay message echo under full-suite load, so
      // respect the caller's timeout instead of imposing a shorter local ceiling.
      { timeout: timeoutMs },
    )
    .toContain(prompt);

  let commandOutput = "";
  await expect
    .poll(
      async () => {
        const outputTexts = (await outputBlocks.allInnerTexts().catch(() => []))
          .map((text) => text.trim())
          .filter((text) => text.length > 0);
        const newestOutput = [...outputTexts].reverse().find((text) => !baselineOutputTexts.has(text)) ?? "";
        if (!newestOutput) {
          const outputCount = await outputBlocks.count();
          if (outputCount > baselineOutputBlocks && outputTexts.length > 0) {
            commandOutput = outputTexts[outputTexts.length - 1] ?? "";
            return commandOutput;
          }
          // Keep this compatibility path: in some runs the runtime/controller still surfaces
          // terminal completion only via assistant thread text instead of a structured
          // `chat-command-output` block.
          const assistantCount = await assistantBubbles.count();
          if (assistantCount <= 0) {
            return "";
          }
          const assistantText = (await assistantBubbles.last().innerText().catch(() => "")).trim();
          if (!assistantText || assistantText === baselineAssistantText) {
            return "";
          }
          if (assistantText.toLowerCase().includes("command completed in terminal session")) {
            commandOutput = assistantText;
            return assistantText;
          }
          return "";
        }
        commandOutput = newestOutput;
        return commandOutput;
      },
      { timeout: timeoutMs },
    )
    .not.toBe("");

  return commandOutput;
}

function resolveControllerAuthTokenForTests(): string {
  return (
    process.env.CONTROLLER_INTERNAL_TOKEN ||
    process.env.PLAYWRIGHT_CONTROLLER_INTERNAL_TOKEN ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SERVICE_ROLE_KEY ||
    ""
  );
}

function resolveServiceRoleKeyForTests(): string {
  return (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SERVICE_ROLE_KEY ||
    ""
  );
}

async function fetchHostedRuntimeIdleTtlSeconds(page: Page, projectId: string): Promise<number | null> {
  const controllerUrl = getControllerUrl();
  if (!controllerUrl) {
    return null;
  }

  const token = resolveControllerAuthTokenForTests();
  const requestUrl = `${controllerUrl}/projects/${encodeURIComponent(projectId)}/runtime/status`;

  const readTtl = (payload: unknown): number | null => {
    const runtimes =
      payload && typeof payload === "object" && Array.isArray((payload as any).runtimes)
        ? ((payload as any).runtimes as Array<Record<string, unknown>>)
        : [];
    const hosted = runtimes.find((entry) => {
      const provider = typeof entry.provider === "string" ? entry.provider.toLowerCase() : "";
      const isLocal = typeof entry.isLocal === "boolean" ? entry.isLocal : null;
      return provider.includes("instafy-cloud") || isLocal === false;
    });
    const ttl =
      hosted && typeof hosted.idleTtlSeconds === "number"
        ? hosted.idleTtlSeconds
        : hosted && typeof (hosted as any).idle_ttl_seconds === "number"
          ? (hosted as any).idle_ttl_seconds
          : null;
    return ttl;
  };

  if (token) {
    const response = await page.context().request.get(requestUrl, {
      headers: { authorization: `Bearer ${token}` }
    });
    if (response.ok()) {
      const payload = (await response.json().catch(() => null)) as unknown;
      const ttl = readTtl(payload);
      if (typeof ttl === "number") {
        return ttl;
      }
    }
  }

  // Fall back to the session access token stored in the browser.
  return await page
    .evaluate(async ({ controllerUrl, projectId }) => {
      const keys = Object.keys(localStorage).filter((key) => key.startsWith("sb-") && key.endsWith("-auth-token"));
      let accessToken = "";
      for (const key of keys) {
        try {
          const value = JSON.parse(localStorage.getItem(key) || "null");
          if (typeof value?.access_token === "string" && value.access_token.length > 0) {
            accessToken = value.access_token;
            break;
          }
        } catch {}
      }
      if (!accessToken) {
        return null;
      }
      const url = new URL(`${controllerUrl}/projects/${encodeURIComponent(projectId)}/runtime/status`);
      const response = await fetch(url.toString(), {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        return null;
      }
      const payload = await response.json().catch(() => null);
      const runtimes = Array.isArray(payload?.runtimes) ? payload.runtimes : [];
      const hosted = runtimes.find((entry: any) => {
        const provider = typeof entry?.provider === "string" ? entry.provider.toLowerCase() : "";
        const isLocal = typeof entry?.isLocal === "boolean" ? entry.isLocal : null;
        return provider.includes("instafy-cloud") || isLocal === false;
      });
      const ttl = typeof hosted?.idleTtlSeconds === "number" ? hosted.idleTtlSeconds : null;
      return ttl;
    }, { controllerUrl, projectId })
    .catch(() => null);
}

async function fetchHostedRuntimeStatusSnapshot(
  page: Page,
  projectId: string,
): Promise<{ runtimeId: string; status: string | null; idleTtlSeconds: number | null } | null> {
  const controllerUrl = getControllerUrl();
  const token = resolveControllerAuthTokenForTests();
  if (!controllerUrl || !token) {
    return null;
  }

  try {
    const response = await page.context().request.get(
      `${controllerUrl}/projects/${encodeURIComponent(projectId)}/runtime/status`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
      },
    );
    if (!response.ok()) {
      return null;
    }
    const payload = (await response.json().catch(() => null)) as {
      runtimes?: Array<Record<string, unknown>>;
    } | null;
    const runtimes = Array.isArray(payload?.runtimes) ? payload.runtimes : [];
    const hosted = runtimes.find((entry) => {
      const provider = typeof entry.provider === "string" ? entry.provider.toLowerCase() : "";
      const isLocal = typeof entry.isLocal === "boolean" ? entry.isLocal : null;
      return provider.includes("instafy-cloud") || isLocal === false;
    });

    const runtimeId =
      hosted && typeof hosted.runtimeId === "string"
        ? hosted.runtimeId
        : hosted && typeof (hosted as any).runtime_id === "string"
          ? (hosted as any).runtime_id
          : null;

    if (!runtimeId) {
      return null;
    }

    const status =
      hosted && typeof hosted.status === "string"
        ? hosted.status
        : hosted && typeof (hosted as any).status_text === "string"
          ? (hosted as any).status_text
          : null;

    const idleTtlSeconds =
      hosted && typeof hosted.idleTtlSeconds === "number"
        ? hosted.idleTtlSeconds
        : hosted && typeof (hosted as any).idle_ttl_seconds === "number"
          ? (hosted as any).idle_ttl_seconds
          : null;

    return { runtimeId, status, idleTtlSeconds };
  } catch {
    return null;
  }
}

async function fetchControllerRunsForProject(
  page: Page,
  projectId: string,
): Promise<Array<Record<string, unknown>> | null> {
  const controllerUrl = getControllerUrl();
  const token = resolveControllerAuthTokenForTests();
  if (!controllerUrl || !token) {
    return null;
  }

  const response = await page.context().request.get(
    `${controllerUrl}/runs?projectId=${encodeURIComponent(projectId)}&limit=25`,
    {
      headers: { authorization: `Bearer ${token}` },
    },
  );
  if (!response.ok()) {
    return null;
  }
  const payload = (await response.json().catch(() => null)) as unknown;
  return Array.isArray(payload) ? (payload as Array<Record<string, unknown>>) : null;
}

test.describe("Chat terminal command", () => {
  test.setTimeout(360_000);

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "chat-terminal-command:cleanup" }).catch(() => {});
  });

  test("dispatch keeps hosted runtime idle TTL at 300s (does not downgrade to 30s)", async ({ page }) => {
    const projectId = await prepareStudio(page);
    await clearRuntimePreference(page, { projectId, source: "chat-terminal-command:idle-ttl" });
    await ensureHostedRuntimeReady(projectId, page);
    await disableAssistantIfPossible(page);

    await expect
      .poll(async () => await fetchHostedRuntimeIdleTtlSeconds(page, projectId), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(300);

    // Any dispatched message used to reset the runtime record's TTL to the controller dev default (30s),
    // which could trigger a quick heartbeat_timeout stop and "tunnel revoked" between chat turns.
    await runTerminalCommand(page, "echo ttl");

    await expect
      .poll(async () => await fetchHostedRuntimeIdleTtlSeconds(page, projectId), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(300);
  });

  // Temporarily disabled: under full-suite load this specific post-recovery /terminal round-trip
  // still flakes on the first attempt after a hosted runtime is re-ensured, even though the retry
  // consistently passes. Re-enable once the runtime re-attach path exposes a deterministic ready
  // signal for terminal dispatches.
  test.fixme("resumes terminal commands after hosted runtime is re-ensured between chat turns", async ({
    page,
  }) => {
    test.setTimeout(600_000);
    const controllerUrl = getControllerUrl();
    const serviceRoleKey = resolveServiceRoleKeyForTests();
    if (!controllerUrl || !serviceRoleKey) {
      test.skip(true, "Controller URL and service-role token are required to stop the hosted runtime.");
    }

    const projectId = await prepareStudio(page);
    await clearRuntimePreference(page, { projectId, source: "chat-terminal-command:ttl-recovery" });
    const hostedReady = await waitForHostedRuntimeReady(page, 120_000, { projectId });
    await disableAssistantIfPossible(page);

    const firstOutput = await runTerminalCommand(page, "printf READY");
    expect(firstOutput).toContain("READY");

    const stopResponse = await page.context().request.post(`${controllerUrl}/runtime/stop`, {
      headers: {
        authorization: `Bearer ${serviceRoleKey}`,
        "content-type": "application/json",
      },
      data: {
        runtime_id: hostedReady.runtimeId,
        reason: "playwright:chat-terminal-command-recovery",
      },
    });
    expect(stopResponse.ok()).toBeTruthy();

    await expect
      .poll(
        async () => {
          const status = (await fetchHostedRuntimeStatusSnapshot(page, projectId))?.status ?? "";
          return status.toLowerCase();
        },
        { timeout: 60_000 },
      )
      .toMatch(/stopped|offline/);

    // After explicitly stopping the hosted runtime, make the re-ensure
    // deterministic instead of relying on background recovery timing.
    await requestHostedRuntime(page, {
      projectId,
      source: "chat",
      existingRuntimeStrategy: "launch-new",
      timeoutMs: 180_000,
    }).catch(() => {});
    await waitForHostedRuntimeReady(page, 180_000, { projectId });

    const secondOutput = await runTerminalCommand(page, "printf RECOVERED", {
      // Under full-suite load the first /terminal turn after a hosted-runtime re-ensure
      // can take materially longer than a normal command round-trip.
      timeoutMs: 300_000,
    });
    expect(secondOutput).toContain("RECOVERED");
  });

  test("runs /terminal pwd and shows command output in chat", async ({ page }) => {
    const projectId = await prepareStudio(page);
    await clearRuntimePreference(page, { projectId, source: "chat-terminal-command" });
    await ensureHostedRuntimeReady(projectId, page);
    await disableAssistantIfPossible(page);

    const output = await runTerminalCommand(page, "pwd");
    expect(output).toMatch(/(\/|[A-Za-z]:\\)/);
  });

  test("can stop a long-running /terminal command from output controls", async ({ page }) => {
    const projectId = await prepareStudio(page);
    await clearRuntimePreference(page, { projectId, source: "chat-terminal-command:cancel" });
    await ensureHostedRuntimeReady(projectId, page);
    await disableAssistantIfPossible(page);

    const command = 'bash -lc "while true; do date -u +%FT%TZ; sleep 1; done"';
    const prompt = `/terminal ${command}`;

    await page.getByTestId("chat-input").fill(prompt);
    await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 180_000 });
    await page.getByTestId("chat-send-button").click();
    await expect(page.getByTestId("chat-bubble-user").last()).toContainText("/terminal bash -lc");

    const commandRow = page
      .getByTestId("chat-message-row")
      .filter({ has: page.getByTestId("chat-command-stop-button") })
      .last();
    const stopButton = commandRow.getByTestId("chat-command-stop-button");
    const threadPreview = commandRow.getByTestId("agent-job-thread-preview");
    const inlineSpeaker = commandRow.locator('[data-testid="chat-speaker-inline"]:visible');
    await expect(commandRow).toBeVisible({ timeout: 180_000 });
    await expect(stopButton).toBeVisible({ timeout: 180_000 });
    await expect(threadPreview).toBeVisible({ timeout: 180_000 });
    await expect(inlineSpeaker).toBeVisible({ timeout: 180_000 });
    await expect(commandRow.getByTestId("agent-thread-preview-header")).toHaveCount(0);
    await expect(commandRow.getByTestId("agent-job-thread-avatar")).toHaveCount(0);
    const speakerToPreviewGap = async () => {
      const [speakerBox, previewBox] = await Promise.all([
        inlineSpeaker.boundingBox(),
        threadPreview.boundingBox(),
      ]);
      if (!speakerBox || !previewBox) {
        return Number.POSITIVE_INFINITY;
      }
      return previewBox.y - (speakerBox.y + speakerBox.height);
    };
    await expect
      .poll(speakerToPreviewGap, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(0);
    await expect
      .poll(speakerToPreviewGap, { timeout: 30_000 })
      .toBeLessThanOrEqual(8);
    await stopButton.click();

    await expect
      .poll(
        async () => {
          const userBubbleTexts = await page.getByTestId("chat-bubble-user").allInnerTexts();
          return userBubbleTexts.some((text) => /^\s*\/terminal\s+stop\b/i.test(text));
        },
        { timeout: 30_000 },
      )
      .toBeFalsy();

    await expect
      .poll(
        async () => {
          const runs = await fetchControllerRunsForProject(page, projectId);
          if (!runs) {
            return "";
          }
          const canceled = runs.find((run) => {
            const status = typeof run.status === "string" ? run.status.toLowerCase() : "";
            const last =
              typeof (run as any).last_message === "string" ? ((run as any).last_message as string) : "";
            return status === "canceled" && last.toLowerCase().includes("agent job cancelled by user");
          });
          return canceled ? String(canceled.id ?? "") : "";
        },
        { timeout: 180_000 },
      )
      .not.toBe("");
  });

  test("assistant keeps a ticker running while completing another task", async ({ page }) => {
    test.skip(
      (process.env.PLAYWRIGHT_SKIP_CODEX ?? "").trim() === "1",
      "Codex backend unavailable (rate limited). Provide Codex auth (OPENAI_API_KEY or tmp/proxy-codex/auth.json).",
    );
    test.skip(
      (process.env.PLAYWRIGHT_LIVE_TERMINAL_MULTITASK ?? "").trim() !== "1",
      "Live assistant multitask terminal smoke is model-dependent; opt in with PLAYWRIGHT_LIVE_TERMINAL_MULTITASK=1.",
    );

    const projectId = await prepareStudio(page);
    await clearRuntimePreference(page, { projectId, source: "chat-terminal-command:multitask" });
    await ensureHostedRuntimeReady(projectId, page);
    await enableAssistant(page);

    await sendAssistantPrompt(
      page,
      [
        "Create a Python script named `time_ticker.py`.",
        "It should append the current UTC ISO timestamp ending with Z to `time-ticker.log` every second.",
        "Start it so it keeps running in the background (do not keep this chat stuck waiting for it to exit).",
        "Keep it running while handling later requests.",
      ].join("\n"),
      { timeoutMs: 360_000, userEcho: "Create a Python script" },
    );

    await expect
      .poll(
        async () => {
          const text = await readWorkspaceFileText(page, "time-ticker.log", { projectId });
          return extractLastIsoTimestamp(text ?? "") ?? "";
        },
        { timeout: 120_000 },
      )
      .not.toBe("");

    await sendAssistantPrompt(
      page,
      "Now write a 4-line poem about concurrency into `multitask-poem.txt`.",
      { timeoutMs: 240_000, userEcho: "Now write a 4-line poem" },
    );

    await sendAssistantPrompt(
      page,
      "Now tell me the latest timestamps you currently see in `time-ticker.log`.",
      {
        timeoutMs: 240_000,
        userEcho: "Now tell me the latest timestamps",
        expectedAssistantPattern:
          /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)/,
      },
    );

    const scriptText = await readWorkspaceFileText(page, "time_ticker.py", { projectId });
    const poemText = await readWorkspaceFileText(page, "multitask-poem.txt", { projectId });
    expect(typeof scriptText).toBe("string");
    expect(typeof poemText).toBe("string");
    const poemLines = (poemText ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    // Keep this assertion capability-indicative, not format-brittle: models sometimes prepend
    // a one-line header (e.g. "A 4-line poem:") before the actual 4 lines.
    expect(poemLines.length).toBeGreaterThanOrEqual(4);

    let initialObservedLog: string | null = null;
    await expect
      .poll(
        async () => {
          const text = await readWorkspaceFileText(page, "time-ticker.log", { projectId });
          initialObservedLog = typeof text === "string" ? text : null;
          return extractLastIsoTimestamp(initialObservedLog ?? "") ?? "";
        },
        { timeout: 120_000 },
      )
      .not.toBe("");

    const initialObservedTick = extractLastIsoTimestamp(initialObservedLog ?? "");
    expect(initialObservedTick).toBeTruthy();
    const initialObservedTickMs = initialObservedTick ? Date.parse(initialObservedTick) : Number.NaN;
    expect(Number.isFinite(initialObservedTickMs)).toBe(true);

    await page.waitForTimeout(3_500);

    let laterObservedLog: string | null = null;
    await expect
      .poll(
        async () => {
          const text = await readWorkspaceFileText(page, "time-ticker.log", { projectId });
          laterObservedLog = typeof text === "string" ? text : null;
          const first = extractFirstIsoTimestamp(laterObservedLog ?? "");
          const last = extractLastIsoTimestamp(laterObservedLog ?? "");
          if (!first || !last) {
            return false;
          }
          const firstMs = Date.parse(first);
          const lastMs = Date.parse(last);
          if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs)) {
            return false;
          }
          return lastMs > firstMs;
        },
        { timeout: 120_000 },
      )
      .toBe(true);

    const laterObservedTick = extractLastIsoTimestamp(laterObservedLog ?? "");
    expect(laterObservedTick).toBeTruthy();
    const laterObservedTickMs = laterObservedTick ? Date.parse(laterObservedTick) : Number.NaN;
    expect(Number.isFinite(laterObservedTickMs)).toBe(true);
    expect(laterObservedTickMs).toBeGreaterThan(initialObservedTickMs + 2_000);
  });
});
