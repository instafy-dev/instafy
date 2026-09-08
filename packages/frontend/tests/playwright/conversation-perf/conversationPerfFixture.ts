import { expect, type Page } from "@playwright/test";

export const conversationId = (org = 1, space = 1, chat = 1) => `00000000-0000-4000-8000-${String(org * 100 + space * 10 + chat).padStart(12, "0")}`;
export type CacheSnapshot = {
  inactiveConversations: number; inactivePayloadBytes: number; maxInactivePages: number;
  activeConversations: number; rows: number; deferredRows: number; historyQueries: number;
};
export type NavigationSample = { kind: string; elapsedMs: number; loadingShown: boolean };
export type PerfWindow = Window & { __CONVERSATION_PERF__: {
  snapshot: () => CacheSnapshot; navigation: NavigationSample[]; clearNavigation: () => void;
} };

export async function installConversationFixture(page: Page) {
  const controller = {
    totalMessages: 1_250,
    payloadChars: 650,
    mode: "ready" as "ready" | "slow" | "failed" | "stalled",
    reads: [] as { conversationId: string; cursor: string | null }[],
    failedResponses: 0,
    unexpected: [] as string[],
    errors: [] as string[],
  };
  page.on("pageerror", (error) => controller.errors.push(error.message));
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "5207") {
      controller.unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
      await route.abort("blockedbyclient");
      return;
    }
    if (!url.pathname.startsWith("/controller/")) return route.continue();
    const match = /^\/controller\/conversations\/([^/]+)\/messages$/.exec(url.pathname);
    if (request.method() !== "GET" || !match) {
      controller.unexpected.push(`${request.method()} ${url.pathname}`);
      await route.fulfill({ status: 500, json: { error: "Unexpected fixture request" } });
      return;
    }
    const id = match[1]!;
    const cursor = url.searchParams.get("cursor");
    controller.reads.push({ conversationId: id, cursor });
    const mode = controller.mode;
    if (mode === "slow") await new Promise((resolve) => setTimeout(resolve, 1_500));
    if (mode === "stalled") {
      // A real fetch remains pending until its production AbortSignal fires.
      // Do not resolve or retain response message bodies for this request.
      await new Promise<void>((resolve) => {
        const finish = () => {
          page.off("requestfailed", failed);
          page.off("close", finish);
          resolve();
        };
        const failed = (candidate: typeof request) => {
          if (candidate !== request) return;
          finish();
        };
        page.on("requestfailed", failed);
        page.once("close", finish);
      });
      return;
    }
    if (mode === "failed") {
      await route.fulfill({ status: 503, headers: { "access-control-allow-origin": "*" }, json: { error: "Fixture unavailable" } });
      controller.failedResponses += 1;
      return;
    }
    const offset = Number(cursor ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const length = Math.max(0, Math.min(limit, controller.totalMessages - offset));
    const messages = Array.from({ length }, (_, index) => {
      const sequence = controller.totalMessages - offset - index;
      const heading = `Message ${sequence} in ${id}\n\n`;
      const text = "A repeatable synthetic conversation exercises saved history, layout and rendering. ";
      const content = `${heading}### Saved result\n\n${text.repeat(Math.ceil(controller.payloadChars / text.length))}\n\n\`\`\`ts\nconst message = ${sequence};\n\`\`\`\n`;
      return {
        id: `${id}:${sequence}`, conversationId: id, projectId: "fixture-project", sessionId: null, promptId: null, runId: null,
        role: sequence % 3 === 0 ? "user" : "assistant", content, metadata: {},
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
      };
    });
    await route.fulfill({ headers: { "access-control-allow-origin": "*" }, json: {
      messages, nextCursor: offset + length < controller.totalMessages ? String(offset + length) : null,
      hasMore: offset + length < controller.totalMessages,
    } });
  });
  await page.goto("/");
  await expect(page.getByTestId("scope"), controller.errors.join("; ")).toHaveAttribute("data-count", "50");
  expect(controller.errors).toEqual([]);
  return controller;
}

export async function loadMessages(page: Page, count: number) {
  while (Number(await page.getByTestId("scope").getAttribute("data-count")) < count) {
    const before = Number(await page.getByTestId("scope").getAttribute("data-count"));
    await page.getByTestId("load-older").click();
    await expect.poll(async () => Number(await page.getByTestId("scope").getAttribute("data-count"))).toBeGreaterThan(before);
  }
  await expect(page.getByTestId("chat-message-row")).toHaveCount(count);
}

export async function navigate(page: Page, kind: "org" | "space" | "tab", number: number, expectedCount: number | null = 50) {
  const before = await page.evaluate(() => (window as PerfWindow).__CONVERSATION_PERF__.navigation.length);
  await page.getByTestId(`${kind}-${number}`).click();
  if (expectedCount === null) await expect(page.getByTestId("scope")).not.toHaveAttribute("data-count", "0");
  else await expect(page.getByTestId("scope")).toHaveAttribute("data-count", String(expectedCount));
  await expect.poll(() => page.evaluate(() => (window as PerfWindow).__CONVERSATION_PERF__.navigation.length)).toBe(before + 1);
}

export const snapshot = (page: Page) => page.evaluate(() => (window as PerfWindow).__CONVERSATION_PERF__.snapshot());
export const samples = (page: Page) => page.evaluate(() => (window as PerfWindow).__CONVERSATION_PERF__.navigation);
export const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))]!;

export async function visitConversationScopes(page: Page) {
  for (const org of [1, 2, 3]) {
    // Leave the current scope first so every counted transition really changes it.
    await navigate(page, "org", org, null);
    for (const space of [2, 3]) {
      await navigate(page, "space", space, null);
      for (const tab of [2, 3]) await navigate(page, "tab", tab, null);
    }
  }
}

export async function settledHeap(page: Page) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("HeapProfiler.collectGarbage");
    const heap = await session.send("Runtime.getHeapUsage");
    const dom = await session.send("Memory.getDOMCounters");
    return { usedHeapBytes: heap.usedSize, backingStorageBytes: heap.backingStorageSize, ...dom };
  } finally { await session.detach(); }
}
