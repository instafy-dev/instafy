import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";
import {
  clearRuntimePreference,
  ensureRealDefaultCodexCredentialWhenRequired,
  getSupabaseAuthHeaders,
  getSupabaseUrl,
  prepareStudio,
  requestHostedRuntime,
  selectPrimaryAgentModel,
  waitForHostedRuntimeReady,
} from "../utils/harness.js";
import { ensureProjectCreditsReadyForChat } from "../utils/projectCredits.js";

const AUTOMATION_MODEL =
  (process.env.PLAYWRIGHT_AUTOMATION_MODEL ?? process.env.PLAYWRIGHT_LEARN_MODEL ?? "gpt-5.5").trim() ||
  "gpt-5.5";
const LIVE_CHAT_AUTOMATIONS_ENABLED = (process.env.PLAYWRIGHT_LIVE_CHAT_AUTOMATIONS ?? "").trim() === "1";

async function ensureHostedRuntimeReady(page: Page, projectId: string) {
  const ready = await waitForHostedRuntimeReady(page, 10_000).then(() => true).catch(() => false);
  if (!ready) {
    await requestHostedRuntime(page, { projectId }).catch(() => {});
  }
  await waitForHostedRuntimeReady(page, 120_000);
  await page.getByTestId("chat-input").fill("Ready check");
  await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId("chat-input").fill("");
}

type AutomationRow = {
  id: string;
  projectId: string;
  name: string;
  timezone: string;
  status: string;
  scheduleKind: string;
  byDay: string[];
  byHour: number | null;
  byMinute: number | null;
  createdAt: string;
  runAt: string | null;
};

async function fetchLatestAutomationByNameSince(
  name: string,
  createdAfterIso: string,
): Promise<AutomationRow | null> {
  const supabaseUrl = getSupabaseUrl().trim();
  const headers = getSupabaseAuthHeaders();
  if (!supabaseUrl || !headers.authorization || !headers.apikey) {
    throw new Error("Supabase service-role access is required for chat automation Playwright tests.");
  }

  const params = new URLSearchParams({
    select:
      "id,project_id,name,timezone,status,schedule_kind,by_day,by_hour,by_minute,created_at,run_at",
    name: `eq.${name}`,
    created_at: `gte.${createdAfterIso}`,
    order: "created_at.desc",
    limit: "1",
  });
  const response = await fetch(`${supabaseUrl}/rest/v1/automations?${params.toString()}`, {
    headers,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Failed to query automations (${response.status} ${response.statusText}): ${body}`);
  }

  const rows = (await response.json().catch(() => [])) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row || typeof row !== "object") {
    return null;
  }

  const id = typeof row.id === "string" ? row.id : "";
  const projectId = typeof row.project_id === "string" ? row.project_id : "";
  const rowName = typeof row.name === "string" ? row.name : "";
  const timezone = typeof row.timezone === "string" ? row.timezone : "";
  const status = typeof row.status === "string" ? row.status : "";
  const scheduleKind = typeof row.schedule_kind === "string" ? row.schedule_kind : "";
  const byDay = Array.isArray(row.by_day)
    ? row.by_day.map((value) => String(value).trim()).filter(Boolean)
    : [];
  const byHour =
    typeof row.by_hour === "number" ? row.by_hour : typeof row.by_hour === "string" && row.by_hour ? Number(row.by_hour) : null;
  const byMinute =
    typeof row.by_minute === "number"
      ? row.by_minute
      : typeof row.by_minute === "string" && row.by_minute
        ? Number(row.by_minute)
        : null;
  const createdAt = typeof row.created_at === "string" ? row.created_at : "";
  const runAt = typeof row.run_at === "string" && row.run_at ? row.run_at : null;

  return {
    id,
    projectId,
    name: rowName,
    timezone,
    status,
    scheduleKind,
    byDay,
    byHour,
    byMinute,
    createdAt,
    runAt,
  };
}

test.describe("Chat automation creation", () => {
  test.skip(
    (process.env.PLAYWRIGHT_SKIP_CODEX ?? "").trim() === "1",
    "Codex backend unavailable (rate limited). Provide Codex auth (OPENAI_API_KEY or tmp/proxy-codex/auth.json).",
  );

  test("creates a daily automation from chat in the local timezone", async ({ page }) => {
    test.setTimeout(240_000);

    const projectId = await prepareStudio(page, { waitForHostedRuntime: false });
    if (!projectId) {
      throw new Error("Project id missing for chat automation test.");
    }
    await ensureRealDefaultCodexCredentialWhenRequired(page);

    await page.getByTestId("sidebar-nav-chat").click();
    await clearRuntimePreference(page, { projectId, source: "chat-automations" }).catch(() => {});
    await ensureHostedRuntimeReady(page, projectId);
    await selectPrimaryAgentModel(page, AUTOMATION_MODEL);
    await ensureProjectCreditsReadyForChat(page, projectId);

    const timezone = await page.evaluate(() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      } catch {
        return "UTC";
      }
    });
    const createdAfterIso = new Date().toISOString();
    const automationName = `Morning random number ${randomUUID().slice(0, 8)}`;

    await page
      .getByTestId("chat-input")
      .fill(
        `Use the Instafy CLI in the hosted runtime to create a recurring automation named "${automationName}". Run the equivalent of: instafy automations create --name "${automationName}" --prompt "Generate one random integer between 1 and 100." --schedule-kind weekly --days mo,tu,we,th,fr,sa,su --time 08:00 --timezone "${timezone}".`,
      );
    await expect(page.getByTestId("chat-send-button")).toBeEnabled();
    await page.getByTestId("chat-send-button").click();

    await expect
      .poll(() => fetchLatestAutomationByNameSince(automationName, createdAfterIso), {
        timeout: 180_000,
      })
      .toMatchObject({
        name: automationName,
        timezone,
        status: "active",
        scheduleKind: "weekly",
        byHour: 8,
        byMinute: 0,
      });

    const latest = await fetchLatestAutomationByNameSince(automationName, createdAfterIso);
    expect(latest?.projectId).toBe(projectId);
    expect([...(latest?.byDay ?? [])].sort()).toEqual(["fr", "mo", "sa", "su", "th", "tu", "we"]);
  });

  test("creates a one-shot reminder from natural language using the local timezone", async ({ page }) => {
    test.setTimeout(300_000);
    test.skip(
      !LIVE_CHAT_AUTOMATIONS_ENABLED,
      "Natural-language one-shot automation coverage is opt-in with PLAYWRIGHT_LIVE_CHAT_AUTOMATIONS=1.",
    );

    const projectId = await prepareStudio(page, { waitForHostedRuntime: false });
    if (!projectId) {
      throw new Error("Project id missing for one-shot automation test.");
    }
    await ensureRealDefaultCodexCredentialWhenRequired(page);

    await page.getByTestId("sidebar-nav-chat").click();
    await clearRuntimePreference(page, { projectId, source: "chat-automations-once" }).catch(() => {});
    await ensureHostedRuntimeReady(page, projectId);
    await selectPrimaryAgentModel(page, AUTOMATION_MODEL);
    await ensureProjectCreditsReadyForChat(page, projectId);

    const timezone = await page.evaluate(() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      } catch {
        return "UTC";
      }
    });
    const createdAfterIso = new Date().toISOString();
    const automationName = `Laundry reminder ${randomUUID().slice(0, 8)}`;

    await page
      .getByTestId("chat-input")
      .fill(
        `Use Instafy's automation feature in chat to create a one-shot automation called ${automationName}. It should remind me to take the laundry out 10 minutes from now in timezone ${timezone}.`,
      );
    await expect(page.getByTestId("chat-send-button")).toBeEnabled();
    await page.getByTestId("chat-send-button").click();

    await expect
      .poll(() => fetchLatestAutomationByNameSince(automationName, createdAfterIso), {
        timeout: 240_000,
      })
      .toMatchObject({
        name: automationName,
        timezone,
        status: "active",
        scheduleKind: "once",
      });

    const latest = await fetchLatestAutomationByNameSince(automationName, createdAfterIso);
    expect(latest?.projectId).toBe(projectId);
    expect(latest?.runAt).toBeTruthy();
    const runAtMs = new Date(latest?.runAt ?? "").getTime();
    const createdAfterMs = new Date(createdAfterIso).getTime();
    const deltaMinutes = (runAtMs - createdAfterMs) / 60_000;
    expect(deltaMinutes).toBeGreaterThanOrEqual(8);
    expect(deltaMinutes).toBeLessThanOrEqual(20);
  });
});
