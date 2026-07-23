import { test as base, type APIRequestContext } from "@playwright/test";
import fs from "node:fs";

import {
  closeElectronApplication,
  createElectronBrowserProvisioningIdentity,
  createElectronBrowserProvisioningRegistration,
  launchElectronStudio,
  provisionElectronBrowserStudio,
  resolveElectronBrowserLiveCleanupConfig,
  resolveElectronBrowserStudioConfig,
  restoreSessionIntoElectronStudio,
  type ElectronBrowserProvisioningIdentity,
  type ElectronBrowserProvisioningRegistration,
  type ElectronBrowserStudioConfig,
  type ElectronStudioLaunch,
} from "./electronBrowserLiveHarness.js";
import {
  recoverElectronBrowserLocalProfile,
  recoverElectronBrowserStudioFromJournalOrTarget,
  recoverElectronBrowserStudiosBeforeProvisioning,
  resolveElectronBrowserRecoveryDirectory,
  resolveElectronBrowserRecoveryJournalPath,
  writeElectronBrowserRecoveryJournal,
} from "./electronBrowserLiveRecovery.js";
import {
  acquireElectronBrowserLiveRunLock,
  type ElectronBrowserLiveRunLock,
} from "./electronBrowserLiveRunLock.js";
import {
  assertSharedBrowserProjectSafetyUnchanged,
  captureSharedBrowserProjectSafetyBaseline,
  discoverSharedBrowserInviteLink,
  normalizedSharedBrowserUuid,
  provisionSharedBrowserCollaborator,
  revokeAndVerifySharedBrowserInviteLink,
  SharedBrowserProductionLifecycleError,
  type SharedBrowserProductionActor,
  type SharedBrowserProductionCollaboratorActor,
  type SharedBrowserProductionInviteLinkInput,
  type SharedBrowserProductionOwnerActor,
  type SharedBrowserProductionTrackedInviteLink,
  type SharedBrowserProjectSafetyBaseline,
  type SharedBrowserTrackedInviteState,
} from "./sharedBrowserProductionResources.js";

const ELECTRON_CLOSE_TIMEOUT_MS = 15_000;
const LIFECYCLE_TIMEOUT_MS = 600_000;

export const SHARED_BROWSER_PRODUCTION_CANARY_ENABLED =
  (process.env.PLAYWRIGHT_SHARED_BROWSER_PRODUCTION_CANARY ?? "").trim() === "1";

export type SharedBrowserProductionElectronLaunchOptions = {
  projectId?: string;
  // False authenticates the Electron profile but deliberately leaves project
  // navigation to the caller (for example, until an invite is accepted).
  restoreSessionToProject?: boolean;
};

export type SharedBrowserProductionLifecycle = {
  enabled: boolean;
  config: ElectronBrowserStudioConfig | null;
  recoveryDirectory: string | null;
  provisionOwner: () => Promise<SharedBrowserProductionOwnerActor>;
  provisionCollaborator: () => Promise<SharedBrowserProductionCollaboratorActor>;
  launchElectron: (
    actor: SharedBrowserProductionActor,
    options?: string | SharedBrowserProductionElectronLaunchOptions,
  ) => Promise<ElectronStudioLaunch>;
  trackInviteLink: (
    input: SharedBrowserProductionInviteLinkInput,
  ) => Promise<SharedBrowserProductionTrackedInviteLink>;
  captureProjectSafetyBaseline: (
    projectId: string,
  ) => Promise<SharedBrowserProjectSafetyBaseline>;
  assertProjectSafetyUnchanged: (
    baseline: SharedBrowserProjectSafetyBaseline,
  ) => Promise<void>;
};

type ActorState = {
  actor: SharedBrowserProductionActor | null;
  identity: ElectronBrowserProvisioningIdentity;
  kind: "owner" | "collaborator";
  journalPath: string;
  registration: ElectronBrowserProvisioningRegistration;
  launch: ElectronStudioLaunch | null;
  launchAttempted: boolean;
  serverCleanupSucceeded: boolean;
  safetyBaseline: SharedBrowserProjectSafetyBaseline | null;
};

function disabledLifecycle(): SharedBrowserProductionLifecycle {
  const unavailable = (): never => {
    throw new SharedBrowserProductionLifecycleError(
      "requires PLAYWRIGHT_SHARED_BROWSER_PRODUCTION_CANARY=1",
    );
  };
  return {
    enabled: false,
    config: null,
    recoveryDirectory: null,
    provisionOwner: async () => unavailable(),
    provisionCollaborator: async () => unavailable(),
    launchElectron: async () => unavailable(),
    trackInviteLink: async () => unavailable(),
    captureProjectSafetyBaseline: async () => unavailable(),
    assertProjectSafetyUnchanged: async () => unavailable(),
  };
}

function actorCleanupTarget(state: ActorState): ElectronBrowserProvisioningRegistration {
  return state.actor
    ? {
        orgId: state.actor.orgId,
        projectId: state.actor.projectId,
        session: state.actor.session,
        userId: state.actor.userId,
      }
    : state.registration;
}

async function restoreElectronSessionWithoutProject(
  launch: ElectronStudioLaunch,
  config: ElectronBrowserStudioConfig,
  actor: SharedBrowserProductionActor,
): Promise<void> {
  await launch.page.goto(`${config.appBaseUrl}/login`, {
    waitUntil: "domcontentloaded",
  });
  await launch.page.waitForFunction(
    () => {
      const runtimeWindow = window as typeof window & {
        __INSTAFY_SUPABASE__?: {
          auth?: { setSession?: (session: unknown) => Promise<unknown> };
        };
      };
      return typeof runtimeWindow.__INSTAFY_SUPABASE__?.auth?.setSession === "function";
    },
    undefined,
    { timeout: 30_000 },
  );
  await launch.page.evaluate(async ({ accessToken, refreshToken }) => {
    const client = (window as typeof window & {
      __INSTAFY_SUPABASE__?: {
        auth?: { setSession?: (session: unknown) => Promise<unknown> };
      };
    }).__INSTAFY_SUPABASE__;
    if (!client?.auth?.setSession) {
      throw new Error("Supabase client is unavailable in Electron.");
    }
    await client.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
  }, actor.session);
}

function safeFailure(label: string, error: unknown): Error {
  return new Error(
    `${label} failed (${error instanceof Error ? error.name : "unknown error"}).`,
  );
}

function retainActorJournalAfterFailure(
  config: ElectronBrowserStudioConfig,
  state: ActorState,
): void {
  if (fs.existsSync(state.journalPath)) return;
  writeElectronBrowserRecoveryJournal(
    state.journalPath,
    config,
    state.identity,
    state.serverCleanupSucceeded
      ? { orgId: null, projectId: null, userId: null }
      : state.registration,
    false,
  );
}

async function teardownProductionLifecycle(
  request: APIRequestContext,
  config: ElectronBrowserStudioConfig,
  recoveryDirectory: string,
  actors: ActorState[],
  invites: SharedBrowserTrackedInviteState[],
): Promise<void> {
  const failures: Error[] = [];
  for (const state of [...actors].reverse()) {
    if (!state.launch) continue;
    try {
      await closeElectronApplication(state.launch.app, ELECTRON_CLOSE_TIMEOUT_MS);
    } catch (error) {
      failures.push(safeFailure(`${state.kind} Electron close`, error));
    }
  }

  let profileRecoveryFailed = false;
  for (const state of [...actors].reverse()) {
    if (!state.launchAttempted) continue;
    try {
      await recoverElectronBrowserLocalProfile(state.identity.recoveryMarker, {
        recoveryDirectory,
      });
      if (state.launch && fs.existsSync(state.launch.userDataDir)) {
        throw new SharedBrowserProductionLifecycleError(
          "Electron profile directory remains after recovery",
        );
      }
    } catch (error) {
      profileRecoveryFailed = true;
      failures.push(safeFailure(`${state.kind} profile recovery`, error));
    }
  }

  if (!profileRecoveryFailed) {
    for (const state of actors) {
      if (!state.safetyBaseline) continue;
      try {
        await assertSharedBrowserProjectSafetyUnchanged(
          request,
          config,
          state.safetyBaseline,
        );
      } catch (error) {
        failures.push(safeFailure("project no-AI invariant", error));
      }
    }
    for (const invite of [...invites].reverse()) {
      try {
        await revokeAndVerifySharedBrowserInviteLink(request, config, invite);
      } catch (error) {
        failures.push(safeFailure("invite cleanup", error));
      }
    }

    const collaborators = actors.filter((state) => state.kind === "collaborator");
    const ownersAndPartialActors = actors.filter((state) => state.kind === "owner");
    for (const state of [...collaborators, ...ownersAndPartialActors]) {
      const target = actorCleanupTarget(state);
      if (
        !fs.existsSync(state.journalPath) &&
        !target.userId &&
        !target.orgId &&
        !target.projectId
      ) {
        state.serverCleanupSucceeded = true;
        continue;
      }
      try {
        await recoverElectronBrowserStudioFromJournalOrTarget(
          request,
          config,
          state.journalPath,
          target,
        );
        state.serverCleanupSucceeded = true;
      } catch (error) {
        failures.push(safeFailure(`${state.kind} server cleanup`, error));
      }
    }
  }

  if (failures.length === 0) return;
  const journalFailures: Error[] = [];
  for (const state of actors) {
    try {
      retainActorJournalAfterFailure(config, state);
    } catch (error) {
      journalFailures.push(safeFailure("recovery journal retention", error));
    }
  }
  throw new Error(
    [
      "Shared Browser production lifecycle cleanup failed.",
      ...failures.map((failure) => failure.message),
      ...journalFailures.map((failure) => failure.message),
    ].join("\n"),
  );
}

function createProductionLifecycle(
  request: APIRequestContext,
  config: ElectronBrowserStudioConfig,
  recoveryDirectory: string,
  actors: ActorState[],
  invites: SharedBrowserTrackedInviteState[],
): SharedBrowserProductionLifecycle {
  const requireKnownActor = (actor: SharedBrowserProductionActor): ActorState => {
    const state = actors.find(
      (candidate) =>
        candidate.actor === actor &&
        candidate.identity.recoveryMarker === actor.identity.recoveryMarker,
    );
    if (!state) {
      throw new SharedBrowserProductionLifecycleError(
        "received an actor from a different fixture",
      );
    }
    return state;
  };
  const createState = (kind: ActorState["kind"]): ActorState => {
    const identity = createElectronBrowserProvisioningIdentity();
    const registration = createElectronBrowserProvisioningRegistration();
    const journalPath = resolveElectronBrowserRecoveryJournalPath(
      recoveryDirectory,
      identity.recoveryMarker,
    );
    writeElectronBrowserRecoveryJournal(
      journalPath,
      config,
      identity,
      registration,
      false,
    );
    const state: ActorState = {
      actor: null,
      identity,
      kind,
      journalPath,
      registration,
      launch: null,
      launchAttempted: false,
      serverCleanupSucceeded: false,
      safetyBaseline: null,
    };
    actors.push(state);
    return state;
  };
  const checkpoint = (state: ActorState) => {
    writeElectronBrowserRecoveryJournal(
      state.journalPath,
      config,
      state.identity,
      state.registration,
      false,
    );
  };

  return {
    enabled: true,
    config,
    recoveryDirectory,
    provisionOwner: async () => {
      const state = createState("owner");
      const provisioned = await provisionElectronBrowserStudio(
        request,
        config,
        state.registration,
        () => checkpoint(state),
        state.identity,
      );
      const actor: SharedBrowserProductionOwnerActor = {
        kind: "owner",
        identity: state.identity,
        recoveryJournalPath: state.journalPath,
        registration: state.registration,
        session: provisioned.session,
        userId: provisioned.userId,
        orgId: provisioned.orgId,
        projectId: provisioned.projectId,
        provisioned,
      };
      state.actor = actor;
      state.safetyBaseline = await captureSharedBrowserProjectSafetyBaseline(
        request,
        config,
        actor.projectId,
      );
      return actor;
    },
    provisionCollaborator: async () => {
      const state = createState("collaborator");
      const actor = await provisionSharedBrowserCollaborator(
        request,
        config,
        state.identity,
        state.registration,
        state.journalPath,
        () => checkpoint(state),
      );
      state.actor = actor;
      return actor;
    },
    launchElectron: async (actor, options = {}) => {
      const state = requireKnownActor(actor);
      if (state.launchAttempted) {
        throw new SharedBrowserProductionLifecycleError(
          "allows only one Electron launch per actor",
        );
      }
      const normalizedOptions = typeof options === "string" ? { projectId: options } : options;
      const projectId = normalizedSharedBrowserUuid(
        normalizedOptions.projectId ?? actor.projectId,
        "Electron project id",
      );
      state.launchAttempted = true;
      const launch = await launchElectronStudio(config, projectId, {
        recoveryDirectory,
        recoveryMarker: actor.identity.recoveryMarker,
      });
      state.launch = launch;
      const restoreToProject =
        normalizedOptions.restoreSessionToProject ?? actor.kind === "owner";
      if (restoreToProject) {
        await restoreSessionIntoElectronStudio(
          launch.page,
          config,
          actor.session,
          projectId,
        );
      } else {
        await restoreElectronSessionWithoutProject(launch, config, actor);
      }
      return launch;
    },
    trackInviteLink: async (input) => {
      requireKnownActor(input.owner);
      const invite = await discoverSharedBrowserInviteLink(request, config, input);
      if (
        invites.some(
          (existing) =>
            existing.orgId === invite.orgId &&
            existing.inviteLinkId === invite.inviteLinkId,
        )
      ) {
        throw new SharedBrowserProductionLifecycleError(
          "received the same invite link twice",
        );
      }
      invites.push(invite);
      return {
        inviteLinkId: invite.inviteLinkId,
        orgId: invite.orgId,
        projectId: invite.projectId,
        conversationId: invite.conversationId,
      };
    },
    captureProjectSafetyBaseline: (projectId) =>
      captureSharedBrowserProjectSafetyBaseline(request, config, projectId),
    assertProjectSafetyUnchanged: (baseline) =>
      assertSharedBrowserProjectSafetyUnchanged(request, config, baseline),
  };
}

export const test = base.extend<{
  sharedBrowserProductionLifecycle: SharedBrowserProductionLifecycle;
}>({
  sharedBrowserProductionLifecycle: [
    async ({ request }, use) => {
      if (!SHARED_BROWSER_PRODUCTION_CANARY_ENABLED) {
        await use(disabledLifecycle());
        return;
      }
      if (process.platform === "win32") {
        throw new SharedBrowserProductionLifecycleError(
          "requires macOS or Linux for verified Electron profile recovery",
        );
      }
      const recoveryDirectory = resolveElectronBrowserRecoveryDirectory();
      let lock: ElectronBrowserLiveRunLock | null = null;
      try {
        lock = acquireElectronBrowserLiveRunLock(recoveryDirectory);
        const cleanupConfig = resolveElectronBrowserLiveCleanupConfig();
        await recoverElectronBrowserStudiosBeforeProvisioning(
          request,
          cleanupConfig,
          recoveryDirectory,
        );
        const config = resolveElectronBrowserStudioConfig(cleanupConfig);
        const actors: ActorState[] = [];
        const invites: SharedBrowserTrackedInviteState[] = [];
        const lifecycle = createProductionLifecycle(
          request,
          config,
          recoveryDirectory,
          actors,
          invites,
        );
        try {
          await use(lifecycle);
        } finally {
          await teardownProductionLifecycle(
            request,
            config,
            recoveryDirectory,
            actors,
            invites,
          );
        }
      } finally {
        lock?.release();
      }
    },
    { scope: "test", timeout: LIFECYCLE_TIMEOUT_MS },
  ],
});

if (SHARED_BROWSER_PRODUCTION_CANARY_ENABLED) {
  test.use({ trace: "off", video: "off", screenshot: "off" });
}

export {
  assertSharedBrowserProjectSafetyUnchanged,
  captureSharedBrowserProjectSafetyBaseline,
  type SharedBrowserProductionActor,
  type SharedBrowserProductionCollaboratorActor,
  type SharedBrowserProductionInviteLinkInput,
  type SharedBrowserProductionOwnerActor,
  type SharedBrowserProductionTrackedInviteLink,
  type SharedBrowserProjectSafetyBaseline,
} from "./sharedBrowserProductionResources.js";
export { expect } from "@playwright/test";
