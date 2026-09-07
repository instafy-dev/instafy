import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { installConversationFixture, loadMessages, navigate, percentile, samples, settledHeap, snapshot, visitConversationScopes, type PerfWindow } from "./conversationPerfFixture";

test("large warm chats switch promptly without replaying loaded history or blanking on failures", async ({ page }, testInfo) => {
  const controller = await installConversationFixture(page);
  await loadMessages(page, 400);
  await navigate(page, "tab", 2);
  await loadMessages(page, 400);
  await navigate(page, "tab", 1, 400);
  const olderReads = controller.reads.filter((read) => read.cursor !== null).length;
  await page.evaluate(() => (window as PerfWindow).__CONVERSATION_PERF__.clearNavigation());

  for (let index = 0; index < 24; index += 1) await navigate(page, "tab", index % 2 === 0 ? 2 : 1, 400);

  const warm = await samples(page);
  expect(warm).toHaveLength(24);
  expect(warm.every((sample) => !sample.loadingShown)).toBe(true);
  expect(controller.reads.filter((read) => read.cursor !== null)).toHaveLength(olderReads);
  // Repeated samples, a generous p95 gate and a separate gross-stall gate:
  // this detects the old seconds-long remount regression without depending on
  // one scheduling outlier or requiring a particular developer workstation.
  expect(percentile(warm.map((sample) => sample.elapsedMs), 0.95)).toBeLessThan(1_000);
  expect(Math.max(...warm.map((sample) => sample.elapsedMs))).toBeLessThan(2_000);

  controller.mode = "slow";
  await page.getByTestId("refresh").click();
  await navigate(page, "tab", 2, 400);
  await navigate(page, "tab", 1, 400);
  await expect(page.getByTestId("loading")).toHaveCount(0);
  controller.mode = "failed";
  await page.getByTestId("refresh").click();
  await navigate(page, "tab", 2, 400);
  await expect.poll(() => controller.failedResponses).toBeGreaterThan(0);
  await expect(page.getByTestId("chat-message-row")).toHaveCount(400);
  await expect(page.getByTestId("loading")).toHaveCount(0);

  const report = testInfo.outputPath("warm-switch-measurements.json");
  await writeFile(report, JSON.stringify({ warm, cache: await snapshot(page), requests: controller.reads.length }, null, 2));
  await testInfo.attach("warm-switch-measurements.json", { path: report, contentType: "application/json" });
  expect(controller.unexpected).toEqual([]);
  expect(controller.errors).toEqual([]);
});

test("cold stalled reads cancel when switching away and recover through explicit Retry", async ({ page }) => {
  const controller = await installConversationFixture(page);
  controller.mode = "stalled";
  await page.getByTestId("tab-2").click();
  await expect(page.getByTestId("loading")).toBeVisible();
  const failures: string[] = [];
  page.on("requestfailed", (request) => { if (request.url().includes("/messages?")) failures.push(request.failure()?.errorText ?? "failed"); });
  await navigate(page, "tab", 1);
  await expect.poll(() => failures.length).toBeGreaterThan(0);
  await expect(page.getByTestId("loading")).toHaveCount(0);

  controller.mode = "failed";
  await page.getByTestId("tab-3").click();
  await expect(page.getByTestId("error")).toBeVisible();
  controller.mode = "ready";
  await page.getByTestId("retry").click();
  await expect(page.getByTestId("scope")).toHaveAttribute("data-count", "50");
  await expect(page.getByTestId("error")).toHaveCount(0);
  expect(controller.unexpected).toEqual([]);
  expect(controller.errors).toEqual([]);
});

test("long-session navigation settles within cache, page and heap growth budgets", async ({ page }, testInfo) => {
  await page.clock.install();
  const controller = await installConversationFixture(page);
  await loadMessages(page, 1_100);
  await navigate(page, "tab", 2);
  await expect.poll(async () => (await snapshot(page)).maxInactivePages).toBe(20);

  // Small payloads reach the count cap before the byte cap, proving these are
  // independently enforced rather than passing the count check by coincidence.
  await visitConversationScopes(page);
  await expect.poll(async () => (await snapshot(page)).inactiveConversations).toBe(10);
  const countCap = await snapshot(page);
  expect(countCap.inactivePayloadBytes).toBeLessThan(8 * 1_024 * 1_024);

  const checkpoints = [];
  controller.payloadChars = 4_000;
  for (let round = 0; round < 3; round += 1) {
    await visitConversationScopes(page);
    await expect.poll(async () => (await snapshot(page)).inactiveConversations).toBeLessThanOrEqual(10);
    await expect.poll(async () => (await snapshot(page)).inactivePayloadBytes).toBeLessThanOrEqual(8 * 1_024 * 1_024);
    checkpoints.push({ cache: await snapshot(page), heap: await settledHeap(page) });
  }
  expect(checkpoints.every(({ cache }) => cache.inactiveConversations > 0 && cache.maxInactivePages <= 20)).toBe(true);
  const first = checkpoints[0]!.heap.usedHeapBytes;
  const last = checkpoints[2]!.heap.usedHeapBytes;
  // This is actual post-GC V8 heap growth, separately measured from the cache's
  // estimated serialized UTF-16 payload. It is not a total renderer-process cap.
  expect(last - first).toBeLessThan(32 * 1_024 * 1_024);
  expect(last).toBeLessThan(256 * 1_024 * 1_024);

  await page.getByTestId("release").click();
  await expect(page.getByTestId("chat-message-row")).toHaveCount(0);
  await expect.poll(async () => (await snapshot(page)).activeConversations).toBe(0);
  // Advance the browser clock only after the timing measurements and after
  // releasing observers. This exercises the actual 30-minute query GC policy.
  await page.clock.fastForward(31 * 60 * 1_000);
  await expect.poll(async () => (await snapshot(page)).inactiveConversations).toBe(0);

  const report = testInfo.outputPath("navigation-soak-memory.json");
  await writeFile(report, JSON.stringify({ countCap, checkpoints, final: await snapshot(page), navigation: await samples(page) }, null, 2));
  await testInfo.attach("navigation-soak-memory.json", { path: report, contentType: "application/json" });
  expect(controller.unexpected).toEqual([]);
  expect(controller.errors).toEqual([]);
});
