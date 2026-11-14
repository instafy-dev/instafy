import {
  createElement,
  lazy,
  type ComponentType,
  type ReactNode,
} from "react";
import type { AssistantProviderDefinition } from "@instafy/sdk/agents";
import type {
  CapabilityExecutorProviderDefinition,
  CapabilityProviderDefinition,
} from "@instafy/sdk/capabilities";
import {
  collectInstafyFeatureModuleContributions,
  validateInstafyFeatureModules,
  type InstafyFeatureModule,
} from "@instafy/sdk/feature-modules";
import type { NativeExtensionRegistration } from "../extensions/nativeExtensionTypes";
import type { NativeRuntimeFamilyRegistration } from "../extensions/nativeRuntimeProviderTypes";
import type {
  LocalCapabilityArtifactRegistration,
  LocalCapabilityRouteDefinition,
} from "../capabilities/localCapabilityContributions";
import type { NativeCapabilityRuntimeRegistration } from "../extensions/nativeCapabilityRuntimeTypes";
import type { VisionClassifierRegistration } from "../camera/visionTypes";
import type { SubmitConversationRuntimeOverride } from "../conversations/conversationSubmitTypes";
import type { RuntimeMenuOption } from "../runtime/useRuntimeMenu";
import type {
  ControllerRuntimeStatusEntry,
  FetchRuntimeStatusParams,
  FetchRuntimeStatusResult,
} from "../services/runtimeController/runtimes";
import type { FrontendFeatureServices } from "./frontendFeatureServices";

export interface TrustedFrontendRouteContribution {
  id: string;
  path: string;
  element: ReactNode;
}

/**
 * A trusted, build-time-selected background bridge mounted inside the Studio
 * provider graph. Product-specific integrations contribute these from their
 * own feature module; the public application never imports them by name.
 */
export interface FrontendStudioRuntimeBridgeContribution {
  id: string;
  component: ComponentType;
}

export function createLazyFrontendRouteElement(
  load: () => Promise<{ default: ComponentType }>,
): ReactNode {
  const RouteComponent = lazy(load);
  return createElement(RouteComponent);
}

/**
 * The metadata key of a turn-engine claim: a send that carries
 * `turnEngine: <engine id>` asks for its one turn to run on that engine
 * instead of the runtime's own (docs/Local-Engine-Turns.md). The core adds it
 * only to the composer's own Send of the draft it shows, through the engine's
 * routing, and never queues, stores, stashes or resends it.
 */
export const TURN_ENGINE_CLAIM_KEY = "turnEngine";
// The controller reads the claim under either spelling.
const TURN_ENGINE_CLAIM_KEYS = [TURN_ENGINE_CLAIM_KEY, "turn_engine"] as const;

function readMetadataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The engine a send's metadata claims, or null. */
export function readTurnEngineClaim(metadata: unknown): string | null {
  const record = readMetadataRecord(metadata);
  for (const key of TURN_ENGINE_CLAIM_KEYS) {
    const claim = record?.[key];
    if (typeof claim === "string" && claim.trim().length > 0) {
      return claim;
    }
  }
  return null;
}

/** Whether the metadata holds a turn-engine claim of any value, under either spelling. */
export function carriesTurnEngineClaim(metadata: unknown): boolean {
  const record = readMetadataRecord(metadata);
  return TURN_ENGINE_CLAIM_KEYS.some(
    (key) => record?.[key] !== undefined && record?.[key] !== null,
  );
}

/**
 * The metadata without any turn-engine claim key, whatever its value (the
 * controller refuses even a null one); the same object when it holds none.
 */
export function withoutTurnEngineClaim(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!metadata) {
    return null;
  }
  if (!TURN_ENGINE_CLAIM_KEYS.some((key) => Object.prototype.hasOwnProperty.call(metadata, key))) {
    return metadata;
  }
  const rest = { ...metadata };
  for (const key of TURN_ENGINE_CLAIM_KEYS) {
    delete rest[key];
  }
  return rest;
}

// The `aiAccessMode` of a turn the runtime's own engine runs: on Instafy AI,
// or on the person's own AI connection. The controller stamps any other mode
// only on the messages of a turn an engine ran instead.
const RUNTIME_ENGINE_AI_ACCESS_MODES: ReadonlySet<string> = new Set(["managed", "byoc"]);

/**
 * Whether the metadata's `aiAccessMode` names an engine other than the
 * runtime's own: a turn engine's id, whether or not this Studio was built
 * with that engine. A build without an engine's module, such as a tab opened
 * before a deploy, so still never resends, retries or titles from its turns.
 */
export function namesTurnEngineAccessMode(metadata: unknown): boolean {
  const accessMode = readMetadataRecord(metadata)?.aiAccessMode;
  if (typeof accessMode !== "string") {
    return false;
  }
  const normalized = accessMode.trim().toLowerCase();
  return normalized.length > 0 && !RUNTIME_ENGINE_AI_ACCESS_MODES.has(normalized);
}

/**
 * Whether a message belongs to a turn-engine turn: it carries a claim (the
 * sender's own copy before the controller answers), or the controller stamped
 * another engine than the runtime's own as its `aiAccessMode`
 * ({@link namesTurnEngineAccessMode}).
 */
export function messageUsesTurnEngine(metadata: unknown): boolean {
  return carriesTurnEngineClaim(metadata) || namesTurnEngineAccessMode(metadata);
}

/** What the core composer tells a turn engine about the composer it serves. */
export interface FrontendTurnEngineComposerContext {
  projectId: string | null;
  /** The chat's thread kind (learn, agent or automation thread), or null. */
  threadKind: string | null;
  /** This space's runtimes, as the runtime menu lists them. */
  runtimeOptions: readonly RuntimeMenuOption[];
  fetchRuntimeStatus: (
    params: FetchRuntimeStatusParams,
  ) => Promise<FetchRuntimeStatusResult | null>;
  /** The controller this Studio talks to now, or null when it has none. */
  resolveControllerUrl: () => Promise<string | null>;
  /** The existing action that starts this space on this computer. */
  startOnThisComputer: () => void;
}

/** The engine's row in the composer's "+" menu. */
export interface FrontendTurnEngineMenuRow {
  title: string;
  description: string;
  /** A second line under the description, while the row can be chosen. */
  hint: string | null;
  testId: string;
  /** Why the row cannot be chosen now, shown in place of its description; null when it can. */
  disabledReason: string | null;
  /** An action offered beside a disabled row, such as starting this space here. */
  action: { label: string; testId: string; onPress: () => void } | null;
}

/** The token the composer shows while the engine is chosen for the next message. */
export interface FrontendTurnEngineToken {
  label: string;
  cancelLabel: string;
  /** The token is `${testId}-token` and its cancel action `${testId}-cancel`. */
  testId: string;
}

/** The facts of a composer Send while an engine is chosen, for the engine to decide on. */
export interface FrontendTurnEngineSendInput {
  /** The text that would go out, trimmed. */
  message: string;
  intent: "send" | "queue" | "steer";
  /** Sent by the app on the person's behalf. */
  automatic: boolean;
  /** The text would start an agent turn (not a local capability, AI not turned off). */
  requiresAgentTurn: boolean;
  terminalCommand: boolean;
  attachmentCount: number;
  threadKind: string | null;
  /** The agents the message is for, from its words and the chat's defaults. */
  targetHandles: readonly string[];
  /** Sent from a browser's own composer, Shared or Personal. */
  browserComposer: boolean;
  /** A new browser tab is pending for this message. */
  newBrowserTab: boolean;
  /** An agent here is still replying or the last message is still sending, so the send would be queued. */
  chatBusy: boolean;
  /** The send would first open a private chat's invite prompt. */
  opensInvitePrompt: boolean;
}

export type FrontendTurnEngineSendDecision =
  | {
      kind: "blocked";
      /** Shown to the person; their text and the choice stay as they are. */
      notice: string;
      action?: { label: string; onAction: () => void } | null;
    }
  | {
      kind: "route";
      runtimeOverride: SubmitConversationRuntimeOverride;
      /** Metadata the engine's turn needs beside the claim, which the core adds. */
      metadata: Record<string, unknown>;
    };

/** What the composer shows for one engine, and how it routes a Send. */
export interface FrontendTurnEngineComposerOffer {
  /** A neutral glyph for the row and the token; never a brand logo. */
  icon: ReactNode;
  row: FrontendTurnEngineMenuRow;
  token: FrontendTurnEngineToken;
  resolveSend: (input: FrontendTurnEngineSendInput) => Promise<FrontendTurnEngineSendDecision>;
}

export interface FrontendTurnEngineComposerBridgeProps {
  context: FrontendTurnEngineComposerContext;
  /** Reports the engine's offer for this composer, or null when it is not offered here. */
  onOfferChange: (offer: FrontendTurnEngineComposerOffer | null) => void;
}

/** Who sent a turn-engine turn, as far as the chat can tell. */
export type TurnEngineTurnOwner = {
  /** The person viewing sent it. */
  isViewer: boolean;
  /** Their name, when the chat knows it. */
  name: string | null;
};

/** What a turn engine is told about one of its failed turns. */
export type TurnEngineFailureInput = {
  /** The failure message's metadata, as the controller wrote it. */
  metadata: Record<string, unknown>;
  /** The failure's own text, which Details keeps. */
  rawText: string;
  /** The raw text's first line when it reads plainly (docs/Chat-Activity.md), else null. */
  plainFirstLine: string | null;
  /** Whether words read plainly, by the same rule. */
  readsPlainly: (text: string) => boolean;
  /** The status entry of the runtime that ran the turn, when the viewer has it. */
  runtime: ControllerRuntimeStatusEntry | null;
};

/** How a turn engine's turns read in the chat. */
export interface FrontendTurnEnginePresentation {
  /**
   * Whether the controller stamped this message as one of the engine's turns.
   * A client's claim, or an `aiAccessMode` a client could record, never counts.
   */
  isControllerStamped(metadata: Record<string, unknown>): boolean;
  /**
   * What one of the engine's turns reads from its send until its first step,
   * in the typing row and the turn's own line, in place of "Starting…", worded
   * for whoever views it; `owner` is null when the chat cannot tell who sent
   * the turn.
   */
  describeStart(owner: TurnEngineTurnOwner | null): string;
  /** The sentence the person who sent a failed turn reads. */
  describeTurnFailure(failure: TurnEngineFailureInput): string;
  /** What everyone else reads for a failed turn; `ownerName` is null when the chat does not know it. */
  describeTeammateTurnFailure(ownerName: string | null): string;
  /**
   * The sentence for a send that claimed this engine and that the controller
   * refused with `code`, or null when the engine does not word that code.
   */
  describeSendRefusal(refusal: { code: string; details: unknown }): string | null;
  /** The sentence for a refused Steer into one of the engine's turns, or null. */
  describeSteerRefusal(code: string): string | null;
  /** The plain-text line under a reply's header; `owner` is null when the chat cannot tell who sent the turn. */
  describeSpeaker(owner: TurnEngineTurnOwner | null): string;
  /** The sender's action on a failed turn that puts its message back in the composer with this engine chosen. */
  resendLabel: string;
}

/** What Your AI gives a turn engine's row (docs/Local-Engine-Turns.md 5.3). */
export interface FrontendTurnEngineYourAiRowProps {
  /** A space's runtime status, including whether the engine's lane covers the viewer. */
  fetchRuntimeStatus: (params: FetchRuntimeStatusParams) => Promise<FetchRuntimeStatusResult | null>;
  /** The controller this Studio talks to now, or null. */
  resolveControllerUrl: () => Promise<string | null>;
}

/**
 * An engine one composer message can run on instead of the runtime's own.
 * The core composer renders its row, its token and its send gate from the
 * offer its bridge reports; everything specific to the engine (whether and
 * where it is offered, its wording, its routing) stays in its feature module.
 */
export interface FrontendTurnEngineContribution {
  /** The claim's value, and the `aiAccessMode` the controller stamps on the turn's messages. */
  id: string;
  /** Mounted once beside the composer; renders nothing itself. */
  ComposerBridge: ComponentType<FrontendTurnEngineComposerBridgeProps>;
  /** How the engine's turns read in the chat; without it the chat words them as any other turn. */
  presentation?: FrontendTurnEnginePresentation;
  /**
   * A status row among Your AI's connections. It is never a connection,
   * never the default and never in the connect modal; it renders nothing
   * where the engine is not offered.
   */
  YourAiRow?: ComponentType<FrontendTurnEngineYourAiRowProps>;
}

export interface FrontendFeatureContributions {
  assistantProviders?: readonly AssistantProviderDefinition[];
  capabilityAssistantProviders?: readonly AssistantProviderDefinition[];
  capabilityProviders?: readonly CapabilityProviderDefinition[];
  executorProviders?: readonly CapabilityExecutorProviderDefinition<FrontendFeatureServices>[];
  routes?: readonly TrustedFrontendRouteContribution[];
  studioRuntimeBridges?: readonly FrontendStudioRuntimeBridgeContribution[];
  nativeExtensionRegistrations?: readonly NativeExtensionRegistration[];
  nativeRuntimeFamilyRegistrations?: readonly NativeRuntimeFamilyRegistration[];
  nativeCapabilityRuntimeRegistrations?: readonly NativeCapabilityRuntimeRegistration[];
  localCapabilityRoutes?: readonly LocalCapabilityRouteDefinition[];
  localCapabilityArtifactRegistrations?: readonly LocalCapabilityArtifactRegistration[];
  visionClassifierRegistrations?: readonly VisionClassifierRegistration[];
  turnEngines?: readonly FrontendTurnEngineContribution[];
}

export type FrontendFeatureModule = InstafyFeatureModule<FrontendFeatureContributions>;

export interface FrontendFeatureComposition {
  modules: readonly FrontendFeatureModule[];
  assistantProviders: readonly AssistantProviderDefinition[];
  capabilityAssistantProviders: readonly AssistantProviderDefinition[];
  capabilityProviders: readonly CapabilityProviderDefinition[];
  executorProviders: readonly CapabilityExecutorProviderDefinition<FrontendFeatureServices>[];
  routes: readonly TrustedFrontendRouteContribution[];
  studioRuntimeBridges: readonly FrontendStudioRuntimeBridgeContribution[];
  nativeExtensionRegistrations: readonly NativeExtensionRegistration[];
  nativeRuntimeFamilyRegistrations: readonly NativeRuntimeFamilyRegistration[];
  nativeCapabilityRuntimeRegistrations: readonly NativeCapabilityRuntimeRegistration[];
  localCapabilityRoutes: readonly LocalCapabilityRouteDefinition[];
  localCapabilityArtifactRegistrations: readonly LocalCapabilityArtifactRegistration[];
  visionClassifierRegistrations: readonly VisionClassifierRegistration[];
  turnEngines: readonly FrontendTurnEngineContribution[];
}

function assertUniqueContributionIds<TContribution>(
  kind: string,
  contributions: readonly TContribution[],
  getId: (contribution: TContribution) => string,
) {
  const seenIds = new Set<string>();
  for (const contribution of contributions) {
    const id = getId(contribution);
    if (
      typeof id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(id)
    ) {
      throw new Error(
        `Frontend feature ${kind} contribution has invalid id ${JSON.stringify(id)}.`,
      );
    }
    if (seenIds.has(id)) {
      throw new Error(`Duplicate frontend feature ${kind} contribution id "${id}".`);
    }
    seenIds.add(id);
  }
}

export function createFrontendFeatureComposition(
  modules: readonly FrontendFeatureModule[],
): FrontendFeatureComposition {
  const validatedModules = validateInstafyFeatureModules(modules);
  const assistantProviders = collectInstafyFeatureModuleContributions(
    validatedModules,
    "assistantProviders",
  );
  const capabilityAssistantProviders = collectInstafyFeatureModuleContributions(
    validatedModules,
    "capabilityAssistantProviders",
  );
  const capabilityProviders = collectInstafyFeatureModuleContributions(
    validatedModules,
    "capabilityProviders",
  );
  const executorProviders = collectInstafyFeatureModuleContributions(
    validatedModules,
    "executorProviders",
  );
  const routes = collectInstafyFeatureModuleContributions(validatedModules, "routes");
  const studioRuntimeBridges = collectInstafyFeatureModuleContributions(
    validatedModules,
    "studioRuntimeBridges",
  );
  const nativeExtensionRegistrations = collectInstafyFeatureModuleContributions(
    validatedModules,
    "nativeExtensionRegistrations",
  );
  const nativeRuntimeFamilyRegistrations =
    collectInstafyFeatureModuleContributions(
      validatedModules,
      "nativeRuntimeFamilyRegistrations",
    );
  const nativeCapabilityRuntimeRegistrations =
    collectInstafyFeatureModuleContributions(
      validatedModules,
      "nativeCapabilityRuntimeRegistrations",
    );
  const localCapabilityRoutes = collectInstafyFeatureModuleContributions(
    validatedModules,
    "localCapabilityRoutes",
  );
  const localCapabilityArtifactRegistrations =
    collectInstafyFeatureModuleContributions(
      validatedModules,
      "localCapabilityArtifactRegistrations",
    );
  const visionClassifierRegistrations =
    collectInstafyFeatureModuleContributions(
      validatedModules,
      "visionClassifierRegistrations",
    );
  const turnEngines = collectInstafyFeatureModuleContributions(
    validatedModules,
    "turnEngines",
  );

  assertUniqueContributionIds("assistant provider", assistantProviders, (provider) => provider.id);
  assertUniqueContributionIds(
    "capability assistant provider",
    capabilityAssistantProviders,
    (provider) => provider.id,
  );
  assertUniqueContributionIds("capability provider", capabilityProviders, (provider) => provider.id);
  assertUniqueContributionIds("executor provider", executorProviders, (provider) => provider.id);
  assertUniqueContributionIds("route", routes, (route) => route.id);
  assertUniqueContributionIds(
    "Studio runtime bridge",
    studioRuntimeBridges,
    (bridge) => bridge.id,
  );
  assertUniqueContributionIds(
    "native extension",
    nativeExtensionRegistrations,
    (registration) => registration.definition.familyId,
  );
  assertUniqueContributionIds(
    "native runtime family",
    nativeRuntimeFamilyRegistrations,
    (registration) => registration.familyId,
  );
  assertUniqueContributionIds(
    "native capability runtime",
    nativeCapabilityRuntimeRegistrations,
    (registration) => registration.familyId,
  );
  assertUniqueContributionIds(
    "local capability route",
    localCapabilityRoutes,
    (route) => route.id,
  );
  assertUniqueContributionIds(
    "local capability artifact",
    localCapabilityArtifactRegistrations,
    (registration) => registration.id,
  );
  assertUniqueContributionIds(
    "vision classifier",
    visionClassifierRegistrations,
    (registration) => registration.id,
  );
  assertUniqueContributionIds("turn engine", turnEngines, (engine) => engine.id);
  for (const engine of turnEngines) {
    const bridge: unknown = engine.ComposerBridge;
    if (!bridge || (typeof bridge !== "function" && typeof bridge !== "object")) {
      throw new Error(`Frontend feature turn engine "${engine.id}" requires a composer bridge.`);
    }
  }

  const seenPaths = new Set<string>();
  for (const route of routes) {
    if (
      !route.path ||
      route.path !== route.path.trim() ||
      route.path.startsWith("/") ||
      route.path.split("/").includes("..")
    ) {
      throw new Error(
        `Frontend feature route "${route.id}" requires a non-empty relative path.`,
      );
    }
    if (seenPaths.has(route.path)) {
      throw new Error(`Duplicate frontend feature route path "${route.path}".`);
    }
    seenPaths.add(route.path);
  }

  return Object.freeze({
    modules: validatedModules,
    assistantProviders,
    capabilityAssistantProviders,
    capabilityProviders,
    executorProviders,
    routes,
    studioRuntimeBridges,
    nativeExtensionRegistrations,
    nativeRuntimeFamilyRegistrations,
    nativeCapabilityRuntimeRegistrations,
    localCapabilityRoutes,
    localCapabilityArtifactRegistrations,
    visionClassifierRegistrations,
    turnEngines,
  });
}
