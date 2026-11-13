import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Laptop } from "iconoir-react";
import type {
  FrontendTurnEngineComposerBridgeProps,
  FrontendTurnEngineComposerOffer,
} from "../frontendFeatureModule";
import { CLAUDE_CODE_COPY, claudeCodeSignInLine } from "./claudeCodeCopy";
import {
  resolveClaudeCodeComposerAvailability,
  resolveClaudeCodeSend,
} from "./claudeCodeComposer";
import {
  claudeCodeDesktopHostAvailable,
  readClaudeCodeDesktopStatus,
  readThisComputerRuntimeId,
  type ClaudeCodeDesktopStatus,
} from "./claudeCodeDesktop";

/**
 * The controller's lane flag is read on mount and again on focus once this
 * old; it changes only when the rollout changes, so a focus never costs every
 * Desktop on macOS a status read.
 */
const LANE_RECHECK_AFTER_MS = 5 * 60_000;

type BridgeReadings = {
  projectId: string;
  desktopStatus: ClaudeCodeDesktopStatus | null;
  laneOn: boolean;
  laneCheckedAt: number;
  thisComputerRuntimeId: string | null;
};

/**
 * Tells the composer whether to offer Claude Code for the next message. It
 * reads Desktop's own answer first, so outside Desktop, off macOS and before
 * Desktop has the module it asks the controller nothing.
 */
export function ClaudeCodeComposerBridge({ context, onOfferChange }: FrontendTurnEngineComposerBridgeProps) {
  const {
    projectId,
    threadKind,
    runtimeOptions,
    fetchRuntimeStatus,
    resolveControllerUrl,
    startOnThisComputer,
  } = context;
  const [readings, setReadings] = useState<BridgeReadings | null>(null);
  const readingsRef = useRef(readings);
  readingsRef.current = readings;
  const generationRef = useRef(0);
  const latestRef = useRef({ projectId, fetchRuntimeStatus, resolveControllerUrl, startOnThisComputer });
  latestRef.current = { projectId, fetchRuntimeStatus, resolveControllerUrl, startOnThisComputer };

  const refresh = useCallback(
    async (options: { lane: "always" | "when_stale" }) => {
      const generation = ++generationRef.current;
      if (!projectId || !claudeCodeDesktopHostAvailable()) {
        setReadings(null);
        return;
      }
      const desktopStatus = await readClaudeCodeDesktopStatus(
        await latestRef.current.resolveControllerUrl().catch(() => null),
      );
      if (generation !== generationRef.current) {
        return;
      }
      if (!desktopStatus?.supported) {
        setReadings({ projectId, desktopStatus, laneOn: false, laneCheckedAt: 0, thisComputerRuntimeId: null });
        return;
      }
      const previous = readingsRef.current?.projectId === projectId ? readingsRef.current : null;
      const now = Date.now();
      const readLane =
        options.lane === "always" || !previous || now - previous.laneCheckedAt >= LANE_RECHECK_AFTER_MS;
      const [status, thisComputerRuntimeId] = await Promise.all([
        readLane
          ? fetchRuntimeStatus({ projectId, quietOnAbort: true }).catch(() => null)
          : Promise.resolve(null),
        readThisComputerRuntimeId(projectId),
      ]);
      if (generation !== generationRef.current) {
        return;
      }
      // A status read that failed keeps what this space last said.
      const laneOn = status ? status.claudeCodeLane === true : previous?.laneOn ?? false;
      setReadings({
        projectId,
        desktopStatus,
        laneOn,
        laneCheckedAt: status ? now : previous?.laneCheckedAt ?? 0,
        thisComputerRuntimeId,
      });
    },
    [fetchRuntimeStatus, projectId],
  );

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    void refresh({ lane: "always" });
    return () => {
      generationRef.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }
    const onFocus = () => {
      void refreshRef.current({ lane: "when_stale" });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Desktop replaces its runtime (a start, a stop, Claude Code turned on or
  // off) without telling Studio; the runtime list changes when it does.
  const runtimeIdsKey = runtimeOptions.map((option) => option.id ?? "").join("\u0000");
  const seenRuntimeIdsKeyRef = useRef(runtimeIdsKey);
  useEffect(() => {
    if (seenRuntimeIdsKeyRef.current === runtimeIdsKey) {
      return;
    }
    seenRuntimeIdsKeyRef.current = runtimeIdsKey;
    if (readingsRef.current?.desktopStatus?.supported) {
      void refreshRef.current({ lane: "when_stale" });
    }
  }, [runtimeIdsKey]);

  const availability = useMemo(
    () =>
      readings && readings.projectId === projectId
        ? resolveClaudeCodeComposerAvailability({
            desktopStatus: readings.desktopStatus,
            laneOn: readings.laneOn,
            thisComputerRuntimeId: readings.thisComputerRuntimeId,
            runtimeOptions,
            threadKind,
          })
        : ({ kind: "hidden" } as const),
    [projectId, readings, runtimeOptions, threadKind],
  );
  const visible = availability.kind !== "hidden";
  const disabledReason = availability.kind === "disabled" ? availability.reason : null;
  const startAction = availability.kind === "disabled" && availability.startAction;
  const planSignIn = availability.kind !== "hidden" && availability.planSignIn;

  const offer = useMemo<FrontendTurnEngineComposerOffer | null>(() => {
    if (!visible) {
      return null;
    }
    return {
      icon: <Laptop aria-hidden="true" />,
      row: {
        title: CLAUDE_CODE_COPY.rowTitle,
        description: claudeCodeSignInLine(planSignIn),
        hint: CLAUDE_CODE_COPY.rowHint,
        testId: "composer-action-menu-claude-code",
        disabledReason,
        action: startAction
          ? {
              label: CLAUDE_CODE_COPY.startAction,
              testId: "composer-action-menu-claude-code-start",
              onPress: () => latestRef.current.startOnThisComputer(),
            }
          : null,
      },
      token: {
        label: CLAUDE_CODE_COPY.tokenLabel,
        cancelLabel: CLAUDE_CODE_COPY.tokenCancel,
        testId: "composer-claude-code",
      },
      resolveSend: (input) =>
        resolveClaudeCodeSend(input, {
          projectId: latestRef.current.projectId,
          fetchRuntimeStatus: latestRef.current.fetchRuntimeStatus,
          readDesktopStatus: async () =>
            readClaudeCodeDesktopStatus(
              await latestRef.current.resolveControllerUrl().catch(() => null),
            ),
          readThisComputerRuntimeId,
          startOnThisComputer: () => latestRef.current.startOnThisComputer(),
        }),
    };
  }, [disabledReason, planSignIn, startAction, visible]);

  useEffect(() => {
    onOfferChange(offer);
  }, [offer, onOfferChange]);
  useEffect(() => () => onOfferChange(null), [onOfferChange]);

  return null;
}
