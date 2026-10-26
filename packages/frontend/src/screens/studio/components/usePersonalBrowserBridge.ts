import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SubmitConversationRuntimeOverride } from "../../../conversations/useConversation";
import { runtimeEntryIsDispatchable } from "../../../runtime/utils/runtimeEntry";
import { controllerClient } from "../../../sdk/instafy";
import { normalizeBrowserAddress } from "./browserAddress";
import type { SentPageRead } from "./sentPageAttachment";
import {
  personalBrowserRoutineAvailable,
  resolvePersonalBrowserApprovalMode,
  type PersonalBrowserApprovalMode,
} from "./personalBrowserApprovalPolicy";

export {
  PERSONAL_BROWSER_OWNER_TIER_POLICY_VERSION,
  personalBrowserKnownHosts,
  personalBrowserOwnerTier,
  personalBrowserRoutineAvailable,
  resolvePersonalBrowserApprovalMode,
  type PersonalBrowserApprovalMode,
} from "./personalBrowserApprovalPolicy";

export type BrowserTransport = "personal" | "shared";
export type PersonalBrowserAgentPhase = "idle" | "starting" | "ready" | "unavailable";
export type PersonalBrowserClearDataState = "idle" | "clearing" | "succeeded" | "failed";

const PERSONAL_BROWSER_RUNTIME_READY_TIMEOUT_MS = 45_000;
const PERSONAL_BROWSER_RUNTIME_POLL_MS = 1_500;
// Handoff ids Studio already sent or retired; a late status that still
// carries one of them never arms the manual-step guard again.
const PERSONAL_BROWSER_RETIRED_HANDOFF_LIMIT = 8;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** A sign-in handoff Studio saw from this hook's own Personal Browser owner. */
export type PersonalBrowserHandoff = {
  handoffId: string;
  expiresAtMs: number;
};

type OwnedPersonalBrowserHandoff = PersonalBrowserHandoff & { ownerId: string };

export function resolveDefaultBrowserTransport(input: {
  checked: boolean;
  supported: boolean;
  enabled: boolean;
}): BrowserTransport {
  return input.checked && input.supported && input.enabled ? "personal" : "shared";
}

export function personalBrowserIdentityScope(
  projectId: string | null,
  profileUserId: string | null,
): string | null {
  return projectId && profileUserId ? `${projectId}\u0000${profileUserId}` : null;
}

export function normalizePersonalBrowserUrl(rawUrl: string): string | null {
  return normalizeBrowserAddress(rawUrl);
}

export function resolvePersonalBrowserRuntimeOverride(input: {
  agentControlEnabled: boolean;
  agentPhase: PersonalBrowserAgentPhase;
  browserState: InstafyDesktopPersonalBrowserState | null;
  runtimeId: string | null;
}): SubmitConversationRuntimeOverride | null {
  if (
    input.browserState !== "ready" ||
    !input.agentControlEnabled ||
    input.agentPhase !== "ready" ||
    !input.runtimeId
  ) {
    return null;
  }
  return {
    runtimeId: input.runtimeId,
    runtimeDisplayName: "Personal Browser on this device",
    // Pin only this send. Do not turn a device-local runtime into the
    // conversation preference when the user returns to Shared or normal chat.
    preferRuntime: false,
  };
}

function browserBridge() {
  return typeof window === "undefined" ? undefined : window.instafyDesktop;
}

function createPersonalBrowserOwnerId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `personal-browser-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function closePersonalBrowserOwnership(
  bridge: NonNullable<Window["instafyDesktop"]>,
  ownerId: string,
): Promise<void> {
  await (bridge.personalBrowserClose?.({ ownerId }) ?? Promise.resolve()).catch(
    () => undefined,
  );
}

async function releasePersonalBrowserOwnership(
  bridge: NonNullable<Window["instafyDesktop"]>,
  ownerId: string,
): Promise<void> {
  if (typeof bridge.personalBrowserRelease !== "function") {
    await closePersonalBrowserOwnership(bridge, ownerId);
    return;
  }
  await bridge.personalBrowserRelease({ ownerId }).catch(() => undefined);
}

function statusWithError(
  previous: InstafyDesktopPersonalBrowserStatus | null,
  error: unknown,
): InstafyDesktopPersonalBrowserStatus {
  return {
    supported: previous?.supported ?? true,
    enabled: previous?.enabled ?? true,
    state: "error",
    visible: false,
    url: previous?.url ?? "",
    title: previous?.title,
    canGoBack: previous?.canGoBack ?? false,
    canGoForward: previous?.canGoForward ?? false,
    agentControlEnabled: previous?.agentControlEnabled ?? false,
    ownerId: previous?.ownerId,
    projectId: previous?.projectId,
    runtimeId: previous?.runtimeId,
    error: error instanceof Error ? error.message : String(error),
  };
}

export function usePersonalBrowserBridge({
  active,
  profileUserId,
  projectId,
  conversationBindingKey,
}: {
  active: boolean;
  profileUserId: string | null;
  projectId: string | null;
  /** Undefined preserves standalone use; null means no conversation may own control. */
  conversationBindingKey?: string | null;
}) {
  const [checked, setChecked] = useState(false);
  const [status, setStatus] = useState<InstafyDesktopPersonalBrowserStatus | null>(null);
  // Unset until the person chooses; the default follows the Desktop's policy.
  const [approvalModeChoice, setPreferredApprovalMode] = useState<PersonalBrowserApprovalMode | null>(null);
  const [runtimeStartState, setRuntimeStartState] = useState<
    "idle" | "starting" | "succeeded" | "failed"
  >("idle");
  const [startedRuntimeId, setStartedRuntimeId] = useState<string | null>(null);
  const [runtimeDispatchReady, setRuntimeDispatchReady] = useState(false);
  const [runtimePollTimedOut, setRuntimePollTimedOut] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const [clearDataState, setClearDataState] =
    useState<PersonalBrowserClearDataState>("idle");
  const [clearDataError, setClearDataError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [openRetryRevision, setOpenRetryRevision] = useState(0);
  const openInFlightRef = useRef(false);
  const openRetryRequestedRef = useRef(false);
  const openAttemptEpochRef = useRef(0);
  const openedIdentityScopeRef = useRef<string | null>(null);
  const personalBrowserOwnerIdRef = useRef<string | null>(null);
  const retiredPersonalBrowserOwnerIdRef = useRef<string | null>(null);
  const retiredOwnerDispositionRef = useRef<"close" | "release">("close");
  const desiredIdentityScopeRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const runtimeStartIdentityScopeRef = useRef<string | null>(null);
  const runtimeStartAttemptEpochRef = useRef(0);
  const agentControlMutationEpochRef = useRef(0);
  const clearDataMutationEpochRef = useRef(0);
  const observedHostRuntimeIdRef = useRef<string | null>(null);
  // The last handoff Studio saw. Every enable names it until it expires or a
  // newer one replaces it, so Desktop resumes only that handoff.
  const boundHandoffRef = useRef<OwnedPersonalBrowserHandoff | null>(null);
  // The manual-step guard. Desktop clears its humanInputRequest on every
  // navigation (a sign-in redirect included) but keeps the handoff, so the
  // guard outlives that status and ends only when the handoff is used,
  // paused, cleared, closed or expired.
  const pendingHandoffRef = useRef<OwnedPersonalBrowserHandoff | null>(null);
  const [pendingHandoff, setPendingHandoffState] =
    useState<OwnedPersonalBrowserHandoff | null>(null);
  const retiredHandoffIdsRef = useRef<string[]>([]);
  const profileIdentityScope = personalBrowserIdentityScope(projectId, profileUserId);
  const identityScope = !profileIdentityScope || conversationBindingKey === null
    ? null
    : conversationBindingKey === undefined
      ? profileIdentityScope
      : JSON.stringify([profileIdentityScope, conversationBindingKey]);
  const previousIdentityScopeRef = useRef(identityScope);
  const previousProfileIdentityScopeRef = useRef(profileIdentityScope);
  desiredIdentityScopeRef.current = identityScope;

  const retireHandoffId = useCallback((handoffId: string) => {
    const retired = retiredHandoffIdsRef.current.filter((id) => id !== handoffId);
    retired.push(handoffId);
    retiredHandoffIdsRef.current = retired.slice(-PERSONAL_BROWSER_RETIRED_HANDOFF_LIMIT);
  }, []);
  const setPendingHandoff = useCallback((next: OwnedPersonalBrowserHandoff | null) => {
    pendingHandoffRef.current = next;
    setPendingHandoffState(next);
  }, []);
  /** Ends the guard; with an id, only when that handoff is still the pending one. */
  const clearPendingHandoff = useCallback((handoffId?: string) => {
    const current = pendingHandoffRef.current;
    if (!current || (handoffId !== undefined && current.handoffId !== handoffId)) {
      return;
    }
    retireHandoffId(current.handoffId);
    setPendingHandoff(null);
  }, [retireHandoffId, setPendingHandoff]);
  /** Clear data, close and an owner change end both the bound id and the guard. */
  const resetHandoff = useCallback(() => {
    const bound = boundHandoffRef.current;
    if (bound) {
      retireHandoffId(bound.handoffId);
    }
    boundHandoffRef.current = null;
    clearPendingHandoff();
  }, [clearPendingHandoff, retireHandoffId]);

  useLayoutEffect(() => {
    if (previousIdentityScopeRef.current !== identityScope) {
      previousIdentityScopeRef.current = identityScope;
      const disposition = profileIdentityScope !== null && previousProfileIdentityScopeRef.current === profileIdentityScope
        ? "release" : "close";
      if (personalBrowserOwnerIdRef.current) {
        retiredPersonalBrowserOwnerIdRef.current = personalBrowserOwnerIdRef.current;
        retiredOwnerDispositionRef.current = disposition;
      } else if (disposition === "close") {
        retiredOwnerDispositionRef.current = "close";
      }
      personalBrowserOwnerIdRef.current = null;
      openAttemptEpochRef.current += 1;
      runtimeStartAttemptEpochRef.current += 1;
      agentControlMutationEpochRef.current += 1;
      clearDataMutationEpochRef.current += 1;
      openRetryRequestedRef.current = false;
      resetHandoff();
      setRecovering(false);
      setNavigationError(null);
      setClearDataState("idle");
      setClearDataError(null);
    }
    previousProfileIdentityScopeRef.current = profileIdentityScope;
    if (runtimeStartIdentityScopeRef.current !== identityScope) {
      runtimeStartIdentityScopeRef.current = identityScope;
      setRuntimeStartState("idle");
      setStartedRuntimeId(null);
      setRuntimeDispatchReady(false);
      setRuntimePollTimedOut(false);
      setAgentError(null);
      observedHostRuntimeIdRef.current = null;
    }
  }, [identityScope, profileIdentityScope, resetHandoff]);

  // Runs on every status Desktop sends, before React batches it with the
  // next one, so a navigation status right after the request never hides it.
  const observeHandoffStatus = useCallback((next: InstafyDesktopPersonalBrowserStatus) => {
    const ownerId = personalBrowserOwnerIdRef.current;
    if (!ownerId || next.ownerId !== ownerId) {
      return;
    }
    if (next.agentControlEnabled) {
      // Control is back on: Desktop has used or emptied its handoff slot.
      clearPendingHandoff();
      return;
    }
    // A later status without the request (a navigation) never ends the guard.
    const request = next.humanInputRequest;
    const handoffId = typeof request?.handoffId === "string" ? request.handoffId.trim() : "";
    if (
      !request ||
      !handoffId ||
      !Number.isFinite(request.expiresAtMs) ||
      request.expiresAtMs <= Date.now() ||
      retiredHandoffIdsRef.current.includes(handoffId) ||
      pendingHandoffRef.current?.handoffId === handoffId
    ) {
      return;
    }
    const handoff = { handoffId, expiresAtMs: request.expiresAtMs, ownerId };
    boundHandoffRef.current = handoff;
    setPendingHandoff(handoff);
  }, [clearPendingHandoff, setPendingHandoff]);

  const updateStatus = useCallback((next: InstafyDesktopPersonalBrowserStatus) => {
    if (!next.agentControlEnabled) {
      runtimeStartAttemptEpochRef.current += 1;
    }
    observeHandoffStatus(next);
    setStatus(next);
    setChecked(true);
  }, [observeHandoffStatus]);

  useEffect(() => {
    const bridge = browserBridge();
    if (typeof bridge?.personalBrowserStatus !== "function") {
      setChecked(true);
      setStatus(null);
      return undefined;
    }

    let cancelled = false;
    const unsubscribe = bridge.onPersonalBrowserStatus?.((next) => {
      if (!cancelled) {
        updateStatus(next);
      }
    });
    void bridge.personalBrowserStatus()
      .then((next) => {
        if (!cancelled) {
          updateStatus(next);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setChecked(true);
          setStatus((previous) => statusWithError(previous, error));
        }
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [updateStatus]);

  const available = Boolean(
    checked &&
      status?.supported &&
      status.enabled &&
      identityScope !== null &&
      projectId &&
      profileUserId &&
      typeof browserBridge()?.personalBrowserOpen === "function" &&
      typeof browserBridge()?.personalBrowserSetBounds === "function",
  );

  useEffect(() => {
    const retiredOwnerId = retiredPersonalBrowserOwnerIdRef.current;
    const ownerId =
      identityScope === null
        ? personalBrowserOwnerIdRef.current ?? retiredOwnerId
        : retiredOwnerId;
    if (!ownerId) {
      return;
    }
    openAttemptEpochRef.current += 1;
    runtimeStartAttemptEpochRef.current += 1;
    agentControlMutationEpochRef.current += 1;
    clearDataMutationEpochRef.current += 1;
    if (identityScope === null) {
      personalBrowserOwnerIdRef.current = null;
    }
    retiredPersonalBrowserOwnerIdRef.current = null;
    openedIdentityScopeRef.current = null;
    const bridge = browserBridge();
    if (bridge && ownerId) {
      // A conversation owns the opaque control lease, not the persistent
      // profile. Reclaim the same DOM/cookies with a fresh owner after release.
      void (retiredOwnerDispositionRef.current === "release"
        ? releasePersonalBrowserOwnership(bridge, ownerId)
        : closePersonalBrowserOwnership(bridge, ownerId));
    }
  }, [identityScope]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      openAttemptEpochRef.current += 1;
      runtimeStartAttemptEpochRef.current += 1;
      agentControlMutationEpochRef.current += 1;
      clearDataMutationEpochRef.current += 1;
      const ownerId =
        personalBrowserOwnerIdRef.current ??
        retiredPersonalBrowserOwnerIdRef.current;
      const shouldClose =
        openedIdentityScopeRef.current !== null ||
        openInFlightRef.current ||
        ownerId !== null;
      personalBrowserOwnerIdRef.current = null;
      retiredPersonalBrowserOwnerIdRef.current = null;
      openedIdentityScopeRef.current = null;
      const bridge = browserBridge();
      if (shouldClose && bridge && ownerId) {
        void releasePersonalBrowserOwnership(bridge, ownerId);
      }
    };
  }, []);

  useEffect(() => {
    if (!active || !available || !projectId || !profileUserId) {
      return;
    }
    const requiresOpen =
      status?.state === "closed" ||
      (status?.state !== "error" &&
        (status?.projectId !== projectId ||
          openedIdentityScopeRef.current !== identityScope)) ||
      (status?.state === "error" && openRetryRequestedRef.current);
    if (!requiresOpen || openInFlightRef.current) {
      return;
    }
    const bridge = browserBridge();
    const openPersonalBrowser = bridge?.personalBrowserOpen;
    if (!bridge || !openPersonalBrowser) {
      return;
    }
    openInFlightRef.current = true;
    openRetryRequestedRef.current = false;
    const openingIdentityScope = identityScope;
    const openingOwnerId = createPersonalBrowserOwnerId();
    personalBrowserOwnerIdRef.current = openingOwnerId;
    resetHandoff();
    const openingAttemptEpoch = ++openAttemptEpochRef.current;
    void (async () => {
      let shouldRetry = false;
      try {
        const requestContext = await controllerClient.core.resolveRequestContext(null);
        if (
          !requestContext.accessToken ||
          requestContext.credentialSource !== "ambient"
        ) {
          throw new Error(
            "Personal Browser is unavailable for an overridden controller session.",
          );
        }
        const next = await openPersonalBrowser({
          projectId,
          controllerUrl: requestContext.baseUrl,
          controllerAccessToken: requestContext.accessToken,
          profileUserId,
          ownerId: openingOwnerId,
        });
        const isCurrent =
          mountedRef.current &&
          openAttemptEpochRef.current === openingAttemptEpoch &&
          desiredIdentityScopeRef.current === openingIdentityScope &&
          personalBrowserOwnerIdRef.current === openingOwnerId &&
          next.ownerId === openingOwnerId;
        if (!isCurrent) {
          // A stale open can resolve after this hook unmounts but before its
          // replacement owner has opened. Releasing keeps the same-identity
          // WebContentsView available for that replacement while still
          // revoking control immediately; a destructive close here races the
          // replacement and resets the page to about:blank.
          await releasePersonalBrowserOwnership(bridge, openingOwnerId);
          shouldRetry = mountedRef.current && desiredIdentityScopeRef.current !== null;
          return;
        }
        openedIdentityScopeRef.current = openingIdentityScope;
        retiredPersonalBrowserOwnerIdRef.current = null;
        setRecovering(false);
        updateStatus(next);
      } catch (error) {
        const isCurrent =
          mountedRef.current &&
          openAttemptEpochRef.current === openingAttemptEpoch &&
          desiredIdentityScopeRef.current === openingIdentityScope &&
          personalBrowserOwnerIdRef.current === openingOwnerId;
        if (!isCurrent) {
          await releasePersonalBrowserOwnership(bridge, openingOwnerId);
          shouldRetry = mountedRef.current && desiredIdentityScopeRef.current !== null;
          return;
        }
        setStatus((previous) => statusWithError(previous, error));
      } finally {
        openInFlightRef.current = false;
        if (
          mountedRef.current &&
          openAttemptEpochRef.current === openingAttemptEpoch
        ) {
          setRecovering(false);
        }
        if (shouldRetry && mountedRef.current) {
          openRetryRequestedRef.current = true;
          setOpenRetryRevision((value) => value + 1);
        }
      }
    })();
  }, [active, available, identityScope, openRetryRevision, profileUserId, projectId, resetHandoff, status?.projectId, status?.state, updateStatus]);

  useEffect(() => {
    if (!pendingHandoff) {
      return undefined;
    }
    const { handoffId, expiresAtMs } = pendingHandoff;
    const expire = () => {
      if (boundHandoffRef.current?.handoffId === handoffId) {
        boundHandoffRef.current = null;
      }
      clearPendingHandoff(handoffId);
    };
    const remaining = expiresAtMs - Date.now();
    if (remaining <= 0) {
      expire();
      return undefined;
    }
    const timer = setTimeout(expire, Math.min(remaining, MAX_TIMER_DELAY_MS));
    return () => clearTimeout(timer);
  }, [clearPendingHandoff, pendingHandoff]);

  useEffect(() => {
    if (status?.agentControlEnabled !== false) {
      return;
    }
    runtimeStartAttemptEpochRef.current += 1;
    observedHostRuntimeIdRef.current = null;
    setRuntimeStartState("idle");
    setStartedRuntimeId(null);
    setRuntimeDispatchReady(false);
    setRuntimePollTimedOut(false);
    setAgentError(null);
  }, [status?.agentControlEnabled]);

  useEffect(() => {
    if (
      !active ||
      !available ||
      !projectId ||
      openedIdentityScopeRef.current !== identityScope ||
      status?.projectId !== projectId ||
      status.state !== "ready" ||
      !status.agentControlEnabled ||
      runtimeStartState !== "idle"
    ) {
      return;
    }
    const bridge = browserBridge();
    if (typeof bridge?.startDesktopRuntime !== "function") {
      setRuntimeStartState("failed");
      setAgentError("The personal browser is usable, but desktop agent control is unavailable.");
      return;
    }
    const startingOwnerId = personalBrowserOwnerIdRef.current;
    if (!startingOwnerId || status.ownerId !== startingOwnerId) {
      return;
    }

    setRuntimeStartState("starting");
    const startingIdentityScope = identityScope;
    const startingAttemptEpoch = ++runtimeStartAttemptEpochRef.current;
    const startAttemptIsCurrent = () =>
      mountedRef.current &&
      runtimeStartAttemptEpochRef.current === startingAttemptEpoch &&
      runtimeStartIdentityScopeRef.current === startingIdentityScope &&
      desiredIdentityScopeRef.current === startingIdentityScope &&
      personalBrowserOwnerIdRef.current === startingOwnerId;
    void (async () => {
      const requestContext = await controllerClient.core.resolveRequestContext(null);
      if (!startAttemptIsCurrent()) {
        return;
      }
      if (
        !requestContext.accessToken ||
        requestContext.credentialSource !== "ambient"
      ) {
        throw new Error(
          "Personal Browser is unavailable for an overridden controller session.",
        );
      }
      const result = await bridge.startDesktopRuntime?.({
        projectId,
        controllerUrl: requestContext.baseUrl,
        controllerAccessToken: requestContext.accessToken,
        controllerCredentialMode: "ambient",
        displayName: "Instafy Personal Browser",
        enablePersonalBrowser: true,
        personalBrowserOwnerId: startingOwnerId,
      });
      if (!startAttemptIsCurrent()) {
        return;
      }
      const runtimeId = result?.runtimeId?.trim() || null;
      if (!runtimeId) {
        throw new Error("The desktop browser agent did not return a runtime id.");
      }
      setStartedRuntimeId(runtimeId);
      setRuntimeStartState("succeeded");
      const currentStatus = await bridge.personalBrowserStatus?.().catch(() => null);
      if (currentStatus && startAttemptIsCurrent()) {
        updateStatus(currentStatus);
      }
    })().catch((error) => {
      if (!startAttemptIsCurrent()) {
        return;
      }
      setRuntimeStartState("failed");
      setAgentError(error instanceof Error ? error.message : String(error));
    });
  }, [active, available, identityScope, projectId, runtimeStartState, status?.agentControlEnabled, status?.ownerId, status?.projectId, status?.state, updateStatus]);

  const statusRuntimeId =
    status?.projectId === projectId &&
    status.ownerId === personalBrowserOwnerIdRef.current
      ? status.runtimeId?.trim() || null
      : null;
  const runtimeId = statusRuntimeId ?? startedRuntimeId;
  useEffect(() => {
    if (!status?.agentControlEnabled) {
      return;
    }
    if (statusRuntimeId) {
      observedHostRuntimeIdRef.current = statusRuntimeId;
      if (startedRuntimeId !== statusRuntimeId) {
        setStartedRuntimeId(statusRuntimeId);
      }
      return;
    }
    if (
      observedHostRuntimeIdRef.current &&
      runtimeStartState === "succeeded"
    ) {
      observedHostRuntimeIdRef.current = null;
      setStartedRuntimeId(null);
      setRuntimeDispatchReady(false);
      setRuntimePollTimedOut(false);
      setRuntimeStartState("failed");
      setAgentError(
        "The Personal Browser desktop agent stopped. Use Retry agent to start it again.",
      );
    }
  }, [runtimeStartState, startedRuntimeId, status?.agentControlEnabled, statusRuntimeId]);

  useEffect(() => {
    if (runtimeStartState !== "succeeded" || !projectId || !runtimeId) {
      setRuntimeDispatchReady(false);
      setRuntimePollTimedOut(false);
      return undefined;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = Date.now() + PERSONAL_BROWSER_RUNTIME_READY_TIMEOUT_MS;
    setRuntimeDispatchReady(false);
    setRuntimePollTimedOut(false);
    setAgentError(null);

    const poll = async () => {
      const snapshot = await controllerClient.runtimes.fetchStatus({
        projectId,
        quietOnAbort: true,
      }).catch(() => null);
      if (cancelled) {
        return;
      }
      const entry = snapshot?.runtimes.find((candidate) => candidate.runtimeId === runtimeId) ?? null;
      if (runtimeEntryIsDispatchable(entry)) {
        setRuntimeDispatchReady(true);
        setRuntimePollTimedOut(false);
        setAgentError(null);
        return;
      }
      if (Date.now() >= deadline) {
        setRuntimeDispatchReady(false);
        setRuntimePollTimedOut(true);
        setAgentError("The personal browser is usable, but its desktop agent did not become ready.");
        return;
      }
      timer = setTimeout(() => void poll(), PERSONAL_BROWSER_RUNTIME_POLL_MS);
    };
    void poll();

    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [projectId, runtimeId, runtimeStartState]);

  const agentPhase = useMemo<PersonalBrowserAgentPhase>(() => {
    if (agentError) {
      return "unavailable";
    }
    if (status?.agentControlEnabled === false) {
      return "idle";
    }
    if (runtimeDispatchReady) {
      return "ready";
    }
    if (runtimeStartState === "failed" || runtimePollTimedOut) {
      return "unavailable";
    }
    if (runtimeStartState === "starting" || runtimeStartState === "succeeded") {
      return "starting";
    }
    return "idle";
  }, [agentError, runtimeDispatchReady, runtimePollTimedOut, runtimeStartState, status?.agentControlEnabled]);

  const invoke = useCallback(
    async (
      operation: (
        bridge: NonNullable<Window["instafyDesktop"]>,
        ownerId: string,
      ) => Promise<InstafyDesktopPersonalBrowserStatus> | undefined,
    ) => {
      const bridge = browserBridge();
      const ownerId = personalBrowserOwnerIdRef.current;
      if (!bridge || !ownerId) {
        return null;
      }
      try {
        const result = await operation(bridge, ownerId);
        if (
          result &&
          personalBrowserOwnerIdRef.current === ownerId &&
          (result.ownerId === ownerId || result.state === "closed")
        ) {
          updateStatus(result);
        }
        return result ?? null;
      } catch (error) {
        if (
          mountedRef.current &&
          personalBrowserOwnerIdRef.current === ownerId
        ) {
          setStatus((previous) => statusWithError(previous, error));
        }
        return null;
      }
    },
    [updateStatus],
  );

  const navigate = useCallback(
    async (rawUrl: string) => {
      const url = normalizePersonalBrowserUrl(rawUrl);
      if (!url) {
        setNavigationError(
          rawUrl.trim()
            ? "Enter an http:// or https:// address. Personal Browser blocks privileged address types."
            : "Enter a web address.",
        );
        return null;
      }
      setNavigationError(null);
      const result = await invoke((bridge, ownerId) =>
        bridge.personalBrowserNavigate?.({ url, ownerId }),
      );
      if (!result) {
        setNavigationError("That page could not be opened. Check the address and try again.");
      }
      return result;
    },
    [invoke],
  );
  const clearNavigationError = useCallback(() => setNavigationError(null), []);
  const goBack = useCallback(
    () => invoke((bridge, ownerId) => bridge.personalBrowserGoBack?.({ ownerId })),
    [invoke],
  );
  const goForward = useCallback(
    () => invoke((bridge, ownerId) => bridge.personalBrowserGoForward?.({ ownerId })),
    [invoke],
  );
  const reload = useCallback(
    () => invoke((bridge, ownerId) => bridge.personalBrowserReload?.({ ownerId })),
    [invoke],
  );
  /** Shows another tab. Desktop refuses it while Octo has control. */
  const selectTab = useCallback(
    (tabId: string) => invoke((bridge, ownerId) => bridge.personalBrowserSelectTab?.({ ownerId, tabId })),
    [invoke],
  );
  /** Closes a tab Octo opened. Desktop refuses it while Octo has control. */
  const closeTab = useCallback(
    (tabId: string) => invoke((bridge, ownerId) => bridge.personalBrowserCloseTab?.({ ownerId, tabId })),
    [invoke],
  );
  /**
   * Send page to Octo: reads the page on screen once, masked by Desktop. Only
   * a press calls it; nothing reads the page on its own. Null when this
   * Desktop cannot.
   */
  const readPage = useCallback(async (): Promise<SentPageRead | null> => {
    const bridge = browserBridge();
    const ownerId = personalBrowserOwnerIdRef.current;
    if (!ownerId || typeof bridge?.personalBrowserReadPage !== "function") {
      return null;
    }
    return bridge.personalBrowserReadPage({ ownerId });
  }, []);
  const setAgentControlEnabled = useCallback(
    async (enabled: boolean, approvalMode?: PersonalBrowserApprovalMode, knownHosts?: readonly string[]) => {
      const bridge = browserBridge();
      const ownerId = personalBrowserOwnerIdRef.current;
      if (
        !ownerId ||
        typeof bridge?.personalBrowserSetAgentControlEnabled !== "function"
      ) {
        return null;
      }
      const mutationEpoch = ++agentControlMutationEpochRef.current;
      // Every enable names the handoff Studio saw, so Desktop never resumes
      // a different pending handoff. Toast, pill, Retry and Let AI continue
      // all pass through here.
      const bound = boundHandoffRef.current;
      if (bound && (bound.ownerId !== ownerId || Date.now() >= bound.expiresAtMs)) {
        boundHandoffRef.current = null;
      }
      const handoffId = enabled ? boundHandoffRef.current?.handoffId ?? null : null;
      if (handoffId) {
        retireHandoffId(handoffId);
      }
      // A throw before Desktop takes the handoff (not ready, tab control,
      // a stopping operation) leaves its slot full, so the guard stays.
      let handoffKept = false;
      try {
        const next = await bridge.personalBrowserSetAgentControlEnabled({
          enabled,
          ownerId,
          ...(approvalMode ? { approvalMode } : {}),
          ...(enabled && knownHosts && knownHosts.length > 0 ? { knownHosts: [...knownHosts] } : {}),
          ...(enabled && handoffId ? { handoffId } : {}),
        });
        if (
          !mountedRef.current ||
          agentControlMutationEpochRef.current !== mutationEpoch ||
          personalBrowserOwnerIdRef.current !== ownerId ||
          next.ownerId !== ownerId
        ) {
          return null;
        }
        setAgentError(null);
        updateStatus(next);
        return next;
      } catch (error) {
        if (
          !mountedRef.current ||
          agentControlMutationEpochRef.current !== mutationEpoch ||
          personalBrowserOwnerIdRef.current !== ownerId
        ) {
          return null;
        }
        runtimeStartAttemptEpochRef.current += 1;
        setRuntimeStartState("idle");
        setStartedRuntimeId(null);
        setRuntimeDispatchReady(false);
        setRuntimePollTimedOut(false);
        setAgentError(error instanceof Error ? error.message : String(error));
        if (enabled) {
          setStatus((previous) =>
            previous
              ? {
                  ...previous,
                  agentControlEnabled: false,
                  runtimeId: undefined,
                }
              : previous,
          );
        }
        const refreshed = await bridge.personalBrowserStatus?.().catch(() => null);
        const current =
          mountedRef.current &&
          agentControlMutationEpochRef.current === mutationEpoch &&
          personalBrowserOwnerIdRef.current === ownerId;
        if (current && refreshed && refreshed.ownerId === ownerId) {
          updateStatus(refreshed);
        }
        // Desktop takes the handoff only after these checks pass; when it
        // cannot be told whether it did, the guard stays until the handoff
        // is used, paused or expired.
        handoffKept = Boolean(
          enabled &&
            handoffId &&
            current &&
            (!refreshed ||
              (refreshed.ownerId === ownerId &&
                !refreshed.agentControlEnabled &&
                (refreshed.state !== "ready" ||
                  refreshed.tabControlActive === true ||
                  refreshed.humanControlReady === false))),
        );
        return null;
      } finally {
        // Otherwise Desktop has used or emptied its handoff slot by now,
        // whether the enable succeeded or threw (a cancelled dialog), and a
        // pause always empties it.
        if (!enabled) {
          clearPendingHandoff();
        } else if (handoffId && !handoffKept) {
          clearPendingHandoff(handoffId);
        }
      }
    },
    [clearPendingHandoff, retireHandoffId, updateStatus],
  );
  const retryAgentControl = useCallback(async () => {
    const paused = await setAgentControlEnabled(false);
    if (!paused) {
      return null;
    }
    return setAgentControlEnabled(true, personalBrowserRoutineAvailable(paused)
      ? resolvePersonalBrowserApprovalMode({ status: paused, choice: approvalModeChoice })
      : undefined);
  }, [approvalModeChoice, setAgentControlEnabled]);
  const clearData = useCallback(
    async () => {
      const bridge = browserBridge();
      const ownerId = personalBrowserOwnerIdRef.current;
      if (
        !bridge ||
        !ownerId ||
        typeof bridge.personalBrowserClearData !== "function"
      ) {
        setClearDataState("failed");
        setClearDataError("Personal Browser data could not be cleared on this device.");
        return null;
      }
      const mutationEpoch = ++clearDataMutationEpochRef.current;
      setNavigationError(null);
      setClearDataState("clearing");
      setClearDataError(null);
      try {
        const next = await bridge.personalBrowserClearData({ ownerId });
        if (
          !mountedRef.current ||
          clearDataMutationEpochRef.current !== mutationEpoch ||
          personalBrowserOwnerIdRef.current !== ownerId ||
          (next.ownerId !== ownerId && next.state !== "closed")
        ) {
          return null;
        }
        updateStatus(next);
        resetHandoff();
        setNavigationError(null);
        setClearDataState("succeeded");
        return next;
      } catch (error) {
        if (
          mountedRef.current &&
          clearDataMutationEpochRef.current === mutationEpoch &&
          personalBrowserOwnerIdRef.current === ownerId
        ) {
          setClearDataState("failed");
          setClearDataError(error instanceof Error ? error.message : String(error));
        }
        return null;
      }
    },
    [resetHandoff, updateStatus],
  );
  const close = useCallback(
    () => {
      resetHandoff();
      return invoke((bridge, ownerId) => bridge.personalBrowserClose?.({ ownerId }));
    },
    [invoke, resetHandoff],
  );
  const retryOpen = useCallback(() => {
    if (openInFlightRef.current) {
      return;
    }
    openRetryRequestedRef.current = true;
    setRecovering(true);
    setNavigationError(null);
    setOpenRetryRevision((value) => value + 1);
  }, []);

  const runtimeOverride = useMemo<SubmitConversationRuntimeOverride | null>(() => {
    const statusOwnedByHook =
      identityScope !== null && openedIdentityScopeRef.current === identityScope &&
      Boolean(personalBrowserOwnerIdRef.current) &&
      status?.ownerId === personalBrowserOwnerIdRef.current;
    return resolvePersonalBrowserRuntimeOverride({
      agentControlEnabled: statusOwnedByHook && (status?.agentControlEnabled ?? false),
      agentPhase,
      browserState: statusOwnedByHook ? status?.state ?? null : null,
      runtimeId,
    });
  }, [agentPhase, identityScope, runtimeId, status?.agentControlEnabled, status?.ownerId, status?.state]);

  const preferredApprovalMode = resolvePersonalBrowserApprovalMode({ status, choice: approvalModeChoice });
  const ownedPendingHandoff: PersonalBrowserHandoff | null =
    pendingHandoff && pendingHandoff.ownerId === personalBrowserOwnerIdRef.current
      ? pendingHandoff
      : null;

  return {
    /** The person's own choice; null until they pick one. */
    approvalModeChoice,
    /** The mode a press, Resume, Retry or Let AI continue asks for. */
    preferredApprovalMode,
    setPreferredApprovalMode,
    agentError,
    agentPhase,
    available,
    checked,
    clearDataError,
    clearDataState,
    clearNavigationError,
    clearData,
    close,
    closeTab,
    goBack,
    goForward,
    navigate,
    navigationError,
    readPage,
    ownerId:
      identityScope !== null && openedIdentityScopeRef.current === identityScope && status?.ownerId === personalBrowserOwnerIdRef.current
        ? status.ownerId
        : null,
    /**
     * A sign-in handoff still waiting for Let AI continue. Unlike
     * `status.humanInputRequest`, it survives the navigations that follow a
     * sign-in, so a new browser task stays blocked until the handoff is used.
     */
    pendingHandoff: ownedPendingHandoff,
    reload,
    selectTab,
    recovering,
    retryAgentControl,
    retryOpen,
    runtimeOverride,
    setAgentControlEnabled,
    status,
  };
}
