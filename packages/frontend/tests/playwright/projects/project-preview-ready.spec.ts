import { test, expect, type Locator, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { createPublicChatFromTopBar } from "../utils/chatUi.js";
import { activeConversationId, returnToConversation, selectConversation } from "../utils/conversationNavigation.js";
import { deleteDisposableTestUser, loginAsGuest, prepareStudio, resetRuntimeUserState } from "../utils/harness.js";
import { chooseOption } from "../utils/select.js";
import { openTeamDirectory } from "../utils/sidebar.js";

// Site previews end to end (docs/Previews.md): a site running in the space's
// machine is opened from its preview card into a side-pane tab on a
// member-only capability host. Needs the local stack (`pnpm stack:up`), whose
// tunnel broker serves private previews; on any other stack the test skips,
// unless INSTAFY_E2E_REQUIRE_PREVIEWS=1, which makes it fail instead so a stack
// that lost its preview settings cannot pass by skipping.
//
// Follow mode (docs/Follow-Mode.md): a desktop presenter and a phone follower on
// a real preview, through the controller's relay.

const PREVIEW_PORT = 4173;
const PREVIEW_TITLE = "Site preview";
const BROKER_BASE_URL = (process.env.TUNNEL_BROKER_BASE_URL || "http://127.0.0.1:8082").replace(/\/+$/, "");
const BROKER_TOKEN = process.env.TUNNEL_BROKER_TOKEN || "dev-token";
const TUNNEL_DOMAIN = process.env.TUNNEL_DOMAIN || "rt.test";
// The local Traefik's API (docker-compose.yml publishes it on 8084), to see which routers it serves.
const TRAEFIK_API_URL = (process.env.TUNNEL_BROKER_TRAEFIK_API_URL || "http://127.0.0.1:8084").replace(/\/+$/, "");

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

function openPreview(container: string, conversationId: string, port = PREVIEW_PORT, title = PREVIEW_TITLE): Record<string, unknown> {
  const opened = docker(
    ["exec", container, "instafy", "preview", "open", "--port", String(port), "--title", title, "--conversation", conversationId, "--json"],
    90_000,
  );
  // Progress goes to stderr, so stdout is the JSON document alone.
  return JSON.parse(opened) as Record<string, unknown>;
}

/** A plain request to the local Traefik with an explicit Host, so no DNS is involved. */
function ingressStatus(host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path: "/", method: "GET", headers: { host: `${host}:${port}` }, timeout: 10_000 },
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

type TraefikRouter = { name: string; rule?: string; middlewares?: string[] };

/** The HTTP routers the local Traefik serves now. */
async function traefikRouters(): Promise<TraefikRouter[]> {
  const response = await fetch(`${TRAEFIK_API_URL}/api/http/routers`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Traefik API answered ${response.status}`);
  return (await response.json()) as TraefikRouter[];
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

function previewCard(page: Page, title = PREVIEW_TITLE): Locator {
  return page.getByTestId("preview-ready-card").filter({ hasText: title }).last();
}

async function openFromCard(page: Page, title = PREVIEW_TITLE): Promise<Locator> {
  const card = previewCard(page, title);
  // A live site's card says nothing about it; the whole card is its Open button.
  await expect(card.getByTestId("preview-ready-status")).toHaveAttribute("data-state", "live", { timeout: 30_000 });
  await card.getByRole("button", { name: `Open ${title}` }).click();
  await expect(page.frameLocator("[data-testid=site-preview-frame]").locator("#pv")).toHaveText("ok", { timeout: 30_000 });
  return card;
}

const siteBody = (page: Page) => page.frameLocator("[data-testid=site-preview-frame]").locator("body");

/**
 * Inside a framed site: answers the layout message listing follow mode's
 * "view" (docs/Follow-Mode.md), records what Studio sends it, and exposes the
 * site side of the protocol (view, tap, the person's own gesture) to the test.
 */
async function actAsFollowSite(page: Page) {
  await siteBody(page).evaluate((body) => {
    type Applied = { seq: number; payload: Record<string, unknown>; smooth: boolean; from: { name: string }; receivedAt: number };
    const site = window as unknown as {
      __host: Array<Record<string, unknown>>; __applied: Applied[];
      __view: (payload: Record<string, unknown>) => void; __tap: (x: number, y: number) => void; __interact: () => void;
    };
    if (site.__applied) return;
    site.__host = [];
    site.__applied = [];
    window.addEventListener("message", (event) => {
      if (event.source !== window.parent) return;
      const data = event.data as Record<string, unknown>;
      site.__host.push(data);
      if (data?.type === "present") body.dataset.presenting = String(data.on);
      if (data?.type === "apply-view") {
        site.__applied.push({ ...(data as unknown as Applied), receivedAt: Date.now() });
        body.dataset.view = JSON.stringify(data.payload);
      }
    });
    const post = (message: Record<string, unknown>) => window.parent.postMessage({ source: "instafy-site", v: 1, ...message }, "*");
    site.__view = (payload) => post({ type: "view", payload });
    site.__tap = (x, y) => post({ type: "tap", payload: { x, y } });
    site.__interact = () => post({ type: "interact" });
    post({ type: "layout-ack", payload: { v: 1, supports: ["view"] } });
  });
}

type FollowSiteWindow = {
  __host: Array<Record<string, unknown>>;
  __applied: Array<{ seq: number; payload: Record<string, unknown>; smooth: boolean; from: { name: string }; receivedAt: number }>;
  __view: (payload: Record<string, unknown>) => void; __tap: (x: number, y: number) => void; __interact: () => void;
};
const appliedViews = (page: Page) => siteBody(page).evaluate(() => (window as unknown as FollowSiteWindow).__applied);
const sendView = (page: Page, payload: Record<string, unknown>) =>
  siteBody(page).evaluate((_body, payload) => (window as unknown as FollowSiteWindow).__view({ ...payload, sentAt: Date.now() }), payload);

/** A builder invite link for the space, opening this conversation (the org invite flow members use). */
async function createInviteLink(page: Page, conversationControllerId: string): Promise<string> {
  await openTeamDirectory(page);
  await page.getByTestId("sidebar-project-settings").click();
  await expect(page.getByTestId("settings-panel")).toBeVisible();
  await page.getByTestId("settings-category-project-access").click();
  await expect(page.getByTestId("project-access-section")).toBeVisible();
  await chooseOption(page.getByTestId("org-invite-link-role"), "builder");
  await page.getByTestId("org-invite-link-create").click();
  const input = page.getByTestId("org-invite-link-url");
  await expect(input).toBeVisible();
  const link = new URL(await input.inputValue());
  link.searchParams.set("conversationControllerId", conversationControllerId);
  link.searchParams.set("panel", "chat");
  return link.toString();
}

/** Back in the chat after leaving it: the preview's pane (its tab, if the chat shows) presents again by itself. */
async function backToPresentedPane(page: Page, previewId: string) {
  if (await page.getByTestId("site-preview-frame").count() === 0) await page.getByTestId(`conversation-subtab-preview:${previewId}`).click();
  await expect(page.frameLocator("[data-testid=site-preview-frame]").locator("#pv")).toHaveText("ok", { timeout: 30_000 });
  await expect(page.getByTestId("follow-bar-chip")).toHaveAttribute("data-role", "presenting", { timeout: 15_000 });
  await actAsFollowSite(page);
  await expect(siteBody(page)).toHaveAttribute("data-presenting", "true");
}

/** Inside the framed site: ask Studio for the location, as any site does (docs/Previews.md, "Location"), and return its answer. */
function askStudioForLocation(page: Page, id: string) {
  return siteBody(page).evaluate((_body, id) => new Promise<unknown>((resolve) => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { source?: string; type?: string; payload?: { id?: string } } | null;
      if (event.source !== window.parent || data?.source !== "instafy-host" || data.payload?.id !== id) return;
      if (data.type !== "location" && data.type !== "location-error") return;
      window.removeEventListener("message", onMessage);
      resolve(data);
    };
    window.addEventListener("message", onMessage);
    window.parent.postMessage({ source: "e2e-site", v: 1, type: "location-request", payload: { id } }, "*");
  }), id);
}

type AskSiteWindow = {
  __host: Array<Record<string, unknown>>;
  __ask: (payload: Record<string, unknown>) => void;
  __next: Record<string, unknown> | null;
};

/**
 * Inside a framed site: records what Studio sends it and exposes the site side of Ask Octo
 * (docs/Bound-Sites.md §2a): `ask` to the parent, `ask-status` back. Any site speaks it; the bind client is one.
 * `#e2e-ask` is the site's Ask Octo button: a real click on it posts `__next`. `__ask` posts with no click.
 */
async function actAsAskSite(page: Page) {
  await siteBody(page).evaluate(() => {
    const site = window as unknown as AskSiteWindow;
    if (site.__host) return;
    site.__host = [];
    window.addEventListener("message", (event) => {
      if (event.source === window.parent) site.__host.push(event.data as Record<string, unknown>);
    });
    const post = (message: Record<string, unknown>) => window.parent.postMessage({ source: "e2e-site", v: 1, ...message }, "*");
    site.__ask = (payload) => post({ type: "ask", payload });
    site.__next = null;
    const button = document.createElement("button");
    button.id = "e2e-ask";
    button.textContent = "Ask Octo";
    button.style.cssText = "position:fixed;left:16px;bottom:16px;z-index:9999;padding:12px";
    button.addEventListener("click", () => { if (site.__next) site.__ask(site.__next); });
    document.body.appendChild(button);
    // A site that speaks first is sent the layout again.
    post({ type: "hello" });
  });
}
const hostMessages = (page: Page) => siteBody(page).evaluate(() => (window as unknown as AskSiteWindow).__host);
/** The person clicks the site's Ask Octo button, which asks `payload`. */
async function clickAsk(page: Page, payload: Record<string, unknown>) {
  await siteBody(page).evaluate((_body, next) => { (window as unknown as AskSiteWindow).__next = next; }, payload);
  await page.frameLocator("[data-testid=site-preview-frame]").locator("#e2e-ask").click();
}
const askStates = async (page: Page, id: string) => (await hostMessages(page))
  .filter((message) => message.type === "ask-status" && (message.payload as { id?: string } | undefined)?.id === id)
  .map((message) => (message.payload as { state: string }).state);

test.describe("Site preview card and pane", () => {
  test.setTimeout(300_000);

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "project-preview-ready:cleanup" }).catch(() => {});
  });

  test("opens a private preview from its card and keeps it private", async ({ page, browser }) => {
    const capabilities = await brokerCapabilities();
    const servesPreviews = Boolean(capabilities?.privatePreviews && capabilities.previewDomain);
    const noPreviews = "This stack's tunnel broker serves no private previews (see docs/Previews.md).";
    if (process.env.INSTAFY_E2E_REQUIRE_PREVIEWS === "1") {
      expect(servesPreviews, noPreviews).toBe(true);
    }
    test.skip(!servesPreviews, noPreviews);
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
      // The runtime image has a browser, so the card gets a picture of the site.
      expect(result).toMatchObject({ title: PREVIEW_TITLE, port: PREVIEW_PORT, path: "/", status: "live", thumbnail: "uploaded" });
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
      // The card shows the picture, fetched with the person's own session into memory: never a frame or an address.
      await expect(card.getByTestId("preview-card-picture").locator("img")).toHaveAttribute("src", /^blob:/, { timeout: 30_000 });
      await expect(card.locator("iframe")).toHaveCount(0);
      await expect(card.getByTestId("preview-card-private")).toHaveAttribute("aria-label", "Only space members can open this");

      // The frame is sandboxed, sends no referrer and may use only fullscreen and the clipboard.
      const frame = page.getByTestId("site-preview-frame");
      const sandbox = (await frame.getAttribute("sandbox")) ?? "";
      expect(sandbox).toContain("allow-scripts");
      expect(sandbox).not.toContain("allow-top-navigation");
      await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
      await expect(frame).toHaveAttribute("allow", "fullscreen; clipboard-write");

      // Location: Studio is the only thing that calls geolocation, granted to Studio's origin only. The site's own
      // call is refused; asking Studio works, and the bar and the tab then show who can see it.
      const studioOrigin = new URL(page.url()).origin;
      await page.context().grantPermissions(["geolocation"], { origin: studioOrigin });
      await page.context().setGeolocation({ latitude: 48.2082, longitude: 16.3738, accuracy: 10 });
      const direct = await siteBody(page).evaluate(() => new Promise<string>((resolve) => {
        navigator.geolocation.getCurrentPosition(() => resolve("granted"), (error) => resolve(`refused:${error.code}`), { timeout: 5_000 });
      }));
      expect(direct).toBe("refused:1");
      expect(await askStudioForLocation(page, "e2e-1")).toMatchObject({
        source: "instafy-host", type: "location", payload: { id: "e2e-1", coords: { latitude: 48.2082, longitude: 16.3738 } },
      });
      const bar = page.getByTestId("site-preview-chrome");
      await expect(bar.getByTestId("preview-location-marker")).toHaveAttribute("aria-label", `${PREVIEW_TITLE} can see your location`);
      await expect(page.getByTestId(`conversation-subtab-preview:${previewId}`)).toHaveAttribute("aria-label", `${PREVIEW_TITLE}, can see your location`);
      await expect(page.getByTestId("preview-location-toast")).toContainText(`${PREVIEW_TITLE} can see your location`);
      // Stop sticks: the site's next request is refused until Studio's own "Share location again".
      await bar.getByTestId("site-preview-location").click();
      await page.getByTestId("site-preview-location-stop").click();
      await expect(bar.getByTestId("preview-location-marker")).toHaveCount(0);
      expect(await askStudioForLocation(page, "e2e-2")).toMatchObject({ type: "location-error", payload: { id: "e2e-2", code: "stopped" } });
      await bar.getByTestId("site-preview-location").click();
      await page.getByTestId("site-preview-location-allow").click();
      expect(await askStudioForLocation(page, "e2e-3")).toMatchObject({ type: "location", payload: { id: "e2e-3" } });
      await expect(bar.getByTestId("preview-location-marker")).toBeVisible();

      // The frame is on a capability host for this preview, and nothing else gets in.
      const viewer = new URL((await frame.getAttribute("src")) ?? "");
      expect(viewer.hostname.endsWith(`.${previewDomain}`)).toBe(true);
      const capabilityLabel = viewer.hostname.slice(0, -(previewDomain.length + 1));
      expect(capabilityLabel).toMatch(/^p-[a-z2-7]{26}--[0-9a-f]{32}$/);
      expect(capabilityLabel.endsWith(`--${tunnelHex}`)).toBe(true);
      const ingressPort = Number(viewer.port || 80);
      expect(await ingressStatus(viewer.hostname, ingressPort)).toBe(200);

      const outsider = await browser.newContext();
      try {
        // A signed-out browser with a made-up label for the same tunnel gets the 401 page.
        const forged = `http://p-${randomCapabilityLabel()}--${tunnelHex}.${previewDomain}:${ingressPort}/`;
        const response = await (await outsider.newPage()).goto(forged);
        expect(response?.status()).toBe(401);
      } finally {
        await outsider.close();
      }

      // Traefik serves this tunnel only on the capability hosts, behind the auth middleware, and never on its
      // bare tunnel host. The routers come first so the 404s below cannot pass for a wrong host format.
      const routers = await traefikRouters();
      const tunnelRouters = routers.filter((router) => (router.rule ?? "").includes(tunnelHex) || (router.rule ?? "").includes(previewId));
      expect(tunnelRouters.length).toBeGreaterThan(0);
      for (const router of tunnelRouters) {
        expect(router.rule ?? "").toContain(`--${tunnelHex}`);
        expect(router.rule ?? "").toMatch(/^HostRegexp\(/);
        expect((router.middlewares ?? []).some((name) => name.includes("preview-auth"))).toBe(true);
      }
      expect(await ingressStatus(`${previewId}.${TUNNEL_DOMAIN}`, ingressPort)).toBe(404);
      expect(await ingressStatus(`${tunnelHex}.${TUNNEL_DOMAIN}`, ingressPort)).toBe(404);

      // The tab's × closes the pane and revokes its session within the broker's 30 s cache.
      await page.getByRole("button", { name: `Close ${PREVIEW_TITLE} view` }).click();
      await expect(page.getByTestId("site-preview-frame")).toHaveCount(0);
      await expect(card.getByRole("button", { name: `Open ${PREVIEW_TITLE}` })).toBeVisible();
      await expect.poll(() => ingressStatus(viewer.hostname, ingressPort), { timeout: 35_000, intervals: [1_000] }).toBe(401);

      // The server dies: the pane and the card both say so.
      await openFromCard(page);
      stopFixtureServer(container);
      await expect(page.getByTestId("site-preview-pane")).toHaveAttribute("data-state", "not_responding", { timeout: 40_000 });
      await expect(page.getByTestId("site-preview-pane")).toContainText(`Not responding on port ${PREVIEW_PORT}`);
      await expect(previewCard(page).getByTestId("preview-ready-status")).toHaveText("Not responding", { timeout: 35_000 });

      // The runtime closes the preview: both read Stopped.
      docker(["exec", container, "instafy", "preview", "close", previewId]);
      await expect(page.getByTestId("site-preview-pane")).toHaveAttribute("data-state", "stopped", { timeout: 30_000 });
      await expect(page.getByTestId("site-preview-pane")).toContainText("Stopped");
      await expect(previewCard(page)).toContainText("Stopped", { timeout: 35_000 });
    } finally {
      stopFixtureServer(container);
    }
  });

  test("Ask Octo: a site's click is the person's own message in the chat, and the site hears what became of it", async ({ page }) => {
    const capabilities = await brokerCapabilities();
    const servesPreviews = Boolean(capabilities?.privatePreviews && capabilities.previewDomain);
    const noPreviews = "This stack's tunnel broker serves no private previews (see docs/Previews.md).";
    if (process.env.INSTAFY_E2E_REQUIRE_PREVIEWS === "1") expect(servesPreviews, noPreviews).toBe(true);
    test.skip(!servesPreviews, noPreviews);
    const ASK_PORT = PREVIEW_PORT + 9;
    const ASK_TITLE = "Running shoes";
    await page.setViewportSize({ width: 1400, height: 900 });
    const projectId = await prepareStudio(page);
    if (!projectId) throw new Error("Project id missing for the ask test.");
    await returnToConversation(page);
    const localConversationId = await activeConversationId(page);
    const conversationId = await createBlankControllerConversationId(page, projectId, localConversationId);
    const container = await runtimeContainerFor(projectId);
    startFixtureServer(container, ASK_PORT);
    try {
      await waitForFixture(container, ASK_PORT);
      openPreview(container, conversationId, ASK_PORT, ASK_TITLE);
      await openFromCard(page, ASK_TITLE).catch(async (error) => {
        await page.reload();
        await returnToConversation(page);
        return await openFromCard(page, ASK_TITLE).catch(() => { throw error; });
      });

      // The person may send messages here, so Studio's layout says the site may hand it asks.
      await actAsAskSite(page);
      await expect.poll(async () => (await hostMessages(page)).filter((m) => m.type === "layout").at(-1)?.caps, { timeout: 10_000 })
        .toEqual({ location: "host", ask: true });

      const ask = {
        id: "int_e2e_0001", intent: "check_size", label: "Ask Octo", say: "Is size {size} in stock for {ref}?",
        params: { size: "10", ref: "shoes:karhu-ikoni-3" }, ref: "shoes:karhu-ikoni-3",
      };
      // The page's script asking on its own, with nobody clicking, sends nothing.
      await siteBody(page).evaluate((_body, payload) => (window as unknown as AskSiteWindow).__ask(payload), { ...ask, id: "int_e2e_0000" });
      await expect.poll(() => askStates(page, "int_e2e_0000"), { timeout: 5_000 }).toEqual(["declined"]);

      // A click: Studio writes the message itself, from the intent's say line and the preview's own title.
      await clickAsk(page, ask);
      await expect.poll(() => askStates(page, ask.id), { timeout: 5_000 }).toContain("sent");
      const line = `Is size 10 in stock for Karhu ikoni 3? · via ${ASK_TITLE}`;
      await expect(page.getByText(line, { exact: true }).first()).toBeVisible({ timeout: 15_000 });

      // The same id again asks nothing; a second ask while the first one's run is going is declined with a reason.
      await clickAsk(page, ask);
      await clickAsk(page, { ...ask, id: "int_e2e_0002" });
      await expect.poll(() => askStates(page, "int_e2e_0002"), { timeout: 5_000 }).toEqual(["declined"]);
      await expect(page.getByText(line, { exact: true })).toHaveCount(1);

      // The message's run ends (an answer, or a failure on a stack without a model): the site hears which.
      await expect.poll(async () => (await askStates(page, ask.id)).at(-1), { timeout: 240_000, intervals: [2_000] })
        .toMatch(/^(done|failed)$/);
    } finally {
      stopFixtureServer(container, ASK_PORT);
    }
  });

  test("follow mode: a phone follows a desktop presenter, and presenting survives leaving the chat", async ({ page, browser }) => {
    test.setTimeout(420_000);
    const capabilities = await brokerCapabilities();
    const servesPreviews = Boolean(capabilities?.privatePreviews && capabilities.previewDomain);
    const noPreviews = "This stack's tunnel broker serves no private previews (see docs/Previews.md).";
    if (process.env.INSTAFY_E2E_REQUIRE_PREVIEWS === "1") expect(servesPreviews, noPreviews).toBe(true);
    test.skip(!servesPreviews, noPreviews);
    const FOLLOW_PORT = PREVIEW_PORT + 7;
    const FOLLOW_TITLE = "Follow site";
    await page.setViewportSize({ width: 1400, height: 900 });
    const projectId = await prepareStudio(page);
    if (!projectId) throw new Error("Project id missing for follow test.");
    await returnToConversation(page);
    const localConversationId = await activeConversationId(page);
    const conversationId = await createBlankControllerConversationId(page, projectId, localConversationId);
    const container = await runtimeContainerFor(projectId);
    startFixtureServer(container, FOLLOW_PORT);
    const member = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    let memberUserId: string | null = null;
    try {
      await waitForFixture(container, FOLLOW_PORT);
      const opened = openPreview(container, conversationId, FOLLOW_PORT, FOLLOW_TITLE);
      const previewId = String(opened.previewId);

      // A opens the site. Present is offered only once the site says it can share its view.
      await openFromCard(page, FOLLOW_TITLE);
      await expect(page.getByTestId("follow-present")).toHaveCount(0);
      await actAsFollowSite(page);
      await expect(page.getByTestId("follow-present")).toHaveAttribute("aria-label", "Present to the space");
      await page.getByTestId("follow-present").click();
      const presenterChip = page.getByTestId("follow-bar-chip");
      await expect(presenterChip).toHaveAttribute("data-role", "presenting");
      await expect(presenterChip.getByTestId("follow-status")).toHaveText("Presenting");
      // The site hears it presents; the person's location is never part of it.
      await expect(siteBody(page)).toHaveAttribute("data-presenting", "true");
      expect(await siteBody(page).evaluate(() => (window as unknown as FollowSiteWindow).__host.find(message => message.type === "present")))
        .toMatchObject({ source: "instafy-host", v: 1, type: "present", on: true, share: { location: false } });
      await sendView(page, { tab: "plan", day: 3, n: 0 });

      // B: a second member on a phone, invited with a link, in the same conversation.
      // A's settings replace the chat for a moment, so the pane comes back with a fresh frame, still presenting.
      const inviteUrl = await createInviteLink(page, conversationId);
      await returnToConversation(page);
      await backToPresentedPane(page, previewId);
      await sendView(page, { tab: "plan", day: 3, n: 0 });
      const mobile = await member.newPage();
      mobile.setDefaultTimeout(60_000);
      memberUserId = (await loginAsGuest(mobile)).disposableUserId;
      await mobile.goto(inviteUrl, { waitUntil: "domcontentloaded" });
      await mobile.getByTestId("invite-accept-join").click();
      await mobile.waitForURL((url) => url.pathname.includes("/studio"), { timeout: 60_000 });
      await mobile.goto(`/studio?projectId=${encodeURIComponent(projectId)}&panel=chat&conversationControllerId=${encodeURIComponent(conversationId)}`,
        { waitUntil: "domcontentloaded" });
      // The card says who presents and offers Follow.
      const mobileCard = previewCard(mobile, FOLLOW_TITLE);
      await expect(mobileCard.getByTestId("preview-ready-follow-line")).toContainText("is presenting", { timeout: 60_000 });
      await mobileCard.scrollIntoViewIfNeeded();
      await mobileCard.getByTestId("preview-ready-follow").click();
      await expect(mobile.frameLocator("[data-testid=site-preview-frame]").locator("#pv")).toHaveText("ok", { timeout: 30_000 });
      await expect(mobile.getByTestId("follow-bar-chip")).toHaveAttribute("data-role", "following", { timeout: 10_000 });
      await expect(mobile.getByTestId("follow-ring")).toBeVisible();
      // The site acks "view": it catches up at once, jumping to the presenter's view.
      await actAsFollowSite(mobile);
      await expect.poll(async () => (await appliedViews(mobile)).at(-1)?.payload?.n, { timeout: 5_000 }).toBe(0);
      expect((await appliedViews(mobile))[0]).toMatchObject({ smooth: false, payload: { tab: "plan", day: 3 } });

      // A moves: B follows within a second, smoothly, the latest view winning.
      for (let n = 1; n <= 20; n += 1) {
        await sendView(page, { tab: "plan", day: 3, n });
        await page.waitForTimeout(20);
      }
      await expect.poll(async () => (await appliedViews(mobile)).at(-1)?.payload?.n, { timeout: 3_000 }).toBe(20);
      const applied = await appliedViews(mobile);
      const last = applied.at(-1)!;
      expect(last.smooth).toBe(true);
      expect(applied.filter(view => (view.payload.n as number) >= 1).length).toBeLessThan(20);
      const latencies = applied.filter(view => typeof view.payload.sentAt === "number").map(view => view.receivedAt - (view.payload.sentAt as number));
      console.log(`[follow-e2e] presenter → follower latency ms: ${latencies.join(",")}`);
      expect(last.receivedAt - (last.payload.sentAt as number)).toBeLessThan(1_500);

      // A leaves this chat for another one (as when opening a run tab): the pane goes, the presentation stays and
      // B sees A away once A's heartbeats stop (15 s), still on the last view.
      await createPublicChatFromTopBar(page);
      await expect(page.getByTestId("site-preview-frame")).toHaveCount(0);
      await expect(mobile.getByTestId("follow-status")).toHaveText(/is away$/, { timeout: 40_000 });
      await expect(mobile.getByTestId("follow-note")).toHaveCount(0);
      // A comes back: presenting again at once, with no second Present, and B follows again.
      await selectConversation(page, localConversationId);
      await backToPresentedPane(page, previewId);
      await expect(mobile.getByTestId("follow-status")).toHaveText(/^Following /, { timeout: 15_000 });
      await sendView(page, { tab: "places", n: 30 });
      await expect.poll(async () => (await appliedViews(mobile)).at(-1)?.payload?.n, { timeout: 5_000 }).toBe(30);

      // B pans the site: following stops and the chip offers Follow again.
      await mobile.waitForTimeout(400);
      await siteBody(mobile).evaluate(() => (window as unknown as FollowSiteWindow).__interact());
      await expect(mobile.getByTestId("follow-action")).toHaveText("Follow again");
      await expect(mobile.getByTestId("follow-ring")).toHaveCount(0);
      await mobile.getByTestId("follow-action").click();
      await expect(mobile.getByTestId("follow-bar-chip")).toHaveAttribute("data-role", "following");

      // Closing the preview's tab ends it for everyone.
      await page.getByRole("button", { name: `Close ${FOLLOW_TITLE} view` }).click();
      await expect(mobile.getByTestId("follow-note")).toContainText("stopped presenting", { timeout: 15_000 });
      docker(["exec", container, "instafy", "preview", "close", previewId]);
    } finally {
      await member.close();
      stopFixtureServer(container, FOLLOW_PORT);
      if (memberUserId) await deleteDisposableTestUser(memberUserId).catch(() => {});
    }
  });
});
