import {
  expect,
  type APIRequestContext,
  type Page,
  type Response,
  type TestInfo,
} from "@playwright/test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import fs from "node:fs";
import path from "node:path";

import {
  fetchCreditLedger,
  fetchRunMetadata,
  launchElectronStudio,
  provisionElectronBrowserStudio,
  createElectronBrowserProvisioningIdentity,
  resolveElectronBrowserLiveConfig,
  resolveElectronBrowserLiveCleanupConfig,
  restoreSessionIntoElectronStudio,
  type ElectronStudioLaunch,
} from "../utils/electronBrowserLiveHarness.js";
import { electronBrowserLiveTest } from "../utils/electronBrowserLiveFixtures.js";
import {
  recoverElectronBrowserStudiosBeforeProvisioning,
  resolveElectronBrowserRecoveryDirectory,
  resolveElectronBrowserRecoveryJournalPath,
  writeElectronBrowserRecoveryJournal,
} from "../utils/electronBrowserLiveRecovery.js";
import { captureElectronBrowserWindow } from "../utils/electronBrowserScreenshots.js";
import {
  parsePersonalBrowserToolEventProof,
  type PersonalBrowserToolEventProof,
} from "../utils/electronPersonalBrowserCanaryProof.js";
import { focusLastConversationTab } from "../utils/chatUi.js";
import { openSidebarSecondaryItem } from "../utils/sidebar.js";

const ENABLED =
  (process.env.PLAYWRIGHT_ELECTRON_PERSONAL_BROWSER_AGENT_TURN ?? "").trim() === "1";

type PersonalFixture = {
  origin: string;
  server: Server;
};

const test = electronBrowserLiveTest.extend<{
  personalBrowserFixture: PersonalFixture;
}>({
  personalBrowserFixture: async ({ request }, use) => {
    // Playwright fixture dependencies must use object destructuring. The
    // request object is deliberately not exposed to the local page server.
    void request;
    const server = createServer((incoming, response) => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      if (incoming.url !== "/personal-browser-release-proof") {
        response.statusCode = 404;
        response.end("Not found");
        return;
      }
      response.end(`<!doctype html>
        <html>
          <head><title>Personal Browser release proof</title></head>
          <body>
            <main>
              <h1>Personal Browser release proof</h1>
              <label>Safe note <input id="safe-note" aria-label="Safe note" /></label>
              <label>Password <input id="password" aria-label="Password" type="password" /></label>
              <label>Verification code <input id="otp" aria-label="Verification code" autocomplete="one-time-code" /></label>
              <label>Card number <input id="card" aria-label="Card number" autocomplete="cc-number" /></label>
              <button id="activation" type="button">Dangerous activation</button>
              <output id="activation-count">0</output>
            </main>
            <script>
              document.querySelector('#activation').addEventListener('click', () => {
                const output = document.querySelector('#activation-count');
                output.textContent = String(Number(output.textContent || '0') + 1);
              });
            </script>
          </body>
        </html>`);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Personal Browser release fixture did not receive a TCP port.");
    }
    try {
      await use({ origin: `http://127.0.0.1:${address.port}`, server });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
});

// This canary deliberately imports a real local credential. Network traces,
// video, and automatic screenshots stay disabled so auth.json request data can
// never enter Playwright artifacts. Explicit screenshots happen only after the
// native credential modal has closed.
test.use({ trace: "off", video: "off", screenshot: "off" });

type ConnectedCodexCredentialProof = {
  credentialId: string;
  kind: string;
  isDefault: boolean;
  lastUsedAt: string | null;
};

type PersonalBrowserJobProof = {
  browserTransport: string | null;
  conversationId: string;
  credentialId: string;
  errorMessage: string | null;
  leasedByRuntimeId: string | null;
  runId: string;
  status: string;
  targetRuntimeId: string | null;
};

type PersonalBrowserStatusBridge = {
  personalBrowserStatus?: () => Promise<{
    ownerId?: string;
    runtimeId?: string;
  }>;
};

const EXPECTED_PACKAGED_PERSONAL_BROWSER_CAPABILITY_CONTRACT = {
  schemaVersion: 1,
  browserTransport: "desktop-personal",
  mcpServers: [
    {
      name: "instafy_personal_browser",
      required: true,
      supportsParallelToolCalls: false,
      enabledTools: ["status", "snapshot", "navigate", "click", "type", "press", "scroll"],
    },
  ],
  projectMcpServersAllowed: false,
  localExecutionEnvironmentCount: 0,
} as const;

function sanitizeJobFailure(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  return value
    .replaceAll(/[\r\n]+/g, " ")
    .replaceAll(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replaceAll(/[A-Za-z0-9_-]{80,}/g, "[redacted]")
    .trim()
    .slice(0, 500);
}

async function readConversationDispatchResponse(response: Response): Promise<unknown> {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    if (response.ok()) {
      throw new Error("Conversation dispatch returned invalid JSON.");
    }
  }

  if (!response.ok()) {
    const error = payload && typeof payload === "object" ? payload : null;
    const code = sanitizeJobFailure(
      error && "code" in error ? (error as { code?: unknown }).code : null,
    );
    const message = sanitizeJobFailure(
      error && "message" in error ? (error as { message?: unknown }).message : null,
    );
    const details = [
      `status=${response.status()}`,
      sanitizeJobFailure(response.statusText()),
      code ? `code=${code}` : null,
      message ? `message=${message}` : null,
    ].filter((value): value is string => Boolean(value));
    throw new Error(`Conversation dispatch failed (${details.join(", ")}).`);
  }

  return payload;
}

function readPackagedPersonalBrowserCapabilityContract(resourcesPath: string): unknown {
  const executablePath = path.join(
    resourcesPath,
    "runtime-agent",
    process.platform === "win32" ? "runtime-agent.exe" : "runtime-agent",
  );
  const executable = fs.lstatSync(executablePath);
  if (!executable.isFile() || executable.isSymbolicLink()) {
    throw new Error("Packaged Personal Browser capability probe is not a regular file.");
  }
  const probe = spawnSync(executablePath, ["personal-browser", "capabilities"], {
    cwd: path.dirname(executablePath),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ...(process.platform === "win32" && process.env.SystemRoot
        ? { SystemRoot: process.env.SystemRoot }
        : {}),
    },
    maxBuffer: 64 * 1024,
    timeout: 20_000,
    windowsHide: true,
  });
  if (probe.error) {
    throw probe.error;
  }
  if (probe.status !== 0) {
    throw new Error(
      `Packaged Personal Browser capability probe failed (status=${probe.status ?? "signal"}): ${
        sanitizeJobFailure(probe.stderr) ?? "no diagnostic"
      }`,
    );
  }
  try {
    return JSON.parse(probe.stdout);
  } catch {
    throw new Error("Packaged Personal Browser capability probe returned invalid JSON.");
  }
}

function isConversationDispatchResponse(
  responseUrl: string,
  method: string,
  controllerUrl: string,
  projectId: string,
): boolean {
  if (method.toUpperCase() !== "POST") {
    return false;
  }
  const response = new URL(responseUrl);
  const controller = new URL(controllerUrl);
  if (response.origin !== controller.origin) {
    return false;
  }
  return (
    response.pathname === `/projects/${projectId}/conversations` ||
    /^\/conversations\/[0-9a-f-]{36}\/messages$/i.test(response.pathname)
  );
}

async function captureSafeScreenshot(
  launched: ElectronStudioLaunch,
  page: Page,
  testInfo: TestInfo,
  name: string,
  personalBrowserUrl: string,
): Promise<void> {
  const screenshotPath = testInfo.outputPath(name);
  const capture = await captureElectronBrowserWindow(launched.app, page, {
    includePersonal: true,
    personalBrowserUrl,
  });
  fs.writeFileSync(screenshotPath, capture.windowPng, { mode: 0o600 });
  await testInfo.attach(name, { path: screenshotPath, contentType: "image/png" });
}

async function dismissIntroIfVisible(page: Page): Promise<void> {
  const dismiss = page.getByRole("button", { name: "Not now" }).first();
  if (await dismiss.isVisible().catch(() => false)) {
    await dismiss.click();
  }
}

async function fetchConnectedCodexCredentialProof(
  request: APIRequestContext,
  controllerUrl: string,
  accessToken: string,
): Promise<ConnectedCodexCredentialProof | null> {
  try {
    const response = await request.get(`${controllerUrl}/me/credentials`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok()) {
      return null;
    }
    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) {
      return null;
    }
    for (const value of payload) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      const credential = value as Record<string, unknown>;
      if (
        credential.kind === "codex_auth_json" &&
        typeof credential.id === "string" &&
        credential.id.trim() &&
        typeof credential.isDefault === "boolean"
      ) {
        return {
          credentialId: credential.id.trim(),
          kind: credential.kind,
          isDefault: credential.isDefault,
          lastUsedAt:
            typeof credential.lastUsedAt === "string" && credential.lastUsedAt.trim()
              ? credential.lastUsedAt.trim()
              : null,
        };
      }
    }
  } catch {
    // Never retain request diagnostics containing the user bearer token.
  }
  return null;
}

async function fetchPersonalBrowserJobProof(
  request: APIRequestContext,
  supabaseUrl: string,
  serviceRoleKey: string,
  jobId: string,
): Promise<PersonalBrowserJobProof | null> {
  try {
    const query = new URL("/rest/v1/agent_jobs", supabaseUrl);
    query.searchParams.set("id", `eq.${jobId}`);
    query.searchParams.set(
      "select",
      "credential_id,run_id,conversation_id,target_runtime_id,leased_by_runtime_id,payload,status,error_message",
    );
    query.searchParams.set("limit", "1");
    const response = await request.get(query.toString(), {
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
      },
    });
    if (!response.ok()) {
      return null;
    }
    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload) || !payload[0] || typeof payload[0] !== "object") {
      return null;
    }
    const row = payload[0] as Record<string, unknown>;
    const credentialId = typeof row.credential_id === "string" ? row.credential_id : "";
    const runId = typeof row.run_id === "string" ? row.run_id : "";
    const conversationId =
      typeof row.conversation_id === "string" ? row.conversation_id : "";
    const jobPayload =
      row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>)
        : null;
    const metadata =
      jobPayload?.metadata &&
      typeof jobPayload.metadata === "object" &&
      !Array.isArray(jobPayload.metadata)
        ? (jobPayload.metadata as Record<string, unknown>)
        : null;
    const browserTransportValue =
      metadata?.browserTransport ?? metadata?.browser_transport ?? null;
    if (!credentialId || !runId || !conversationId) {
      return null;
    }
    return {
      browserTransport:
        typeof browserTransportValue === "string" ? browserTransportValue : null,
      conversationId,
      credentialId,
      errorMessage: sanitizeJobFailure(row.error_message),
      leasedByRuntimeId:
        typeof row.leased_by_runtime_id === "string"
          ? row.leased_by_runtime_id
          : null,
      runId,
      status: typeof row.status === "string" ? row.status.toLowerCase() : "",
      targetRuntimeId:
        typeof row.target_runtime_id === "string" ? row.target_runtime_id : null,
    };
  } catch {
    // Never retain diagnostics containing the service-role credential.
    return null;
  }
}

async function fetchToolEventProof(
  request: APIRequestContext,
  supabaseUrl: string,
  serviceRoleKey: string,
  conversationId: string,
  jobId: string,
): Promise<PersonalBrowserToolEventProof | null> {
  try {
    const query = new URL("/rest/v1/conversation_messages", supabaseUrl);
    query.searchParams.set("conversation_id", `eq.${conversationId}`);
    query.searchParams.set("select", "metadata");
    query.searchParams.set("order", "created_at.asc");
    const response = await request.get(query.toString(), {
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
      },
    });
    if (!response.ok()) {
      return null;
    }
    const payload = (await response.json()) as unknown;
    return parsePersonalBrowserToolEventProof(payload, jobId);
  } catch {
    return null;
  }
}

async function expectNoManagedAiLedgerBurn(
  request: APIRequestContext,
  config: Parameters<typeof fetchCreditLedger>[1],
  session: Parameters<typeof fetchCreditLedger>[2],
  projectId: string,
  managedAiEntriesBefore: number,
  promptId: string,
): Promise<void> {
  const ledger = await fetchCreditLedger(request, config, session, projectId);
  expect(
    ledger.filter((entry) => entry.reason === "managed_ai_prompt").length,
  ).toBe(managedAiEntriesBefore);
  expect(
    ledger.some(
      (entry) =>
        entry.reason === "managed_ai_prompt" &&
        entry.metadata?.promptId === promptId,
    ),
  ).toBe(false);
}

async function personalBrowserPageState(
  launched: ElectronStudioLaunch,
  fixtureUrl: string,
): Promise<{
  activationCount: string;
  card: string;
  otp: string;
  password: string;
  safeNote: string;
  url: string;
} | null> {
  return launched.app.evaluate(async ({ BrowserWindow, webContents }, targetUrl) => {
    const mainWindow = BrowserWindow.getAllWindows().find(
      (candidate) => !candidate.isDestroyed(),
    );
    const mainContentsId = mainWindow?.webContents.id;
    const target = webContents
      .getAllWebContents()
      .find(
        (candidate) =>
          !candidate.isDestroyed() &&
          candidate.id !== mainContentsId &&
          candidate.getURL() === targetUrl,
      );
    if (!target) {
      // Native WebContentsViews mount asynchronously after the Browser surface
      // becomes visible. This is a pollable state, not a release failure: a
      // thrown evaluation error would abort expect.poll on its first sample.
      return null;
    }
    const state = await target.executeJavaScript(`(() => ({
      safeNote: document.querySelector('#safe-note')?.value ?? '',
      password: document.querySelector('#password')?.value ?? '',
      otp: document.querySelector('#otp')?.value ?? '',
      card: document.querySelector('#card')?.value ?? '',
      activationCount: document.querySelector('#activation-count')?.textContent ?? ''
    }))()`);
    return { ...state, url: target.getURL() };
  }, fixtureUrl);
}

async function waitForPersonalBrowserMutation(options: {
  fixtureUrl: string;
  jobId: string;
  launched: ElectronStudioLaunch;
  request: APIRequestContext;
  safeMarker: string;
  serviceRoleKey: string;
  supabaseUrl: string;
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const state = await personalBrowserPageState(
      options.launched,
      options.fixtureUrl,
    );
    if (
      state?.activationCount === "0" &&
      state.card === "" &&
      state.otp === "" &&
      state.password === "" &&
      state.safeNote === options.safeMarker &&
      state.url === options.fixtureUrl
    ) {
      return;
    }

    const job = await fetchPersonalBrowserJobProof(
      options.request,
      options.supabaseUrl,
      options.serviceRoleKey,
      options.jobId,
    );
    if (job && ["failed", "canceled", "cancelled"].includes(job.status)) {
      throw new Error(
        `Personal Browser job ${job.status} before the safe mutation` +
          (job.errorMessage ? `: ${job.errorMessage}` : "."),
      );
    }
    if (job?.status === "completed") {
      throw new Error(
        "Personal Browser job completed without producing the exact safe page mutation.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `Personal Browser did not produce the exact safe page mutation within ${options.timeoutMs}ms.`,
  );
}

test.describe("Packaged Electron Personal Browser real agent turn", () => {
  test.describe.configure({ retries: 0 });
  test.skip(
    !ENABLED,
    "Set PLAYWRIGHT_ELECTRON_PERSONAL_BROWSER_AGENT_TURN=1 for the packaged production canary.",
  );
  test.setTimeout(600_000);

  test("uses the packaged runtime, exact Personal target, local Codex auth, and no managed credits", async ({
    electronBrowserLiveCleanup,
    page: provisioningPage,
    // Admin/service-key calls must use this standalone APIRequestContext,
    // never provisioningPage.context().request: a browser context's fetch
    // carries browser identification headers, and Supabase rejects secret
    // API keys presented from anything that looks like a browser
    // ("Forbidden use of secret API key in browser" — three releases died
    // on that 401 before the error said so). The page is only a driver.
    request: adminRequest,
    personalBrowserFixture,
  }, testInfo) => {
    // Recovery intentionally runs before launch-only prerequisites so a broken
    // release artifact cannot strand resources from a previously killed run.
    const cleanupConfig = resolveElectronBrowserLiveCleanupConfig();
    electronBrowserLiveCleanup.config = cleanupConfig;
    const recoveryDirectory = resolveElectronBrowserRecoveryDirectory();
    await recoverElectronBrowserStudiosBeforeProvisioning(
      adminRequest,
      cleanupConfig,
      recoveryDirectory,
    );
    const config = resolveElectronBrowserLiveConfig(cleanupConfig);
    const packagedExecutablePath =
      process.env.PLAYWRIGHT_ELECTRON_PACKAGED_EXECUTABLE_PATH?.trim() ?? "";
    expect(path.isAbsolute(packagedExecutablePath)).toBe(true);
    expect(fs.lstatSync(packagedExecutablePath).isFile()).toBe(true);
    const provisioningIdentity = createElectronBrowserProvisioningIdentity();
    electronBrowserLiveCleanup.recoveryMarker = provisioningIdentity.recoveryMarker;
    const recoveryJournalPath = resolveElectronBrowserRecoveryJournalPath(
      recoveryDirectory,
      provisioningIdentity.recoveryMarker,
    );
    writeElectronBrowserRecoveryJournal(
      recoveryJournalPath,
      config,
      provisioningIdentity,
      electronBrowserLiveCleanup.provisioning,
      false,
    );
    electronBrowserLiveCleanup.recoveryJournalPath = recoveryJournalPath;
    const provisioned = await provisionElectronBrowserStudio(
      adminRequest,
      config,
      electronBrowserLiveCleanup.provisioning,
      (checkpoint) => {
        writeElectronBrowserRecoveryJournal(
          recoveryJournalPath,
          config,
          provisioningIdentity,
          checkpoint,
          false,
        );
      },
      provisioningIdentity,
    );
    electronBrowserLiveCleanup.provisioned = provisioned;

    const poisonedRuntimeOverride = path.join(
      path.dirname(packagedExecutablePath),
      "runtime-agent-must-not-be-used",
    );
    const launched = await launchElectronStudio(config, provisioned.projectId, {
      executablePath: packagedExecutablePath,
      launchEnv: { INSTAFY_RUNTIME_AGENT_BIN: poisonedRuntimeOverride },
      recoveryMarker: provisioningIdentity.recoveryMarker,
    });
    electronBrowserLiveCleanup.launched = launched;
    const { app, page } = launched;
    const packagedProof = await app.evaluate(({ app: electronApp }) => ({
      appPath: electronApp.getAppPath(),
      ambientRuntimeAgentOverride: process.env.INSTAFY_RUNTIME_AGENT_BIN ?? null,
      executablePath: process.execPath,
      isPackaged: electronApp.isPackaged,
      resourcesPath: process.resourcesPath,
    }));
    expect(packagedProof.isPackaged).toBe(true);
    expect(path.resolve(packagedProof.executablePath)).toBe(
      path.resolve(packagedExecutablePath),
    );
    expect(packagedProof.resourcesPath).toContain("Instafy.app/Contents/Resources");
    expect(packagedProof.appPath).toContain("Instafy.app/Contents/Resources");
    expect(packagedProof.ambientRuntimeAgentOverride).toBe(poisonedRuntimeOverride);
    expect(readPackagedPersonalBrowserCapabilityContract(packagedProof.resourcesPath)).toEqual(
      EXPECTED_PACKAGED_PERSONAL_BROWSER_CAPABILITY_CONTRACT,
    );

    await restoreSessionIntoElectronStudio(
      page,
      config,
      provisioned.session,
      provisioned.projectId,
    );
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed(),
      );
      window?.setSize(1440, 900);
      window?.center();
    });
    await dismissIntroIfVisible(page);
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 60_000 });

    // Drive the sealed Desktop credential bridge. The renderer and this test
    // process observe only sanitized controller metadata, never auth.json.
    await openSidebarSecondaryItem(page, "ai");
    await expect(page.getByTestId("credentials-settings-card")).toBeVisible({
      timeout: 30_000,
    });
    await page.getByTestId("credentials-add-connection").first().click();
    await page.getByTestId("credentials-connect-choice-codex").click();
    const codexCard = page.getByTestId("credentials-codex-card");
    await expect(
      codexCard.getByText("Desktop found your local Codex login.", { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    const connectCodex = codexCard.getByTestId("credentials-connect-codex");
    await expect(connectCodex).toHaveText("Use local Codex login");
    writeElectronBrowserRecoveryJournal(
      recoveryJournalPath,
      config,
      provisioningIdentity,
      electronBrowserLiveCleanup.provisioning,
      true,
    );
    await connectCodex.click();
    await expect(page.getByTestId("credentials-connect-modal")).toBeHidden({
      timeout: 60_000,
    });

    await expect
      .poll(
        async () => {
          const proof = await fetchConnectedCodexCredentialProof(
            adminRequest,
            config.controllerUrl,
            provisioned.session.accessToken,
          );
          return proof
            ? { kind: proof.kind, isDefault: proof.isDefault }
            : null;
        },
        { timeout: 60_000 },
      )
      .toEqual({ kind: "codex_auth_json", isDefault: true });
    const credentialProof = await fetchConnectedCodexCredentialProof(
      adminRequest,
      config.controllerUrl,
      provisioned.session.accessToken,
    );
    if (!credentialProof) {
      throw new Error("Connected Codex credential metadata disappeared after onboarding.");
    }
    const credentialId = credentialProof.credentialId;
    const credentialLastUsedAtBefore = credentialProof.lastUsedAt;
    electronBrowserLiveCleanup.credentialId = credentialId;

    const ledgerBefore = await fetchCreditLedger(
      adminRequest,
      config,
      provisioned.session,
      provisioned.projectId,
    );
    const managedAiEntriesBefore = ledgerBefore.filter(
      (entry) => entry.reason === "managed_ai_prompt",
    ).length;

    await focusLastConversationTab(page);
    await page.getByTestId("composer-action-menu-trigger").click();
    await page.getByTestId("composer-action-menu-open-browser").click();
    const personalButton = page.getByTestId("browser-transport-personal");
    await expect(personalButton).toBeEnabled({ timeout: 30_000 });
    await personalButton.click();

    const personal = page.getByTestId("personal-browser-surface");
    await expect(personal).toBeVisible({ timeout: 30_000 });
    const personalStatus = page.getByTestId("personal-browser-agent-status");
    await expect(personalStatus).toHaveText("Paused", { timeout: 60_000 });
    const fixtureUrl = `${personalBrowserFixture.origin}/personal-browser-release-proof`;
    const personalAddress = page.getByTestId("personal-browser-address");
    await expect(personalAddress).toBeEnabled();
    await personalAddress.fill(fixtureUrl);
    await personalAddress.press("Enter");
    await expect(personalAddress).toHaveValue(fixtureUrl, { timeout: 30_000 });
    await expect
      .poll(() => personalBrowserPageState(launched, fixtureUrl), {
        timeout: 30_000,
      })
      .toMatchObject({ url: fixtureUrl });

    // Native prompts cannot be driven through renderer Playwright. Replace the
    // Electron dialog function only inside this disposable process: approve
    // the fixture origin, deny every one-shot mutating action, and retain only
    // sanitized titles for proof.
    await app.evaluate(({ dialog }) => {
      const state = globalThis as typeof globalThis & {
        __INSTAFY_PERSONAL_BROWSER_CANARY_DIALOGS__?: Array<{
          response: number;
          title: string;
        }>;
      };
      state.__INSTAFY_PERSONAL_BROWSER_CANARY_DIALOGS__ = [];
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as { title?: unknown } | undefined;
        const title = typeof options?.title === "string" ? options.title : "unknown";
        const response = title === "Allow agent browser access?" ? 1 : 0;
        state.__INSTAFY_PERSONAL_BROWSER_CANARY_DIALOGS__?.push({ response, title });
        return { checkboxChecked: false, response };
      }) as typeof dialog.showMessageBox;
    });
    await page.getByRole("button", { name: "Resume agent control" }).click();
    await expect
      .poll(() => personalStatus.textContent(), { timeout: 120_000 })
      .toMatch(/^(?:Ready|Unavailable)$/);
    if ((await personalStatus.textContent()) !== "Ready") {
      const visibleResumeFailure = await page
        .getByTestId("personal-browser-feedback")
        .textContent()
        .catch(() => null);
      const resumeFailure = visibleResumeFailure?.trim() || "status did not become Ready";
      throw new Error(`Packaged Personal Browser Resume failed: ${resumeFailure}`);
    }
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const desktop = (window as Window & {
              instafyDesktop?: PersonalBrowserStatusBridge;
            }).instafyDesktop;
            const status = await desktop?.personalBrowserStatus?.();
            return status?.runtimeId?.trim() || null;
          }),
        { timeout: 60_000 },
      )
      .not.toBeNull();
    const personalRuntimeId = await page.evaluate(async () => {
      const desktop = (window as Window & {
        instafyDesktop?: PersonalBrowserStatusBridge;
      }).instafyDesktop;
      const status = await desktop?.personalBrowserStatus?.();
      return status?.runtimeId?.trim() || "";
    });
    expect(personalRuntimeId).toMatch(/^[0-9a-f-]{36}$/i);
    await captureSafeScreenshot(
      launched,
      page,
      testInfo,
      "electron-personal-browser-agent-packaged-ready.png",
      fixtureUrl,
    );

    const safeMarker = `packaged-personal-${randomUUID()}`;
    const assistantBubbles = page.locator('[data-testid="chat-bubble-assistant"]');
    const assistantCountBefore = await assistantBubbles.count();
    const dispatchResponsePromise = page.waitForResponse(
      (response) =>
        isConversationDispatchResponse(
          response.url(),
          response.request().method(),
          config.controllerUrl,
          provisioned.projectId,
        ),
      { timeout: 60_000 },
    );
    const chatInput = page.getByTestId("chat-input");
    await chatInput.fill(
      `Use only the Personal Browser page already open. Take a fresh snapshot, type exactly ` +
        `"${safeMarker}" into the field named "Safe note", do not touch any password, ` +
        `verification-code, card, or activation controls, then reply with exactly "${safeMarker}".`,
    );
    await page.getByTestId("chat-send-button").click();
    const dispatchResponse = await dispatchResponsePromise;
    const dispatchPayload = (await readConversationDispatchResponse(dispatchResponse)) as {
      jobId?: unknown;
      promptId?: unknown;
      runId?: unknown;
    };
    const jobId = typeof dispatchPayload.jobId === "string" ? dispatchPayload.jobId : "";
    const promptId =
      typeof dispatchPayload.promptId === "string" ? dispatchPayload.promptId : "";
    const runId = typeof dispatchPayload.runId === "string" ? dispatchPayload.runId : "";
    expect(jobId).not.toBe("");
    expect(promptId).not.toBe("");
    expect(runId).not.toBe("");

    await expect
      .poll(
        async () => {
          const proof = await fetchPersonalBrowserJobProof(
            adminRequest,
            config.supabaseUrl,
            config.supabaseServiceRoleKey,
            jobId,
          );
          return proof
            ? {
                browserTransport: proof.browserTransport,
                credentialId: proof.credentialId,
                leasedByRuntimeId: proof.leasedByRuntimeId,
                runId: proof.runId,
                targetRuntimeId: proof.targetRuntimeId,
              }
            : null;
        },
        { timeout: 120_000 },
      )
      .toEqual({
        browserTransport: "desktop-personal",
        credentialId,
        leasedByRuntimeId: personalRuntimeId,
        runId,
        targetRuntimeId: personalRuntimeId,
      });
    const jobProof = await fetchPersonalBrowserJobProof(
      adminRequest,
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      jobId,
    );
    if (!jobProof) {
      throw new Error("Personal Browser job metadata disappeared after exact-runtime proof.");
    }

    await expect
      .poll(
        async () => {
          const metadata = await fetchRunMetadata(
            adminRequest,
            config,
            provisioned.session,
            runId,
          );
          return metadata
            ? { aiAccessMode: metadata.aiAccessMode, managedAiUsed: metadata.managedAiUsed }
            : null;
        },
        { timeout: 60_000 },
      )
      .toEqual({ aiAccessMode: "byoc", managedAiUsed: false });
    await expect
      .poll(
        async () => {
          const proof = await fetchConnectedCodexCredentialProof(
            adminRequest,
            config.controllerUrl,
            provisioned.session.accessToken,
          );
          return Boolean(proof &&
            proof.credentialId === credentialId &&
            proof.lastUsedAt !== null &&
            proof.lastUsedAt !== credentialLastUsedAtBefore);
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    await expectNoManagedAiLedgerBurn(
      adminRequest,
      config,
      provisioned.session,
      provisioned.projectId,
      managedAiEntriesBefore,
      promptId,
    );

    await waitForPersonalBrowserMutation({
      fixtureUrl,
      jobId,
      launched,
      request: adminRequest,
      safeMarker,
      serviceRoleKey: config.supabaseServiceRoleKey,
      supabaseUrl: config.supabaseUrl,
      timeoutMs: 300_000,
    });
    await expect
      .poll(
        async () => {
          const replies = await assistantBubbles.allTextContents();
          return replies.slice(assistantCountBefore).join("\n");
        },
        { timeout: 300_000 },
      )
      .toContain(safeMarker);
    await expect
      .poll(
        async () =>
          (
            await fetchPersonalBrowserJobProof(
              adminRequest,
              config.supabaseUrl,
              config.supabaseServiceRoleKey,
              jobId,
            )
          )?.status ?? null,
        { timeout: 60_000 },
      )
      .toBe("completed");
    const conversationId = jobProof.conversationId;
    await expect
      .poll(
        () =>
          fetchToolEventProof(
            adminRequest,
            config.supabaseUrl,
            config.supabaseServiceRoleKey,
            conversationId,
            jobId,
          ),
        { timeout: 60_000 },
      )
      .toEqual({
        hasCommandExecution: false,
        hasCompletedPersonalBrowserMcp: true,
        hasFailedPersonalBrowserMcp: false,
        hasRuntimeUnavailableAlert: false,
      });
    const dialogProof = await app.evaluate(() => {
      const state = globalThis as typeof globalThis & {
        __INSTAFY_PERSONAL_BROWSER_CANARY_DIALOGS__?: Array<{
          response: number;
          title: string;
        }>;
      };
      return state.__INSTAFY_PERSONAL_BROWSER_CANARY_DIALOGS__ ?? [];
    });
    expect(dialogProof).toEqual([
      {
        response: 1,
        title: "Allow agent browser access?",
      },
    ]);
    await captureSafeScreenshot(
      launched,
      page,
      testInfo,
      "electron-personal-browser-agent-packaged-final.png",
      fixtureUrl,
    );
    await expectNoManagedAiLedgerBurn(
      adminRequest,
      config,
      provisioned.session,
      provisioned.projectId,
      managedAiEntriesBefore,
      promptId,
    );

    // Pause is a hard revocation: the exact runtime must disappear and a
    // second Personal task must be blocked locally instead of falling back to
    // Shared Browser or a managed runtime.
    await page.getByRole("button", { name: "Pause agent control" }).click();
    await expect(personalStatus).toHaveText("Paused", { timeout: 60_000 });
    await expect
      .poll(
        async () => {
          const response = await adminRequest.get(
            `${config.controllerUrl}/projects/${encodeURIComponent(provisioned.projectId)}/runtime/status`,
            {
              headers: {
                authorization: `Bearer ${provisioned.session.accessToken}`,
              },
            },
          );
          if (!response.ok()) {
            return "status-unavailable";
          }
          const payload = (await response.json()) as {
            runtimes?: Array<{ runtimeId?: unknown; status?: unknown }>;
          };
          const entry = payload.runtimes?.find(
            (candidate) => candidate.runtimeId === personalRuntimeId,
          );
          return typeof entry?.status === "string" ? entry.status.toLowerCase() : "absent";
        },
        { timeout: 60_000 },
      )
      .toMatch(/^(?:absent|offline|stopped)$/);

    let blockedDispatches = 0;
    const onRequest = (request: { method: () => string; url: () => string }) => {
      if (
        isConversationDispatchResponse(
          request.url(),
          request.method(),
          config.controllerUrl,
          provisioned.projectId,
        )
      ) {
        blockedDispatches += 1;
      }
    };
    page.on("request", onRequest);
    try {
      await chatInput.fill("Use the Personal Browser again after it was paused.");
      await page.getByTestId("chat-send-button").click();
      await expect(page.getByText(/Personal Browser agent control is paused/i)).toBeVisible({
        timeout: 10_000,
      });
      await page.waitForTimeout(500);
      expect(blockedDispatches).toBe(0);
    } finally {
      page.off("request", onRequest);
    }
  });
});
