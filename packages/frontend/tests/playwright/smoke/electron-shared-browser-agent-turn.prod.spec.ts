import {
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
  type Response,
  type TestInfo,
  type WebSocket,
} from "@playwright/test";

import { parseSharedBrowserCollaborationServerMessage } from "../../../src/screens/studio/components/sharedBrowserCollaboration.js";

import {
  browserActionsShowClickThenNavigationToHost,
  fetchCreditLedger,
  fetchRunMetadata,
  launchElectronStudio,
  provisionElectronBrowserStudio,
  createElectronBrowserProvisioningIdentity,
  remoteSurfaceHasRenderedFrame,
  resolveElectronBrowserLiveConfig,
  resolveElectronBrowserLiveCleanupConfig,
  restoreSessionIntoElectronStudio,
  type BrowserActionProofEvent,
} from "../utils/electronBrowserLiveHarness.js";
import { electronBrowserLiveTest as test } from "../utils/electronBrowserLiveFixtures.js";
import {
  recoverElectronBrowserStudiosBeforeProvisioning,
  resolveElectronBrowserRecoveryDirectory,
  resolveElectronBrowserRecoveryJournalPath,
  writeElectronBrowserRecoveryJournal,
} from "../utils/electronBrowserLiveRecovery.js";
import { focusLastConversationTab } from "../utils/chatUi.js";
import { openSidebarSecondaryItem } from "../utils/sidebar.js";

const ENABLED =
  (process.env.PLAYWRIGHT_ELECTRON_SHARED_BROWSER_AGENT_TURN ?? "").trim() === "1";
const EXPECTED_SHARED_BROWSER_VIEWER =
  (process.env.PLAYWRIGHT_EXPECT_SHARED_BROWSER_VIEWER ?? "cdp-screencast").trim() ||
  "cdp-screencast";
// This test deliberately imports a real local credential. Network traces and
// automatic media are disabled so the auth.json request body can never land in
// Playwright artifacts. The four screenshots are taken only after onboarding
// has closed; the credential contents are never displayed or read by test code.
test.use({ trace: "off", video: "off", screenshot: "off" });

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
  if (response.pathname === `/projects/${projectId}/conversations`) {
    return true;
  }
  return /^\/conversations\/[0-9a-f-]{36}\/messages$/i.test(response.pathname);
}

function isBrowserPageCommandResponse(response: Response): boolean {
  if (response.request().method().toUpperCase() !== "POST") {
    return false;
  }
  try {
    const pathname = new URL(response.url()).pathname;
    return pathname.includes("/browser/pages/") && pathname.endsWith("/command");
  } catch {
    return false;
  }
}

async function captureAfterOnboarding(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<string> {
  const screenshotPath = testInfo.outputPath(name);
  await page.screenshot({ path: screenshotPath });
  await testInfo.attach(name, { path: screenshotPath, contentType: "image/png" });
  return screenshotPath;
}

type BrowserActionResponseCollector = {
  actions: () => Promise<BrowserActionProofEvent[]>;
  stop: () => Promise<void>;
};

type SharedBrowserServerControlOwnerKind = "agent" | "human" | "none";

type SharedBrowserServerControlCollector = {
  agentReturnedToHuman: () => boolean;
  protocolValid: () => boolean;
  sawAgent: () => boolean;
  stop: () => void;
};

function startSharedBrowserServerControlCollector(
  page: Page,
): SharedBrowserServerControlCollector {
  const frameListeners = new Map<
    WebSocket,
    (data: { payload: string | Buffer }) => void
  >();
  const maxCollaborationSockets = 8;
  let collaborationSocketCount = 0;
  let overflowed = false;
  let latestRevision = -1;
  let latestOwner: SharedBrowserServerControlOwnerKind | null = null;
  let sawAgent = false;
  let agentReturnedToHuman = false;

  const onWebSocket = (socket: WebSocket) => {
    let pathname = "";
    try {
      pathname = new URL(socket.url()).pathname;
    } catch {
      return;
    }
    if (!pathname.endsWith("/browser/collaboration")) {
      return;
    }
    collaborationSocketCount += 1;
    if (collaborationSocketCount > maxCollaborationSockets) {
      overflowed = true;
      return;
    }
    const onFrame = ({ payload }: { payload: string | Buffer }) => {
      const message = parseSharedBrowserCollaborationServerMessage(String(payload));
      if (
        message?.type !== "state" ||
        message.revision <= latestRevision
      ) {
        return;
      }
      latestRevision = message.revision;
      latestOwner = message.controlOwner?.kind ?? "none";
      if (latestOwner === "agent") {
        sawAgent = true;
      } else if (latestOwner === "human" && sawAgent) {
        agentReturnedToHuman = true;
      }
    };
    frameListeners.set(socket, onFrame);
    socket.on("framereceived", onFrame);
  };
  page.on("websocket", onWebSocket);

  return {
    sawAgent: () => sawAgent && !overflowed,
    agentReturnedToHuman: () => agentReturnedToHuman && !overflowed,
    protocolValid: () => !overflowed && latestRevision >= 0 && latestOwner !== null,
    stop: () => {
      page.off("websocket", onWebSocket);
      for (const [socket, listener] of frameListeners) {
        socket.off("framereceived", listener);
      }
      frameListeners.clear();
    },
  };
}

function startBrowserActionResponseCollector(page: Page): BrowserActionResponseCollector {
  const observed: Array<BrowserActionProofEvent & { batch: number; row: number }> = [];
  const pending = new Set<Promise<void>>();
  let nextBatch = 0;

  const onResponse = (response: Response) => {
    let responseUrl: URL;
    try {
      responseUrl = new URL(response.url());
    } catch {
      return;
    }
    if (
      response.request().method().toUpperCase() !== "GET" ||
      !responseUrl.pathname.endsWith("/browser/actions")
    ) {
      return;
    }

    const batch = nextBatch++;
    const task = (async () => {
      try {
        if (!response.ok()) {
          return;
        }
        const payload = (await response.json()) as { actions?: unknown };
        if (!Array.isArray(payload.actions)) {
          return;
        }
        payload.actions.forEach((entry, row) => {
          if (!entry || typeof entry !== "object") {
            return;
          }
          const action = entry as Record<string, unknown>;
          const type = typeof action.type === "string" ? action.type.trim() : "";
          if (!type) {
            return;
          }
          observed.push({
            batch,
            row,
            type,
            url:
              typeof action.url === "string" && action.url.trim()
                ? action.url.trim()
                : null,
          });
        });
      } catch {
        // A concurrent browser-session reset can make an in-flight response
        // unreadable. Later polls still provide the proof sequence.
      }
    })();
    pending.add(task);
    void task.then(() => pending.delete(task));
  };

  const flush = async () => {
    while (pending.size > 0) {
      await Promise.all([...pending]);
    }
  };
  const actions = async () => {
    await flush();
    return observed
      .slice()
      .sort((left, right) => left.batch - right.batch || left.row - right.row)
      .map(({ type, url }) => ({ type, url }));
  };

  page.on("response", onResponse);
  return {
    actions,
    stop: async () => {
      page.off("response", onResponse);
      await flush();
    },
  };
}

function startCursorScreenshotCapture(
  page: Page,
  testInfo: TestInfo,
  timeoutMs: number,
): { cancel: () => void; promise: Promise<string | null> } {
  const cursor = page.getByTestId("browser-cursor");
  const ticker = page.getByTestId("browser-action-ticker");
  let cancelled = false;
  let wakePoll: (() => void) | null = null;

  const waitForNextPoll = () =>
    new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        wakePoll = null;
        resolve();
      };
      const timer = setTimeout(finish, 100);
      wakePoll = () => {
        clearTimeout(timer);
        finish();
      };
    });

  const promise = (async () => {
    const deadline = Date.now() + timeoutMs;
    while (!cancelled && Date.now() < deadline) {
      const [cursorVisible, tickerVisible, tickerClassName] = await Promise.all([
        cursor.isVisible().catch(() => false),
        ticker.isVisible().catch(() => false),
        ticker
          .locator(":scope > div")
          .first()
          .getAttribute("class")
          .catch(() => null),
      ]);
      if (
        cursorVisible &&
        tickerVisible &&
        typeof tickerClassName === "string" &&
        /(?:^|\s)opacity-100(?:\s|$)/.test(tickerClassName)
      ) {
        return captureAfterOnboarding(
          page,
          testInfo,
          "electron-shared-browser-agent-cursor.png",
        );
      }
      await waitForNextPoll();
    }
    if (cancelled) {
      return null;
    }
    throw new Error("AI cursor and action ticker did not become visible before timeout.");
  })();

  // Observe rejection immediately; the main flow still awaits the original
  // promise so timeout remains a test failure instead of an unhandled one.
  void promise.catch(() => undefined);
  return {
    cancel: () => {
      cancelled = true;
      wakePoll?.();
    },
    promise,
  };
}

async function dismissIntroIfVisible(page: Page): Promise<void> {
  const dismiss = page.getByRole("button", { name: "Not now" }).first();
  if (await dismiss.isVisible().catch(() => false)) {
    await dismiss.click();
  }
}

async function approveExpectedSharedBrowserRequest(
  sharedBrowser: Locator,
  expected: {
    kind: "origin" | "action";
    destination: RegExp;
  },
): Promise<string> {
  const prompt = sharedBrowser.getByTestId("shared-browser-approval-prompt");
  await expect(prompt).toBeVisible({ timeout: 60_000 });
  await expect(prompt.getByRole("heading")).toHaveText(
    expected.kind === "origin"
      ? "Allow the AI agent to use this site?"
      : "Allow this browser action?",
    { timeout: 60_000 },
  );
  const destination = prompt.getByTestId("shared-browser-approval-destination");
  await expect(destination).toHaveText(expected.destination, { timeout: 60_000 });
  const approvedDestination = (await destination.textContent())?.trim() ?? "";
  expect(approvedDestination).not.toBe("");
  if (expected.kind === "action") {
    await expect(prompt).toContainText("This approval is used once.");
  } else {
    await expect(prompt).toContainText("Allow applies to this site for the current AI turn.");
  }
  await expect(prompt.getByTestId("shared-browser-approval-deny")).toBeFocused();
  const allow = prompt.getByTestId("shared-browser-approval-allow");
  await expect(allow).toHaveText(expected.kind === "origin" ? "Allow site" : "Allow once");
  await allow.click();
  return approvedDestination;
}

function normalizedIanaOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      (hostname !== "iana.org" && hostname !== "www.iana.org")
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function exactPattern(value: string): RegExp {
  return new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
}

async function approveIanaRedirectOriginsUntilAgentYields(
  sharedBrowser: Locator,
  serverControl: SharedBrowserServerControlCollector,
  initiallyApprovedOrigin: string,
): Promise<void> {
  const normalizedInitialOrigin = normalizedIanaOrigin(initiallyApprovedOrigin);
  if (!normalizedInitialOrigin) {
    throw new Error("The approved IANA destination was not a canonical HTTPS origin.");
  }
  const approvedOrigins = new Set([normalizedInitialOrigin]);
  const maximumAdditionalOrigins = 2;
  const prompt = sharedBrowser.getByTestId("shared-browser-approval-prompt");

  for (
    let additionalOrigins = 0;
    additionalOrigins <= maximumAdditionalOrigins;
    additionalOrigins += 1
  ) {
    let agentReleased = false;
    let pendingOrigin: string | null = null;
    await expect
      .poll(
        async () => {
          if (serverControl.agentReturnedToHuman()) {
            agentReleased = true;
            return true;
          }
          if (!(await prompt.isVisible().catch(() => false))) {
            return false;
          }
          const heading = (await prompt.getByRole("heading").textContent())?.trim() ?? "";
          if (heading === "Allow this browser action?") {
            // The just-approved action card can remain mounted for one render
            // while its decision is applied. Keep polling; a genuinely stuck
            // card still fails at the bounded timeout.
            return false;
          }
          if (heading !== "Allow the AI agent to use this site?") {
            throw new Error(`Unexpected Shared Browser approval after click: ${heading}`);
          }
          const rawDestination =
            (await prompt
              .getByTestId("shared-browser-approval-destination")
              .textContent())?.trim() ?? "";
          const origin = normalizedIanaOrigin(rawDestination);
          if (!origin) {
            throw new Error(
              `The post-click Shared Browser approval was not an expected IANA origin: ${rawDestination}`,
            );
          }
          if (approvedOrigins.has(origin)) {
            // Likewise, ignore the previous origin card until the renderer
            // removes it. A duplicate request that persists fails by timeout.
            return false;
          }
          pendingOrigin = origin;
          return true;
        },
        {
          message:
            "the agent should either request a distinct IANA redirect origin or yield browser control",
          timeout: 60_000,
        },
      )
      .toBe(true);

    if (agentReleased) {
      return;
    }
    if (!pendingOrigin || additionalOrigins === maximumAdditionalOrigins) {
      throw new Error("Shared Browser exceeded its bounded IANA redirect-origin approvals.");
    }
    await approveExpectedSharedBrowserRequest(sharedBrowser, {
      kind: "origin",
      destination: exactPattern(pendingOrigin),
    });
    approvedOrigins.add(pendingOrigin);
  }

  throw new Error("Shared Browser redirect approval loop ended without restored control.");
}

type ConnectedCodexCredentialProof = {
  credentialId: string;
  kind: string;
  isDefault: boolean;
  lastUsedAt: string | null;
};

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
    // Do not retain Playwright request diagnostics containing the bearer token.
  }
  return null;
}

type AgentJobCredentialProof = {
  credentialId: string;
  runId: string;
};

type AgentJobExecutionState = {
  status: string;
};

async function fetchAgentJobCredentialProof(
  request: APIRequestContext,
  supabaseUrl: string,
  serviceRoleKey: string,
  jobId: string,
): Promise<AgentJobCredentialProof | null> {
  try {
    const query = new URL("/rest/v1/agent_jobs", supabaseUrl);
    query.searchParams.set("id", `eq.${jobId}`);
    query.searchParams.set("select", "credential_id,run_id");
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
    const credentialId =
      typeof row.credential_id === "string" ? row.credential_id.trim() : "";
    const runId = typeof row.run_id === "string" ? row.run_id.trim() : "";
    return credentialId && runId ? { credentialId, runId } : null;
  } catch {
    // Never retain request diagnostics containing the service-role token.
    return null;
  }
}

async function fetchAgentJobExecutionState(
  request: APIRequestContext,
  supabaseUrl: string,
  serviceRoleKey: string,
  jobId: string,
): Promise<AgentJobExecutionState | null> {
  try {
    const query = new URL("/rest/v1/agent_jobs", supabaseUrl);
    query.searchParams.set("id", `eq.${jobId}`);
    query.searchParams.set("select", "status");
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
    const status = typeof row.status === "string" ? row.status.trim().toLowerCase() : "";
    if (!status) {
      return null;
    }
    return { status };
  } catch {
    // Never retain request diagnostics containing the service-role token.
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

test.describe("Electron Shared Browser real agent turn", () => {
  test.describe.configure({ retries: 0 });
  test.skip(
    !ENABLED,
    "Set PLAYWRIGHT_ELECTRON_SHARED_BROWSER_AGENT_TURN=1 for the destructive production smoke.",
  );
  test.setTimeout(600_000);

  test("imports local Codex auth through Desktop and shows the AI cursor during a BYOC turn", async ({
    electronBrowserLiveCleanup,
    page: provisioningPage,
  }, testInfo) => {
    // Crash recovery only needs cleanup credentials. Run it before checking
    // launch-only prerequisites (the desktop build and local auth.json), so a
    // missing prerequisite can never strand credentials from an earlier kill.
    const cleanupConfig = resolveElectronBrowserLiveCleanupConfig();
    electronBrowserLiveCleanup.config = cleanupConfig;
    const recoveryDirectory = resolveElectronBrowserRecoveryDirectory();
    await recoverElectronBrowserStudiosBeforeProvisioning(
      provisioningPage.context().request,
      cleanupConfig,
      recoveryDirectory,
    );
    const config = resolveElectronBrowserLiveConfig(cleanupConfig);
    const provisioningIdentity = createElectronBrowserProvisioningIdentity();
    electronBrowserLiveCleanup.recoveryMarker =
      provisioningIdentity.recoveryMarker;
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
      provisioningPage.context().request,
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

    await (async () => {
      const launched = await launchElectronStudio(
        config,
        provisioned.projectId,
        { recoveryMarker: provisioningIdentity.recoveryMarker },
      );
      electronBrowserLiveCleanup.launched = launched;
      const { app, page } = launched;
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

      // Drive the visible Desktop credential flow. Electron's main process
      // reads, sanitizes, and uploads ~/.codex/auth.json directly. Neither the
      // preload nor renderer receives its contents; Node test code only checks
      // that the file exists and later observes sanitized controller metadata.
      await openSidebarSecondaryItem(page, "ai");
      await expect(page.getByTestId("ai-panel")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("credentials-settings-card")).toBeVisible({
        timeout: 30_000,
      });
      await page.getByTestId("credentials-add-connection").first().click();
      await expect(page.getByTestId("credentials-connect-modal")).toBeVisible();
      await page.getByTestId("credentials-connect-choice-codex").click();

      const codexCard = page.getByTestId("credentials-codex-card");
      await expect(
        codexCard.getByText("Desktop found your local Codex login.", {
          exact: true,
        }),
      ).toBeVisible({ timeout: 30_000 });
      const connectCodex = codexCard.getByTestId("credentials-connect-codex");
      await expect(connectCodex).toHaveText("Use local Codex login");

      // Persist the conservative marker before the click can initiate an
      // auth.json upload. A hard-killed runner can then purge by user id using
      // only the next run's service-role credential.
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
              provisioningPage.context().request,
              config.controllerUrl,
              provisioned.session.accessToken,
            );
            return proof
              ? {
                  kind: proof.kind,
                  isDefault: proof.isDefault,
                }
              : null;
          },
          { timeout: 60_000 },
        )
        .toEqual({ kind: "codex_auth_json", isDefault: true });
      const credentialProof = await fetchConnectedCodexCredentialProof(
        provisioningPage.context().request,
        config.controllerUrl,
        provisioned.session.accessToken,
      );
      if (!credentialProof) {
        throw new Error("Connected Codex credential metadata disappeared after onboarding.");
      }
      const credentialId = credentialProof.credentialId;
      const credentialLastUsedAtBefore = credentialProof.lastUsedAt;
      electronBrowserLiveCleanup.credentialId = credentialId;
      expect(credentialId).toBeTruthy();
      const credentialRow = page.getByTestId(
        `credentials-connection-row-${credentialId}`,
      );
      await expect(credentialRow).toBeVisible({ timeout: 30_000 });
      await expect(credentialRow).toContainText(/Codex on this computer|This machine/i);
      await expect(
        credentialRow.locator("span:visible").filter({ hasText: /^Default$/ }),
      ).toHaveCount(1);
      await expect(
        page.getByTestId(`credentials-connection-default-${credentialId}`),
      ).toHaveCount(0);

      const ledgerBefore = await fetchCreditLedger(
        provisioningPage.context().request,
        config,
        provisioned.session,
        provisioned.projectId,
      );
      const managedAiEntriesBefore = ledgerBefore.filter(
        (entry) => entry.reason === "managed_ai_prompt",
      ).length;

      await focusLastConversationTab(page);
      const serverControl = startSharedBrowserServerControlCollector(page);
      await page.getByTestId("composer-action-menu-trigger").click();
      await expect(page.getByTestId("composer-action-menu")).toBeVisible();
      await page.getByTestId("composer-action-menu-open-browser").click();

      const sharedButton = page.getByTestId("browser-transport-shared");
      await expect(sharedButton).toBeVisible({ timeout: 30_000 });
      await sharedButton.click();

      const shared = page.getByTestId("browser-session-modal");
      await expect(shared).toBeVisible({ timeout: 60_000 });
      await expect(shared.getByTestId("browser-session-status")).toContainText("Ready", {
        timeout: 300_000,
      });
      await expect
        .poll(async () => shared.locator("canvas:visible, video:visible").count(), {
          timeout: 60_000,
        })
        .toBe(1);

      const stage = shared.getByTestId("browser-session-stage");
      await expect
        .poll(async () => stage.getAttribute("data-shared-browser-viewer"), {
          timeout: 60_000,
        })
        .toBe(EXPECTED_SHARED_BROWSER_VIEWER);
      const remoteSurface = shared.locator("canvas:visible, video:visible").first();
      const sharedAddress = shared
        .getByTestId("shared-browser-chrome")
        .getByTestId("shared-browser-address");
      await sharedAddress.fill("https://example.com");
      const navigationResponsePromise = page.waitForResponse(
        isBrowserPageCommandResponse,
        { timeout: 60_000 },
      );
      await sharedAddress.press("Enter");
      const navigationResponse = await navigationResponsePromise;
      expect(navigationResponse.status()).toBe(204);
      await expect(sharedAddress).toHaveValue("https://example.com/", {
        timeout: 60_000,
      });
      // Capture the visible surface before applying the independent pixel-detail
      // assertion so transport regressions still leave inspectable evidence.
      await captureAfterOnboarding(
        page,
        testInfo,
        "electron-shared-browser-agent-transport-precheck.png",
      );
      await expect
        .poll(() => remoteSurfaceHasRenderedFrame(remoteSurface), { timeout: 60_000 })
        .toBe(true);
      await captureAfterOnboarding(
        page,
        testInfo,
        "electron-shared-browser-agent-ready.png",
      );

      const assistantBubbles = page.locator('[data-testid="chat-bubble-assistant"]');
      const assistantCountBefore = await assistantBubbles.count();
      const browserActionCollector = startBrowserActionResponseCollector(page);
      const cursorCapture = startCursorScreenshotCapture(page, testInfo, 300_000);
      try {
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

        const prompt =
          "Use the Shared Browser page already open. Click the visible link that goes to IANA " +
          "(it may read ‘More information...’ or ‘Learn more’). Use an actual click—do not type " +
          "or directly navigate to the destination. Wait for the IANA page to finish loading, keep " +
          "this same browser page visible, then reply with its final page title and URL.";
        const chatInput = page.getByTestId("chat-input");
        await chatInput.fill(prompt);
        await page.getByTestId("chat-send-button").click();

        const dispatchResponse = await dispatchResponsePromise;
        expect(dispatchResponse.ok()).toBe(true);
        const dispatchPayload = (await dispatchResponse.json()) as {
          runId?: unknown;
          jobId?: unknown;
          promptId?: unknown;
        };
        const runId =
          typeof dispatchPayload.runId === "string" ? dispatchPayload.runId : "";
        const jobId =
          typeof dispatchPayload.jobId === "string" ? dispatchPayload.jobId : "";
        const promptId =
          typeof dispatchPayload.promptId === "string" ? dispatchPayload.promptId : "";
        expect(runId).not.toBe("");
        expect(jobId).not.toBe("");
        expect(promptId).not.toBe("");

        const sharedChromeAuthority = shared
          .locator("[data-control-owner][data-interaction-enabled]")
          .first();
        const controlState = shared.getByTestId(
          "shared-browser-collaboration-control-state",
        );
        await expect
          .poll(() => serverControl.sawAgent(), {
            message:
              "the origin collaboration stream should publish authoritative agent ownership",
            timeout: 60_000,
          })
          .toBe(true);
        await expect(sharedChromeAuthority).toHaveAttribute(
          "data-control-owner",
          "agent",
          { timeout: 60_000 },
        );
        await expect(controlState).toContainText(/\S+ controls/i);
        await expect(sharedAddress).toBeDisabled();
        await expect(stage).toHaveAttribute("data-human-input-enabled", "false");
        await expect(shared.getByTestId("shared-browser-agent-control-overlay")).toBeVisible();
        const viewerKind = await stage.getAttribute("data-shared-browser-viewer");
        expect(viewerKind).toBe(EXPECTED_SHARED_BROWSER_VIEWER);
        if (viewerKind === "cdp-screencast" || viewerKind === "webrtc") {
          await expect(remoteSurface).toHaveAttribute("data-input-enabled", "false");
          await expect(remoteSurface).toHaveAttribute("tabindex", "-1");
        }

        // A real turn must pause while reading the current site, following a
        // cross-origin destination, and performing the single-use click. If
        // that destination redirects to a different origin, approve that
        // separately as well. Drive every boundary through the visible Desktop
        // UI so this proves the complete runtime -> origin -> renderer path.
        await approveExpectedSharedBrowserRequest(shared, {
          kind: "origin",
          destination: /^https:\/\/example\.com$/i,
        });
        const approvedIanaOrigin = await approveExpectedSharedBrowserRequest(shared, {
          kind: "origin",
          destination: /^https:\/\/(?:www\.)?iana\.org$/i,
        });
        await approveExpectedSharedBrowserRequest(shared, {
          kind: "action",
          destination: /^https:\/\/(?:www\.)?iana\.org$/i,
        });
        await approveIanaRedirectOriginsUntilAgentYields(
          shared,
          serverControl,
          approvedIanaOrigin,
        );

        await expect
          .poll(
            () =>
              fetchAgentJobCredentialProof(
                provisioningPage.context().request,
                config.supabaseUrl,
                config.supabaseServiceRoleKey,
                jobId,
              ),
            { timeout: 60_000 },
          )
          .toEqual({ credentialId, runId });

        await expect
          .poll(
            async () => {
              const metadata = await fetchRunMetadata(
                provisioningPage.context().request,
                config,
                provisioned.session,
                runId,
              );
              return metadata?.aiAccessMode ?? null;
            },
            { timeout: 60_000 },
          )
          .toBe("byoc");
        const runMetadata = await fetchRunMetadata(
          provisioningPage.context().request,
          config,
          provisioned.session,
          runId,
        );
        expect(runMetadata?.managedAiUsed).toBe(false);
        await expect
          .poll(
            async () => {
              const proof = await fetchConnectedCodexCredentialProof(
                provisioningPage.context().request,
                config.controllerUrl,
                provisioned.session.accessToken,
              );
              if (
                proof &&
                proof.credentialId === credentialId &&
                proof.lastUsedAt !== null &&
                proof.lastUsedAt !== credentialLastUsedAtBefore
              ) {
                return { kind: "credential-used" };
              }

              const job = await fetchAgentJobExecutionState(
                provisioningPage.context().request,
                config.supabaseUrl,
                config.supabaseServiceRoleKey,
                jobId,
              );
              if (job && ["failed", "canceled", "cancelled"].includes(job.status)) {
                throw new Error(
                  `Shared Browser agent job ended with status ${job.status} before the imported credential was used.`,
                );
              }
              return { kind: "pending" };
            },
            { timeout: 60_000 },
          )
          .toEqual({ kind: "credential-used" });
        await expectNoManagedAiLedgerBurn(
          provisioningPage.context().request,
          config,
          provisioned.session,
          provisioned.projectId,
          managedAiEntriesBefore,
          promptId,
        );

        expect(await cursorCapture.promise).not.toBeNull();

        await expect
          .poll(() => sharedAddress.inputValue(), { timeout: 300_000 })
          .toMatch(/^https:\/\/(?:www\.)?iana\.org\//i);
        await expect
          .poll(
            async () =>
              browserActionsShowClickThenNavigationToHost(
                await browserActionCollector.actions(),
                "iana.org",
              ),
            { timeout: 30_000 },
          )
          .toBe(true);
        await expect
          .poll(
            async () => {
              const replies = await assistantBubbles.allTextContents();
              return replies.slice(assistantCountBefore).join("\n");
            },
            { timeout: 300_000 },
          )
          .toMatch(/iana\.org/i);
        await expect(sharedChromeAuthority).toHaveAttribute(
          "data-control-owner",
          "human",
          { timeout: 30_000 },
        );
        await expect(controlState).toHaveText("You control");
        await expect
          .poll(() => serverControl.agentReturnedToHuman(), {
            message:
              "the origin collaboration stream should restore authoritative human ownership",
            timeout: 30_000,
          })
          .toBe(true);
        expect(serverControl.protocolValid()).toBe(true);
        await expect(sharedAddress).toBeEnabled();
        await expect(stage).toHaveAttribute("data-human-input-enabled", "true");
        if (viewerKind === "cdp-screencast" || viewerKind === "webrtc") {
          await expect(remoteSurface).toHaveAttribute("data-input-enabled", "true");
          await expect(remoteSurface).toHaveAttribute("tabindex", "0");
        }
        await captureAfterOnboarding(
          page,
          testInfo,
          "electron-shared-browser-agent-final.png",
        );

        await expectNoManagedAiLedgerBurn(
          provisioningPage.context().request,
          config,
          provisioned.session,
          provisioned.projectId,
          managedAiEntriesBefore,
          promptId,
        );

        await page.getByTestId("conversation-subtab-chat").click();
        await expect(assistantBubbles.last()).toBeVisible({ timeout: 30_000 });
        await expect(assistantBubbles.last()).toContainText(/iana\.org/i);
        await expect(page.getByTestId("assistant-typing-indicator")).toHaveCount(0, {
          timeout: 30_000,
        });
        await page.getByTestId("conversation-subtab-browser").click();
        await expect(sharedAddress).toHaveValue(/^https:\/\/(?:www\.)?iana\.org\//i);
        await expect
          .poll(() => remoteSurfaceHasRenderedFrame(remoteSurface), { timeout: 30_000 })
          .toBe(true);
      } finally {
        serverControl.stop();
        cursorCapture.cancel();
        await browserActionCollector.stop();
        await cursorCapture.promise.catch(() => null);
      }
    })();
  });
});
