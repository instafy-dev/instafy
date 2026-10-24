// Octo turn eval (docs/Octo-Turn-Eval.md): sends each case of a cases file (default: octo-turn-cases.json) to real
// Octo in a fresh space, waits for its agent_jobs to settle, finds the page Octo built the way a person would (its
// "Ready to preview" card, else the space's previews), saves the evidence and grades it with
// scripts/octo-turn-grade.mjs (no model), then deletes the case's space through the controller so no work of it
// outlives the case (scripts/octo-turn-release.mjs). Real model, real quota: opt-in only, never part of default CI.
//
//   PLAYWRIGHT_RUN_BENCH=1 PLAYWRIGHT_OCTO_EVAL=1 \
//   PLAYWRIGHT_OCTO_EVAL_CASES=checklist,negative-translate \
//   PLAYWRIGHT_OCTO_EVAL_USER_FILE=<mint-test-user --json output> \
//   pnpm -C packages/frontend exec playwright test -c tests/playwright/bench/octo-turn-eval.config.ts
//
// Use the config above: the default config's global setup/teardown and runtime cleanup reporter remove every
// instafy-runtime-* container on the machine.
import { test, expect, type Page, type Frame, type APIRequestContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  REPO_ROOT,
  DEFAULT_CASES_FILE,
  collectCredits,
  collectJobs,
  gradeRunDir,
  jobsSettled,
  loadCases,
  redactText,
  validateCases,
} from "../../../../../scripts/octo-turn-grade.mjs";
import { finishCase, readSpaceState } from "../../../../../scripts/octo-turn-release.mjs";

const ENABLED = process.env.PLAYWRIGHT_RUN_BENCH === "1" && process.env.PLAYWRIGHT_OCTO_EVAL === "1";
const STUDIO = (process.env.PLAYWRIGHT_EXTERNAL_BASE_URL || "http://localhost:5173").replace(/\/$/, "");
const CONTROLLER = (process.env.PLAYWRIGHT_CONTROLLER_URL || "http://127.0.0.1:8788").replace(/\/$/, "");
const CASES_FILE = process.env.PLAYWRIGHT_OCTO_EVAL_CASES_FILE || DEFAULT_CASES_FILE;
const SITE_TEXT_MAX = 20_000;
const POLL_MS = 10_000;
const SETTLE_QUIET_MS = 20_000;
// "0" keeps each case's space (its runtime, and any work still queued) for a readback; delete it afterwards.
const KEEP_SPACES = process.env.PLAYWRIGHT_OCTO_EVAL_STOP_RUNTIMES === "0";
// Map libraries by the container they render; any of them counts as a map.
const MAP_ENGINES: [string, string][] = [
  ["maplibre", ".maplibregl-map"], ["mapbox", ".mapboxgl-map"], ["leaflet", ".leaflet-container"],
  ["openlayers", ".ol-viewport"], ["google", ".gm-style, gmp-map"],
];

type EvalCase = {
  id: string;
  tier?: string;
  kind?: string;
  prompt: string;
  expect: { map?: boolean; siteRequired: boolean };
  budget: { seconds: number };
};
type SupabaseConfig = { supabaseUrl: string; supabaseKey: string };
type SupabaseWindow = Window & { __INSTAFY_SUPABASE__?: SupabaseConfig };
type JobRow = { id: string; status: string };
type SiteShape = { tableRows: number; listItems: number; orderedItems: number; checkboxes: number };
type SiteInfo = {
  mapEngine?: string | null;
  title?: string;
  text?: string;
  textChars?: number;
  externalLinks?: number;
  shape?: SiteShape;
  error?: string;
};
type SitePreview = { previewId: string; status: string; createdAt?: string | null };
type MintedUser = { email: string; password: string; userId: string; storageKey: string; org?: { id?: string } | null };

function selectedCases(): EvalCase[] {
  const all = loadCases(CASES_FILE) as EvalCase[];
  const problems = validateCases(all);
  if (problems.length) throw new Error(`octo-turn cases are invalid:\n${problems.join("\n")}`);
  const ids = (process.env.PLAYWRIGHT_OCTO_EVAL_CASES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const tiers = (process.env.PLAYWRIGHT_OCTO_EVAL_TIER ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !all.some((c) => c.id === id));
  if (unknown.length) throw new Error(`unknown octo-turn case ids: ${unknown.join(", ")}`);
  return all.filter((c) => (!ids.length || ids.includes(c.id)) && (!tiers.length || tiers.includes(c.tier ?? "")));
}

const CASES: EvalCase[] = ENABLED ? selectedCases() : [];
const RUN_ID = process.env.PLAYWRIGHT_OCTO_EVAL_RUN_ID || new Date().toISOString().replace(/[:.]/g, "-");
const RUN_DIR = path.join(REPO_ROOT, "tmp/octo-turn", RUN_ID);

let user: MintedUser | null = null;
let mintedHere = false;

function loadUser(): MintedUser {
  const file = process.env.PLAYWRIGHT_OCTO_EVAL_USER_FILE;
  if (file) return JSON.parse(fs.readFileSync(file, "utf8"));
  // Kept in memory only; run.json records the userId so the runbook's cleanup can delete it.
  const out = execFileSync(process.execPath, [path.join(REPO_ROOT, "scripts/mint-test-user.mjs"), "--json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, INSTAFY_ENV_DIR: "" },
  });
  mintedHere = true;
  return JSON.parse(out);
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function signIn(page: Page, u: MintedUser): Promise<string> {
  await page.goto(`${STUDIO}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean((window as SupabaseWindow).__INSTAFY_SUPABASE__), null, { timeout: 30_000 });
  const session = await page.evaluate(async ([email, password]) => {
    const config = (window as SupabaseWindow).__INSTAFY_SUPABASE__!;
    const response = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: config.supabaseKey, "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    return response.ok ? await response.json() : null;
  }, [u.email, u.password]);
  if (!session?.access_token) throw new Error("password sign-in failed for the eval user");
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [u.storageKey, JSON.stringify(session)]);
  return session.access_token as string;
}

async function createSpace(page: Page, accessToken: string, u: MintedUser, name: string): Promise<string> {
  const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
  let orgId = u.org?.id ?? null;
  if (!orgId) {
    const orgs = await (await page.request.get(`${CONTROLLER}/orgs`, { headers })).json();
    orgId = (orgs?.orgs ?? []).find((o: { id?: string; role?: string }) => o.role === "owner")?.id ?? null;
  }
  if (!orgId) throw new Error("eval user has no org it owns");
  const response = await page.request.post(`${CONTROLLER}/orgs/${orgId}/projects`, {
    headers,
    data: { projectType: "customer", projectName: name, ownerUserId: u.userId },
  });
  if (!response.ok()) throw new Error(`create space failed: ${response.status()} ${redactText(await response.text())}`);
  return (await response.json()).projectId as string;
}

async function pickManagedAiIfAsked(page: Page) {
  const managed = page.getByTestId("onboarding-use-managed-ai");
  if (await managed.isVisible().catch(() => false)) {
    await managed.click();
    await page.waitForTimeout(3_000);
  }
}

/** The space's site previews as the controller lists them. `available` is false when this server offers no previews
 *  (503, or no preview routes at all), null when the answer says nothing either way. */
async function listPreviews(request: APIRequestContext, accessToken: string, projectId: string): Promise<{ available: boolean | null; previews: SitePreview[] }> {
  const response = await request.get(`${CONTROLLER}/projects/${projectId}/previews`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  }).catch(() => null);
  if (!response) return { available: null, previews: [] };
  if (response.ok()) {
    const body = await response.json().catch(() => null);
    return { available: true, previews: Array.isArray(body) ? body : [] };
  }
  const routesMissing = response.status() === 404 && !(await response.text().catch(() => "")).trim();
  return { available: response.status() === 503 || routesMissing ? false : null, previews: [] };
}

/** "Open in new tab" for a preview: a viewer URL for a separate tab. Kept in memory only. */
async function mintTabViewer(request: APIRequestContext, accessToken: string, projectId: string, previewId: string): Promise<string | null> {
  const response = await request.post(`${CONTROLLER}/projects/${projectId}/previews/${encodeURIComponent(previewId)}/view?tab=true`, {
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    data: {},
  }).catch(() => null);
  if (!response?.ok()) return null;
  const body = await response.json().catch(() => null);
  return typeof body?.viewerUrl === "string" ? body.viewerUrl : null;
}

async function visiblePreviewFrame(page: Page, timeout: number): Promise<Frame | null> {
  const element = page.locator("[data-testid=site-preview-frame]").filter({ visible: true }).first();
  if (!(await element.waitFor({ timeout }).then(() => true).catch(() => false))) return null;
  for (let i = 0; i < 60; i += 1) {
    const frame = await (await element.elementHandle())?.contentFrame();
    if (frame) return frame;
    await page.waitForTimeout(500);
  }
  return null;
}

/** Waits for the page to be ready (a map case: a map rendered; any other: loaded with text), then counts it. */
async function measureSite(frame: Frame, wait: (ms: number) => Promise<void>, wantMap: boolean): Promise<{ readyMs: number; site: SiteInfo }> {
  const started = Date.now();
  const readyDeadline = started + 90_000;
  while (Date.now() < readyDeadline) {
    const state = await frame.evaluate((engines: [string, string][]) => ({
      map: engines.some(([, selector]) => Boolean(document.querySelector(selector))),
      text: (document.body?.innerText ?? "").trim().length,
      complete: document.readyState === "complete",
    }), MAP_ENGINES).catch(() => null);
    if (state && (wantMap ? state.map : state.complete && state.text > 0)) break;
    await wait(500);
  }
  const readyMs = Date.now() - started;
  await wait(2_500);
  const site: SiteInfo = await frame.evaluate(([textMax, engines]: [number, [string, string][]]): SiteInfo => {
    // Map tiles and attribution are not sources.
    const attribution = /openstreetmap|maplibre|openfreemap|carto|stadia|leafletjs|mapbox|google\.com\/maps/i;
    const links = [...document.querySelectorAll<HTMLAnchorElement>("a[href^='https:']")]
      .filter((a) => !attribution.test(a.href));
    const rendered = (selector: string) => [...document.querySelectorAll(selector)]
      .some((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0);
    const outsideNav = (el: Element) => !el.closest("nav");
    const text = (document.body?.innerText ?? "").trim();
    return {
      mapEngine: engines.find(([, selector]) => rendered(selector))?.[0] ?? null,
      title: document.title,
      text: text.slice(0, textMax),
      textChars: text.length,
      externalLinks: new Set(links.map((a) => a.href)).size,
      // What kind of page this is, counted: the grader compares it with the case's siteShape.
      shape: {
        tableRows: [...document.querySelectorAll("tr, [role=row]")]
          .filter((row) => row.querySelector("td, [role=cell], [role=gridcell]")).length,
        listItems: [...document.querySelectorAll("li")].filter(outsideNav).length,
        orderedItems: [...document.querySelectorAll("ol > li")].filter(outsideNav).length,
        checkboxes: document.querySelectorAll("input[type=checkbox], [role=checkbox]").length,
      },
    };
  }, [SITE_TEXT_MAX, MAP_ENGINES] as [number, [string, string][]]).catch((error): SiteInfo => ({ error: String(error).slice(0, 160) }));
  return { readyMs, site };
}

function runtimeContainers(projectId: string): string[] {
  const prefix = `instafy-runtime-${projectId.replace(/-/g, "")}-`;
  try {
    return execFileSync("docker", ["ps", "--filter", `name=^${prefix}`, "--format", "{{.Names}}"], { encoding: "utf8" })
      .split("\n").map((s) => s.trim()).filter((s) => s.startsWith(prefix));
  } catch {
    return [];
  }
}

/** The skills installed in the space (folders under .agents/skills in the space's workspace), so a case's skill checks
 *  apply only to skills the space has. Null when no runtime of the space has that folder. */
function spaceSkillsOf(containers: string[], projectId: string): string[] | null {
  // A space's workspace is <WORKSPACE_DIR>/<projectId>; a runtime that serves one space may use WORKSPACE_DIR itself.
  const list = 'W="${WORKSPACE_DIR:-/workspace}"; for r in "$W/$SPACE" "$W"; do '
    + 'if [ -d "$r/.agents/skills" ]; then for d in "$r"/.agents/skills/*/; do [ -d "$d" ] && basename "$d"; done; exit 0; fi; done; exit 3';
  for (const name of containers) {
    try {
      const out = execFileSync("docker", ["exec", "-e", `SPACE=${projectId}`, name, "sh", "-c", list], { encoding: "utf8", timeout: 15_000 });
      return out.split("\n").map((s) => s.trim()).filter((s) => /^[\w.-]+$/.test(s)).sort();
    } catch {
      // not this container, or no skills folder in it
    }
  }
  return null;
}

/** Deletes the space the way a person does: the controller cancels its queued and leased work and stops its runtimes. */
async function deleteSpace(request: APIRequestContext, accessToken: string, projectId: string): Promise<{ ok: boolean; status: number; error?: string }> {
  const response = await request.delete(`${CONTROLLER}/projects/${projectId}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (response.ok()) return { ok: true, status: response.status() };
  return { ok: false, status: response.status(), error: redactText(await response.text().catch(() => "")).slice(0, 200) };
}

/** Last resort for a container the controller did not stop once it released the space. */
function stopRuntimeContainers(names: string[]): string[] {
  if (!names.length) return [];
  try {
    execFileSync("docker", ["stop", ...names], { encoding: "utf8" });
    return names;
  } catch (error) {
    return [`docker stop failed: ${String((error as Error).message).slice(0, 160)}`];
  }
}

test.describe("Octo turn eval", () => {
  test.skip(!ENABLED, "opt-in: PLAYWRIGHT_RUN_BENCH=1 PLAYWRIGHT_OCTO_EVAL=1 (real model, burns quota)");
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => {
    user = loadUser();
    writeJson(path.join(RUN_DIR, "run.json"), {
      runId: RUN_ID,
      startedAt: new Date().toISOString(),
      casesFile: path.relative(REPO_ROOT, CASES_FILE),
      caseIds: CASES.map((c) => c.id),
      userId: user.userId,
      userMintedBySpec: mintedHere,
      studio: STUDIO,
    });
  });

  test.afterAll(() => {
    if (!fs.existsSync(path.join(RUN_DIR, "run.json"))) return;
    const run = JSON.parse(fs.readFileSync(path.join(RUN_DIR, "run.json"), "utf8"));
    writeJson(path.join(RUN_DIR, "run.json"), { ...run, finishedAt: new Date().toISOString() });
    const { grade, reportPath } = gradeRunDir(RUN_DIR, { casesFile: CASES_FILE });
    console.log(`[octo-turn] ${grade.totals.passed}/${grade.totals.cases} passed; ${path.relative(REPO_ROOT, reportPath)}`);
  });

  for (const evalCase of CASES) {
    test(evalCase.id, async ({ page }) => {
      const deadlineMs = (evalCase.budget.seconds + 240) * 1000;
      test.setTimeout(deadlineMs + 600_000);
      const caseDir = path.join(RUN_DIR, "cases", evalCase.id);
      fs.mkdirSync(caseDir, { recursive: true });
      const studioErrors: string[] = [];
      const consoleErrors: { at: number; url: string; text: string }[] = [];
      const siteNavigations: { at: number; url: string; status: number }[] = [];
      const context = page.context();
      page.on("pageerror", (error) => studioErrors.push(redactText(String(error)).slice(0, 200)));
      // On the context, so a preview opened in its own tab is watched too.
      context.on("console", (message) => {
        if (message.type() !== "error") return;
        consoleErrors.push({ at: Date.now(), url: message.location()?.url ?? "", text: message.text() });
      });
      context.on("response", (response) => {
        if (response.request().isNavigationRequest() && response.frame() !== page.mainFrame()) {
          siteNavigations.push({ at: Date.now(), url: response.url(), status: response.status() });
        }
      });
      const originOf = (url: string) => { try { return new URL(url).origin; } catch { return ""; } };

      const accessToken = await signIn(page, user!);
      const projectId = await createSpace(page, accessToken, user!, `Octo eval ${evalCase.id}`);
      const evidence: Record<string, unknown> & { sentAt?: string; conversationId?: string | null; jobs?: JobRow[] } = { caseId: evalCase.id, prompt: evalCase.prompt, projectId };
      writeJson(path.join(caseDir, "evidence.json"), evidence);

      try {
        await page.goto(`${STUDIO}/studio?projectId=${projectId}`);
        await page.getByTestId("chat-input").waitFor({ timeout: 90_000 });
        await page.waitForTimeout(4_000);
        await pickManagedAiIfAsked(page);
        await page.getByTestId("chat-input").fill(evalCase.prompt);
        // Under host load the credential check can time out and latch "I can't verify the AI connection right now"
        // with a Retry button; a person would click it, so the spec does too instead of waiting out the budget.
        const send = page.getByTestId("chat-send-button");
        const sendDeadline = Date.now() + 180_000;
        while (!(await send.isEnabled().catch(() => false)) && Date.now() < sendDeadline) {
          const retry = page.getByRole("button", { name: /^Retry$/ });
          if (await retry.first().isVisible().catch(() => false)) await retry.first().click().catch(() => {});
          await page.waitForTimeout(5_000);
        }
        await expect(send).toBeEnabled({ timeout: 5_000 });
        const sentAt = new Date(Date.now() - 2_000);
        await page.getByTestId("chat-send-button").click();
        evidence.sentAt = sentAt.toISOString();
        await expect(page.getByTestId("chat-bubble-user").last()).toBeVisible({ timeout: 60_000 });
        evidence.conversationId = new URL(page.url()).searchParams.get("conversationId");

        // Wait for every job of the turn (lead, workers, continuation) to finish and stay quiet.
        let jobs: JobRow[] = [];
        let signature = "";
        let lastChangeAt = Date.now();
        let cardSeenMs: number | null = null;
        const started = Date.now();
        while (Date.now() - started < deadlineMs) {
          jobs = collectJobs({ projectId, sinceIso: evidence.sentAt });
          const next = jobs.map((job) => `${job.id}:${job.status}`).join(",");
          if (next !== signature) { signature = next; lastChangeAt = Date.now(); }
          if (cardSeenMs == null && (await page.getByTestId("preview-ready-card").count().catch(() => 0)) > 0) {
            cardSeenMs = Date.now() - sentAt.getTime();
          }
          if (jobsSettled(jobs, { lastChangeAt, quietMs: SETTLE_QUIET_MS })) break;
          await page.waitForTimeout(POLL_MS);
        }
        evidence.timedOut = !jobsSettled(jobs, { lastChangeAt, quietMs: 0 });
        evidence.settledAt = new Date().toISOString();

        // Find the page the way a person would: the newest "Ready to preview" card, opened into the side pane.
        const conversation = evidence.conversationId ? `&conversationId=${evidence.conversationId}` : "";
        await page.goto(`${STUDIO}/studio?projectId=${projectId}${conversation}`);
        await page.getByTestId("chat-input").waitFor({ timeout: 90_000 });
        await page.waitForTimeout(6_000);
        const listed = await listPreviews(page.request, accessToken, projectId);
        const cards = page.getByTestId("preview-ready-card");
        const cardCount = await cards.count();
        const ui: Record<string, unknown> = {
          cardSeenMs, cardCount, opened: false, pageSource: null,
          previewsAvailable: listed.available, previewsListed: listed.previews.length,
        };
        let frame: Frame | null = null;
        if (cardCount > 0) {
          const card = cards.nth(cardCount - 1);
          ui.cardTitle = redactText((await card.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 160));
          ui.cardState = await card.getByTestId("preview-ready-status").getAttribute("data-state").catch(() => null);
          frame = await visiblePreviewFrame(page, 2_000);
          if (!frame) {
            await card.scrollIntoViewIfNeeded().catch(() => {});
            const open = card.getByTestId("preview-ready-open");
            if (await open.isEnabled().catch(() => false)) {
              await open.click({ timeout: 30_000 }).catch(() => {});
              frame = await visiblePreviewFrame(page, 60_000);
            }
          }
          if (frame) ui.pageSource = "card";
        }
        // No card, or one that would not open: the space's own previews, opened in a tab of their own.
        if (!frame) {
          const preview = [...listed.previews].filter((p) => p.status === "active")
            .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""))).at(-1);
          const viewerUrl = preview ? await mintTabViewer(page.request, accessToken, projectId, preview.previewId) : null;
          if (viewerUrl) {
            const tab = await context.newPage();
            await tab.goto(viewerUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
            frame = tab.mainFrame();
            ui.pageSource = "previews";
          }
        }
        if (frame) {
          ui.opened = true;
          ui.siteOrigin = originOf(frame.url());
          const { readyMs, site } = await measureSite(frame, (ms) => page.waitForTimeout(ms), Boolean(evalCase.expect.map));
          ui.siteReadyMs = readyMs;
          ui.mapEngine = site.mapEngine ?? null;
          ui.shape = site.shape ?? null;
          ui.siteText = site.text ? redactText(site.text) : null;
          ui.siteTitle = site.title ? redactText(site.title).slice(0, 120) : null;
          ui.siteTextChars = site.textChars ?? 0;
          ui.externalLinks = site.externalLinks ?? 0;
          if (site.error) ui.siteError = redactText(site.error);
          ui.screenshot = path.relative(REPO_ROOT, path.join(caseDir, "site.png"));
          await frame.page().screenshot({ path: path.join(caseDir, "site.png") }).catch(() => {});
        } else {
          await page.screenshot({ path: path.join(caseDir, "chat.png") }).catch(() => {});
        }
        // Only what the opened site itself logged or answered counts against it, not Studio's own requests.
        const siteOrigin = ui.siteOrigin as string | undefined;
        const fromSite = (url: string) => Boolean(siteOrigin) && originOf(url) === siteOrigin;
        ui.frameStatus = siteNavigations.filter((n) => fromSite(n.url)).at(-1)?.status ?? null;
        ui.frameConsoleErrors = consoleErrors.filter((e) => fromSite(e.url)).map((e) => redactText(e.text).slice(0, 200));
        ui.siteOrigin = siteOrigin ? redactText(siteOrigin) : null;
        ui.studioPageErrors = studioErrors;
        evidence.ui = ui;
        evidence.jobs = collectJobs({ projectId, sinceIso: evidence.sentAt });
        evidence.credits = collectCredits({ projectId, sinceIso: evidence.sentAt });
      } finally {
        evidence.spaceSkills = spaceSkillsOf(runtimeContainers(projectId), projectId);
        writeJson(path.join(caseDir, "evidence.json"), evidence);
        // A long case can outlive its sign-in; the delete needs a live one.
        const token = await signIn(page, user!).catch(() => accessToken);
        const release = await finishCase({
          keepSpace: KEEP_SPACES,
          deleteSpace: () => deleteSpace(page.request, token, projectId),
          readState: () => readSpaceState({ projectId }),
          listContainers: () => runtimeContainers(projectId),
          stopContainers: stopRuntimeContainers,
        });
        evidence.release = release;
        evidence.stoppedContainers = release.stoppedContainers;
        writeJson(path.join(caseDir, "evidence.json"), evidence);
      }
      expect(evidence.jobs?.length ?? 0, "the send created no agent job").toBeGreaterThan(0);
    });
  }
});
