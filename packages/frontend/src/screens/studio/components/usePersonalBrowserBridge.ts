import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SubmitConversationRuntimeOverride } from "../../../conversations/useConversation";
import { runtimeEntryIsDispatchable } from "../../../runtime/utils/runtimeEntry";
import { controllerClient } from "../../../sdk/instafy";
import { controllerBaseUrl } from "../../../services/runtimeController/core";
import { normalizeBrowserAddress } from "./browserAddress";

export type BrowserTransport = "personal" | "shared";
export type PersonalBrowserAgentPhase = "idle" | "starting" | "ready" | "unavailable";
export type PersonalBrowserClearDataState = "idle" | "clearing" | "succeeded" | "failed";

const PERSONAL_BROWSER_RUNTIME_READY_TIMEOUT_MS = 45_000;
const PERSONAL_BROWSER_RUNTIME_POLL_MS = 1_500;

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
}: {
  active: boolean;
  profileUserId: string | null;
  projectId: string | null;
}) {
  const [checked, setChecked] = useState(false);
  const [status, setStatus] = useState<InstafyDesktopPersonalBrowserStatus | null>(null);
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
  const desiredIdentityScopeRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const runtimeStartIdentityScopeRef = useRef<string | null>(null);
  const runtimeStartAttemptEpochRef = useRef(0);
  const agentControlMutationEpochRef = useRef(0);
  const clearDataMutationEpochRef = useRef(0);
  const observedHostRuntimeIdRef = useRef<string | null>(null);
  const identityScope = personalBrowserIdentityScope(projectId, profileUserId);
  const previousIdentityScopeRef = useRef(identityScope);
  desiredIdentityScopeRef.current = identityScope;

  useLayoutEffect(() => {
    if (previousIdentityScopeRef.current !== identityScope) {
      previousIdentityScopeRef.current = identityScope;
      retiredPersonalBrowserOwnerIdRef.current = personalBrowserOwnerIdRef.current;
      personalBrowserOwnerIdRef.current = null;
      openAttemptEpochRef.current += 1;
      runtimeStartAttemptEpochRef.current += 1;
      agentControlMutationEpochRef.current += 1;
      clearDataMutationEpochRef.current += 1;
      openRetryRequestedRef.current = false;
      setRecovering(false);
      setNavigationError(null);
      setClearDataState("idle");
      setClearDataError(null);
    }
    if (runtimeStartIdentityScopeRef.current !== identityScope) {
      runtimeStartIdentityScopeRef.current = identityScope;
      setRuntimeStartState("idle");
      setStartedRuntimeId(null);
      setRuntimeDispatchReady(false);
      setRuntimePollTimedOut(false);
      setAgentError(null);
      observedHostRuntimeIdRef.current = null;
    }
  }, [identityScope]);

  const updateStatus = useCallback((next: InstafyDesktopPersonalBrowserStatus) => {
    if (!next.agentControlEnabled) {
      runtimeStartAttemptEpochRef.current += 1;
    }
    setStatus(next);
    setChecked(true);
  }, []);

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
      void closePersonalBrowserOwnership(bridge, ownerId);
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
    const openingAttemptEpoch = ++openAttemptEpochRef.current;
    void (async () => {
      let shouldRetry = false;
      try {
        const next = await openPersonalBrowser({
          projectId,
          controllerUrl: controllerBaseUrl,
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
  }, [active, available, identityScope, openRetryRevision, profileUserId, projectId, status?.projectId, status?.state, updateStatus]);

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
      const controllerAccessToken = await controllerClient.core.resolveAccessToken(null);
      if (!startAttemptIsCurrent()) {
        return;
      }
      if (!controllerAccessToken) {
        throw new Error("Sign in again to enable personal browser agent control.");
      }
      const result = await bridge.startDesktopRuntime?.({
        projectId,
        controllerUrl: controllerBaseUrl,
        controllerAccessToken,
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
  const setAgentControlEnabled = useCallback(
    async (enabled: boolean) => {
      const bridge = browserBridge();
      const ownerId = personalBrowserOwnerIdRef.current;
      if (
        !ownerId ||
        typeof bridge?.personalBrowserSetAgentControlEnabled !== "function"
      ) {
        return null;
      }
      const mutationEpoch = ++agentControlMutationEpochRef.current;
      try {
        const next = await bridge.personalBrowserSetAgentControlEnabled({
          enabled,
          ownerId,
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
        if (
          refreshed &&
          mountedRef.current &&
          agentControlMutationEpochRef.current === mutationEpoch &&
          personalBrowserOwnerIdRef.current === ownerId &&
          refreshed.ownerId === ownerId
        ) {
          updateStatus(refreshed);
        }
        return null;
      }
    },
    [updateStatus],
  );
  const retryAgentControl = useCallback(async () => {
    const paused = await setAgentControlEnabled(false);
    if (!paused) {
      return null;
    }
    return setAgentControlEnabled(true);
  }, [setAgentControlEnabled]);
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
    [updateStatus],
  );
  const close = useCallback(
    () => invoke((bridge, ownerId) => bridge.personalBrowserClose?.({ ownerId })),
    [invoke],
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
      Boolean(personalBrowserOwnerIdRef.current) &&
      status?.ownerId === personalBrowserOwnerIdRef.current;
    return resolvePersonalBrowserRuntimeOverride({
      agentControlEnabled: statusOwnedByHook && (status?.agentControlEnabled ?? false),
      agentPhase,
      browserState: statusOwnedByHook ? status?.state ?? null : null,
      runtimeId,
    });
  }, [agentPhase, runtimeId, status?.agentControlEnabled, status?.ownerId, status?.state]);

  return {
    agentError,
    agentPhase,
    available,
    checked,
    clearDataError,
    clearDataState,
    clearNavigationError,
    clearData,
    close,
    goBack,
    goForward,
    navigate,
    navigationError,
    ownerId:
      status?.ownerId === personalBrowserOwnerIdRef.current
        ? status.ownerId
        : null,
    reload,
    recovering,
    retryAgentControl,
    retryOpen,
    runtimeOverride,
    setAgentControlEnabled,
    status,
  };
}
