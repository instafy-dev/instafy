import { test, expect, type Locator, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { activeConversationId, returnToConversation } from "../utils/conversationNavigation.js";
import { prepareStudio, resetRuntimeUserState } from "../utils/harness.js";

// Site previews end to end (docs/Previews.md): a site running in the space's
// machine is opened from its "Ready to preview" card into a side-pane tab on a
// member-only capability host. Needs the local stack (`pnpm stack:up`), whose
// tunnel broker serves private previews; on any other stack the test skips.

const PREVIEW_PORT = 4173;
const PREVIEW_TITLE = "Site preview";
const BROKER_BASE_URL = (process.env.TUNNEL_BROKER_BASE_URL || "http://127.0.0.1:8082").replace(/\/+$/, "");
const BROKER_TOKEN = process.env.TUNNEL_BROKER_TOKEN || "dev-token";
const INGRESS_PORT = Number(process.env.PUBLIC_INGRESS_PORT || 8083);
const TUNNEL_DOMAIN = process.env.TUNNEL_DOMAIN || "rt.test";

type BrokerCapabilities = { privatePreviews?: boolean; previewDomain?: string };

/** What the broker serves (`GET /capabilities`), or null when it cannot be asked. */
async function brokerCapabilities(): Promise<BrokerCapabilities | null> {
  try {
    const response = await fetch(`${BROKER_BASE_URL}/capabilities`, {
      headers: { authorization: `Bearer ${BROKER_TOKEN}` },
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok ? ((await response.json()) as BrokerCapabilities) : null;
  } catch {
    return null;
  }
}

function docker(args: string[], timeout = 60_000): string {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout });
  if (result.status !== 0) {
    throw new Error(`docker ${args.slice(0, 3).join(" ")} failed (${result.status}): ${(result.stderr || result.stdout || "").slice(0, 400)}`);
  }
  return result.stdout ?? "";
}

/** The space's runtime container: `instafy-runtime-<project hex>-<runtime>-runtime-1`. */
async function runtimeContainerFor(projectId: string): Promise<string> {
  const prefix = `instafy-runtime-${projectId.replace(/-/g, "").toLowerCase()}-`;
  let name = "";
  await expect
    .poll(() => {
      name = docker(["ps", "--format", "{{.Names}}", "--filter", `name=${prefix}`])
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.startsWith(prefix) && line.endsWith("-runtime-1")) ?? "";
      return name;
    }, { timeout: 120_000, message: `runtime container for ${projectId}` })
    .toBeTruthy();
  return name;
}

/** Any site will do: a static page served by python's http.server inside the space's machine. */
function startFixtureServer(container: string, port = PREVIEW_PORT) {
  const dir = `/tmp/site-preview-${port}`;
  docker([
    "exec", container, "sh", "-c",
    `mkdir -p ${dir} && printf '<h1 id=pv>ok</h1>' >${dir}/index.html && cd ${dir} && (python3 -m http.server ${port} -b 127.0.0.1 >/dev/null 2>&1 & echo $! >${dir}.pid)`,
  ]);
}

/** Stops only the fixture server this test started, by the pid it recorded. */
function stopFixtureServer(container: string, port = PREVIEW_PORT) {
  const pidFile = `/tmp/site-preview-${port}.pid`;
  docker(["exec", container, "sh", "-c", `[ -f ${pidFile} ] && kill "$(cat ${pidFile})" 2>/dev/null; rm -f ${pidFile}; true`]);
}

async function waitForFixture(container: string, port = PREVIEW_PORT) {
  await expect
    .poll(() => spawnSync("docker", ["exec", container, "python3", "-c", `import urllib.request;urllib.request.urlopen('http://127.0.0.1:${port}/')`]).status, { timeout: 15_000 })
    .toBe(0);
}

function openPreview(container: string, conversationId: string): Record<string, unknown> {
  const opened = docker(
    ["exec", container, "instafy", "preview", "open", "--port", String(PREVIEW_PORT), "--title", PREVIEW_TITLE, "--conversation", conversationId, "--json"],
    90_000,
  );
  // Progress goes to stderr, so stdout is the JSON document alone.
  return JSON.parse(opened) as Record<string, unknown>;
}

/** A plain request to the local Traefik with an explicit Host, so no DNS is involved. */
function ingressStatus(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port: INGRESS_PORT, path: "/", method: "GET", headers: { host: `${host}:${INGRESS_PORT}` }, timeout: 10_000 },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on("timeout", () => request.destroy(new Error("ingress request timed out")));
    request.on("error", reject);
    request.end();
  });
}

function randomCapabilityLabel(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  return Array.from({ length: 26 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

type E2EHooks = {
  createBlankConversation?: (input: { projectId: string; metadata: Record<string, unknown> }) => Promise<unknown>;
};

async function createBlankControllerConversationId(page: Page, projectId: string, localConversationId: string): Promise<string> {
  await expect
    .poll(() => page.evaluate(() => Boolean((window as Window & { __INSTAFY_E2E__?: E2EHooks }).__INSTAFY_E2E__?.createBlankConversation)), { timeout: 10_000 })
    .toBeTruthy();
  const conversationId = await page.evaluate(
    async ({ projectId, localConversationId }) =>
      await (window as Window & { __INSTAFY_E2E__?: E2EHooks }).__INSTAFY_E2E__!.createBlankConversation!({ projectId, metadata: { localId: localConversationId } }),
    { projectId, localConversationId },
  );
  const normalized = typeof conversationId === "string" ? conversationId.trim() : "";
  if (!normalized) throw new Error("Unable to create blank controller conversation (missing conversationId).");
  return normalized;
}

function previewCard(page: Page): Locator {
  return page.getByTestId("preview-ready-card").filter({ hasText: PREVIEW_TITLE }).last();
}

async function openFromCard(page: Page): Promise<Locator> {
  const card = previewCard(page);
  await expect(card).toContainText("Live", { timeout: 30_000 });
  await card.getByRole("button", { name: "Open" }).click();
  await expect(page.frameLocator("[data-testid=site-preview-frame]").locator("#pv")).toHaveText("ok", { timeout: 30_000 });
  await expect(card.getByRole("button", { name: "Showing" })).toBeVisible();
  return card;
}

test.describe("Site preview card and pane", () => {
  test.setTimeout(300_000);

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "project-preview-ready:cleanup" }).catch(() => {});
  });

  test("opens a private preview from its card and keeps it private", async ({ page, browser }) => {
    const capabilities = await brokerCapabilities();
    test.skip(!capabilities?.privatePreviews || !capabilities.previewDomain, "This stack's tunnel broker serves no private previews (see docs/Previews.md).");
    const previewDomain = capabilities!.previewDomain!;

    await page.setViewportSize({ width: 1400, height: 900 });
    const projectId = await prepareStudio(page);
    if (!projectId) throw new Error("Project id missing for preview test.");
    // Nothing is sent in this conversation, so the assistant stays out of it.
    await returnToConversation(page);
    const localConversationId = await activeConversationId(page);
    const conversationId = await createBlankControllerConversationId(page, projectId, localConversationId);

    const container = await runtimeContainerFor(projectId);
    startFixtureServer(container);
    try {
      await waitForFixture(container);

      // The CLI hands back ids and plain facts, never a viewer URL.
      const result = openPreview(container, conversationId);
      expect(result).toMatchObject({ title: PREVIEW_TITLE, port: PREVIEW_PORT, path: "/", status: "live" });
      expect(JSON.stringify(result)).not.toMatch(/https?:\/\//);
      const previewId = String(result.previewId);
      expect(previewId).toMatch(/^[0-9a-f-]{32,36}$/);
      const tunnelHex = previewId.replace(/-/g, "");

      // The card arrives through the conversation event; Open shows the site in a side-pane tab.
      const card = await openFromCard(page).catch(async (error) => {
        // The card is also in history if the live event raced the conversation binding.
        await page.reload();
        await returnToConversation(page);
        return await openFromCard(page).catch(() => { throw error; });
      });
      await expect(page.getByTestId(`conversation-subtab-preview:${previewId}`)).toBeVisible();
      await expect(page.getByTestId("site-preview-title")).toHaveText(PREVIEW_TITLE);

      // The frame is on a capability host for this preview, and nothing else gets in.
      const src = await page.getByTestId("site-preview-frame").getAttribute("src");
      const viewer = new URL(src ?? "");
      expect(viewer.hostname).toMatch(new RegExp(`^p-[a-z2-7]{26}--${tunnelHex}\\.${previewDomain.replace(/\./g, "\\.")}$`));
      expect(await ingressStatus(viewer.hostname)).toBe(200);

      const outsider = await browser.newContext();
      try {
        // A signed-out browser with a made-up label gets the 401 page.
        const forged = `http://p-${randomCapabilityLabel()}--${tunnelHex}.${previewDomain}:${INGRESS_PORT}/`;
        const response = await (await outsider.newPage()).goto(forged);
        expect(response?.status()).toBe(401);
      } finally {
        await outsider.close();
      }
      // A private tunnel has no router on its bare tunnel host.
      expect(await ingressStatus(`${previewId}.${TUNNEL_DOMAIN}`)).toBe(404);
      expect(await ingressStatus(`${tunnelHex}.${TUNNEL_DOMAIN}`)).toBe(404);

      // The tab's × closes the pane and revokes its session within the broker's 30 s cache.
      await page.getByRole("button", { name: `Close ${PREVIEW_TITLE} view` }).click();
      await expect(page.getByTestId("site-preview-frame")).toHaveCount(0);
      await expect(card.getByRole("button", { name: "Open" })).toBeVisible();
      await expect.poll(() => ingressStatus(viewer.hostname), { timeout: 35_000, intervals: [1_000] }).toBe(401);

      // The server dies: the pane and the card both say so.
      await openFromCard(page);
      stopFixtureServer(container);
      await expect(page.getByTestId("site-preview-pane")).toHaveAttribute("data-state", "not_responding", { timeout: 40_000 });
      await expect(page.getByTestId("site-preview-pane")).toContainText(`Not responding on port ${PREVIEW_PORT}`);
      await expect(previewCard(page)).toContainText(`Not responding on port ${PREVIEW_PORT}`, { timeout: 35_000 });

      // The runtime closes the preview: both read Stopped.
      docker(["exec", container, "instafy", "preview", "close", previewId]);
      await expect(page.getByTestId("site-preview-pane")).toHaveAttribute("data-state", "stopped", { timeout: 30_000 });
      await expect(page.getByTestId("site-preview-pane")).toContainText("Stopped");
      await expect(previewCard(page)).toContainText("Stopped", { timeout: 35_000 });
    } finally {
      stopFixtureServer(container);
    }
  });
});
