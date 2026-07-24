import { test, expect, chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ensureRealDefaultCodexCredentialWhenRequired,
  expectAssistantReplyOrSkipRateLimit,
  prepareStudio,
} from "../utils/harness";
import {
  attachSpeechToolCapture,
  buildStableSpeechBrowserEnv,
  closeManagedBrowser,
  createStableSpeechTempDir,
  configureHostedVoiceCaptureTest,
  ensureSpeechServices,
  stopManagedServices,
  synthesizeFakeMicAudio,
  type SpeechToolCall,
  warmSpeechTranscription,
} from "../utils/speechHarness";

const PROMPT_TEXT = "@octo Stop all motion.";

function logStep(message: string) {
  console.log(`[chat-voice-speech-smoke] ${message}`);
}

async function readChatVoiceDebug(page: import("@playwright/test").Page) {
  return await page.evaluate(() => {
    const runtimeWindow = window as typeof window & {
      __CHAT_VOICE_DEBUG__?: Record<string, unknown>;
      __CHAT_VOICE_DEBUG_HISTORY__?: Array<Record<string, unknown>>;
      __CHAT_VOICE_DEBUG_EVENTS__?: Array<Record<string, unknown>>;
    };
    return {
      latest: runtimeWindow.__CHAT_VOICE_DEBUG__ ?? null,
      history: runtimeWindow.__CHAT_VOICE_DEBUG_HISTORY__ ?? [],
      events: runtimeWindow.__CHAT_VOICE_DEBUG_EVENTS__ ?? [],
    };
  });
}

async function resolveActiveProjectId(page: import("@playwright/test").Page) {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const runtimeWindow = window as typeof window & {
            __INSTAFY_STORE__?: {
              getState?: () => { activeProjectId?: string | null };
            };
          };
          const state = runtimeWindow.__INSTAFY_STORE__?.getState?.();
          const activeProjectId = typeof state?.activeProjectId === "string"
            ? state.activeProjectId.trim()
            : "";
          return activeProjectId || null;
        }),
      {
        timeout: 30_000,
      },
    )
    .not.toBeNull();

  const projectId = await page.evaluate(() => {
    const runtimeWindow = window as typeof window & {
      __INSTAFY_STORE__?: {
        getState?: () => { activeProjectId?: string | null };
      };
    };
    const state = runtimeWindow.__INSTAFY_STORE__?.getState?.();
    return typeof state?.activeProjectId === "string" ? state.activeProjectId.trim() : null;
  });
  if (!projectId) {
    throw new Error("Studio did not expose an active project id.");
  }
  return projectId;
}

test.describe("Chat voice speech smoke", () => {
    test("routes chat voice through hosted speech capture in hold mode", async ({}, testInfo) => {
    test.setTimeout(240_000);

    const repoRoot = path.resolve(testInfo.config.rootDir, "..", "..");
    let managedServices;
    try {
      managedServices = await ensureSpeechServices(repoRoot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("insanely-fast-whisper")) {
        test.skip(true, `Missing local speech dependency: ${message}`);
      }
      throw error;
    }
    const tempDir = await createStableSpeechTempDir({
      repoRoot,
      prefix: "chat-voice-speech-smoke",
    });
    const failureScreenshotPath = testInfo.outputPath("chat-voice-speech-failure.png");
    const speechToolCalls: SpeechToolCall[] = [];

    let browser: import("@playwright/test").Browser | null = null;

    try {
      const { audioDataUrl: promptAudioDataUrl, wavPath } = await synthesizeFakeMicAudio({
        outputDir: tempDir,
        promptText: PROMPT_TEXT,
        filePrefix: "chat-voice-prompt",
      });
      const warmup = await warmSpeechTranscription({
        audioDataUrl: promptAudioDataUrl,
        fileName: "chat-voice-prompt.aiff",
      });
      logStep(`Warmed speech transcription in ${warmup.durationMs}ms: ${warmup.text ?? "<empty>"}`);
      const expectedTranscript = PROMPT_TEXT;
      const baseUrl = (testInfo.project.use.baseURL as string | undefined)?.replace(/\/$/, "") ??
        "http://127.0.0.1:5199";

      browser = await chromium.launch({
        headless: true,
        env: await buildStableSpeechBrowserEnv(repoRoot),
        args: [
          `--use-file-for-fake-audio-capture=${wavPath}`,
          "--use-fake-device-for-media-stream",
          "--use-fake-ui-for-media-stream",
          "--autoplay-policy=no-user-gesture-required",
        ],
      });

      const context = await browser.newContext({
        permissions: ["microphone"],
      });
      await context.addInitScript(() => {
        const runtimeWindow = window as typeof window & {
          SpeechRecognition?: unknown;
          webkitSpeechRecognition?: unknown;
        };
        try {
          delete runtimeWindow.SpeechRecognition;
        } catch {
          runtimeWindow.SpeechRecognition = undefined;
        }
        try {
          delete runtimeWindow.webkitSpeechRecognition;
        } catch {
          runtimeWindow.webkitSpeechRecognition = undefined;
        }
      });

      const page = await context.newPage();
      attachSpeechToolCapture(page, speechToolCalls);

      logStep("Preparing Studio guest session");
      await prepareStudio(page);
      // Guest sessions have no AI access in the BYOC stack; onboard the
      // canonical local Codex login so the voice turn can reach the assistant.
      await ensureRealDefaultCodexCredentialWhenRequired(page);
      const projectId = await resolveActiveProjectId(page);
      logStep(`Using project ${projectId}`);

      await page.goto(`${baseUrl}/studio?projectId=${encodeURIComponent(projectId)}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });
      const voiceButton = page.getByTestId("chat-voice-input-button");
      await expect(voiceButton).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("chat-voice-replies-toggle")).toHaveCount(0);
      await configureHostedVoiceCaptureTest(page, {
        audioDataUrl: promptAudioDataUrl,
        fileName: "chat-voice-prompt.aiff",
        readyDelayMs: 120,
        finalDelayMs: 150,
        transcriptText: PROMPT_TEXT,
      });
      await expect
        .poll(async () => await voiceButton.getAttribute("data-voice-route"), {
          timeout: 10_000,
        })
        .toBe("provider");
      await expect
        .poll(async () => await voiceButton.getAttribute("data-voice-capture"), {
          timeout: 10_000,
        })
        .toBe("hosted");
      await expect
        .poll(async () => await voiceButton.getAttribute("data-voice-backend"), {
          timeout: 10_000,
        })
        .not.toBe("");

      const synthStart = speechToolCalls.length;
      logStep("Holding chat voice button");
      await voiceButton.dispatchEvent("pointerdown", {
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
        buttons: 1,
      });
      await expect
        .poll(async () => await voiceButton.getAttribute("data-voice-state"), {
          timeout: 7_500,
        })
        .toMatch(/starting|listening/);
      await page.waitForTimeout(2_800);
      await voiceButton.dispatchEvent("pointerup", {
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
        buttons: 0,
      });

      const lastUserBubble = page.locator('[data-testid="chat-bubble-user"]').last();
      try {
        await expect(lastUserBubble).toContainText(expectedTranscript, {
          timeout: 35_000,
        });
        const lastUserBubbleText = (await lastUserBubble.innerText()).trim();
        logStep(`Observed hosted chat voice turn submit: ${lastUserBubbleText}`);
        logStep("Hosted chat voice UI path completed");
      } catch {
        const debugState = await readChatVoiceDebug(page);
        const currentState = {
          route: await voiceButton.getAttribute("data-voice-route"),
          capture: await voiceButton.getAttribute("data-voice-capture"),
          state: await voiceButton.getAttribute("data-voice-state"),
          backend: await voiceButton.getAttribute("data-voice-backend"),
          error: await voiceButton.getAttribute("data-voice-error"),
          chatInput: await page.getByTestId("chat-input").textContent(),
          debug: debugState,
        };
        logStep(
          `Chat mic capture did not yield an auto-submitted voice turn in time. ${JSON.stringify(currentState)}`,
        );
        throw new Error("Hosted chat voice turn did not auto-submit.");
      }

      await expectAssistantReplyOrSkipRateLimit(page, /[\s\S]+/, { timeout: 120_000 });
      await expect
        .poll(
          () =>
            [...speechToolCalls]
              .slice(synthStart)
              .some(
                (entry) =>
                  entry.kind === "response" &&
                  entry.name === "instafy.speech.synthesize_speech" &&
                  typeof entry.response?.value === "object",
              ),
          {
            timeout: 5_000,
          },
        )
        .toBe(false);
    } catch (error) {
      if (browser) {
        const page = browser.contexts()[0]?.pages()[0];
        if (page) {
          await page.screenshot({
            path: failureScreenshotPath,
            fullPage: true,
          }).catch(() => {});
        }
      }
      throw error;
    } finally {
      await closeManagedBrowser(browser, {
        label: "chat-voice-speech-smoke",
      });
      await fs.rm(tempDir, {
        recursive: true,
        force: true,
      });
      await stopManagedServices(managedServices);
    }
    });
});
