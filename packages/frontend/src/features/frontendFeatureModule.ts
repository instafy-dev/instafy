import {
  createElement,
  lazy,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  AGENT_SIGN_IN_KEYS,
  type AssistantProviderDefinition,
  type ControllerAgentProfile,
  type CreateMyAgentInput,
  type UpdateMyAgentInput,
} from "@instafy/sdk/agents";
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

// The `aiAccessMode` of a turn the runtime's own engine runs: on Instafy AI,
// or on the person's own AI connection. The controller stamps any other mode
// only on the messages of a turn an engine ran instead.
const RUNTIME_ENGINE_AI_ACCESS_MODES: ReadonlySet<string> = new Set(["managed", "byoc"]);

function readMetadataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Whether the metadata's `aiAccessMode` names an engine other than the
 * runtime's own: a turn engine's id, whether or not this Studio was built
 * with that engine. A build without an engine's module, such as a tab opened
 * before a deploy, so still never sends such a turn again by itself.
 */
export function namesTurnEngineAccessMode(metadata: unknown): boolean {
  const accessMode = readMetadataRecord(metadata)?.aiAccessMode;
  if (typeof accessMode !== "string") {
    return false;
  }
  const normalized = accessMode.trim().toLowerCase();
  return normalized.length > 0 && !RUNTIME_ENGINE_AI_ACCESS_MODES.has(normalized);
}

/** Whose turn a turn-engine turn is, as far as the chat can tell. */
export type TurnEngineTurnOwner = {
  /** It is the viewer's own turn. */
  isViewer: boolean;
  /** Their name, when the chat knows it. */
  name: string | null;
};

/**
 * What the chat tells a turn engine's speaker line of the sign-in a reply ran
 * on (docs/Local-Engine-Turns.md 11.20), for the turn's own person alone, once
 * they have more than one sign-in and the reply names one of theirs.
 */
export type TurnEngineSpeakerSignIn = {
  /** It was one of the agent's backups, not its first AI. */
  backup: boolean;
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
   * An `aiAccessMode` a client could record never counts on its own.
   */
  isControllerStamped(metadata: Record<string, unknown>): boolean;
  /**
   * What one of the engine's turns reads once a computer took it, until its
   * first step, in the typing row and the turn's own line, in place of
   * "Starting…", worded for whoever views it; `owner` is null when the chat
   * cannot tell whose turn it is.
   */
  describeStart(owner: TurnEngineTurnOwner | null): string;
  /**
   * What one of the engine's turns reads while it waits for a computer to
   * take it (its run is queued, docs/Local-Engine-Turns.md 11.14), in the same
   * places. `runtimes` are the space's status entries the viewer has, of which
   * only the viewer's own say anything about the engine. `metadata` is the
   * metadata that carries the controller's stamp: the run's, or until the page
   * has it, its prompt's.
   */
  describeWaiting(
    owner: TurnEngineTurnOwner | null,
    runtimes: readonly ControllerRuntimeStatusEntry[],
    metadata?: Readonly<Record<string, unknown>> | null,
  ): string;
  /** The sentence the person whose turn failed reads. */
  describeTurnFailure(failure: TurnEngineFailureInput): string;
  /** What everyone else reads for a failed turn; `ownerName` is null when the chat does not know it. */
  describeTeammateTurnFailure(ownerName: string | null): string;
  /**
   * The sentence for a send the controller refused with `code`, before it
   * recorded anything, because a turn it would start runs on this engine; null
   * when the engine does not word that code.
   */
  describeSendRefusal(refusal: { code: string; details: unknown }): string | null;
  /** The sentence for a refused Steer into one of the engine's turns, or null. */
  describeSteerRefusal(code: string): string | null;
  /**
   * The plain-text line under a reply's header; `owner` is null when the chat
   * cannot tell whose turn it was. `metadata` is the reply's, with the
   * controller's stamp. `signIn` is what the chat read, for the turn's own
   * person only, of the sign-in it ran on (docs/Local-Engine-Turns.md 11.20):
   * `backup` while it was one of the agent's backups, which the line then says.
   */
  describeSpeaker(
    owner: TurnEngineTurnOwner | null,
    metadata?: Readonly<Record<string, unknown>> | null,
    signIn?: TurnEngineSpeakerSignIn | null,
  ): string;
  /**
   * For words that read what the engine loads for the viewer, such as their
   * own sign-ins: called while a line of the engine's shows, with `onChange`
   * for when its lines may read differently. Returns the call that stops it.
   * Without it, a line reads the same until what it is given changes.
   */
  subscribe?(onChange: () => void): () => void;
}

/** What a waiting turn's row gives the engine's note for the person whose turn it is. */
export interface FrontendTurnEngineWaitingNoteProps {
  /** The space the turn waits in. */
  projectId: string;
  /** The space's runtime status entries the viewer has. */
  runtimes: readonly ControllerRuntimeStatusEntry[];
  /**
   * Starts this space on this computer, as the existing Start action does;
   * null where Studio cannot (outside Instafy Desktop).
   */
  startOnThisComputer: (() => void) | null;
  /** That start is under way. */
  starting: boolean;
  /** The controller this Studio talks to now, or null when it has none. */
  resolveControllerUrl: () => Promise<string | null>;
  /** The waiting run's metadata, with the controller's stamp, when the chat has it. */
  runMetadata?: Readonly<Record<string, unknown>> | null;
}

/** What the agent editor gives the engine's note under its choice. */
export interface FrontendTurnEngineAgentAiNoteProps {
  /** The controller this Studio talks to now, or null when it has none. */
  resolveControllerUrl: () => Promise<string | null>;
}

/** The fields of an agent the editor itself sends: its profile, which AI it uses, and its backups. */
export const AGENT_EDITOR_OWN_FIELDS = [
  "handle",
  "displayName",
  "description",
  "bio",
  "avatarSeed",
  "provider",
  "credentialId",
  "model",
  "reasoningEffort",
  "projectId",
  "runtimeId",
  "backupAis",
] as const;

/**
 * Fields an engine adds to the request that saves an agent whose AI it is
 * (`POST /me/agents`, `PATCH /me/agents/:id`), named as the controller names
 * them. The editor sends them beside the engine's id, never one of its own
 * fields ({@link AGENT_EDITOR_OWN_FIELDS}).
 */
export type TurnEngineAgentAiRequestFields = Readonly<
  Omit<Partial<CreateMyAgentInput & UpdateMyAgentInput>, (typeof AGENT_EDITOR_OWN_FIELDS)[number]>
>;

const AGENT_EDITOR_OWN_FIELD_NAMES: ReadonlySet<string> = new Set(AGENT_EDITOR_OWN_FIELDS);

/** An engine's fields as the editor sends them: without any field the editor sends itself. */
export function turnEngineAgentAiRequestFields(
  fields: TurnEngineAgentAiRequestFields | null | undefined,
): TurnEngineAgentAiRequestFields {
  if (!fields) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(fields).filter(([name]) => !AGENT_EDITOR_OWN_FIELD_NAMES.has(name)),
  ) as TurnEngineAgentAiRequestFields;
}

/** What the agent editor gives the engine's own fields while it is the agent's AI. */
export interface FrontendTurnEngineAgentAiFieldsProps {
  /** The agent being edited, as the agents list returned it; null while a new one is made. */
  agent: ControllerAgentProfile | null;
  /** What the fields set since the editor opened (or since the engine was chosen), or null for nothing yet. */
  fields: TurnEngineAgentAiRequestFields | null;
  /** Sets what saving sends; setting anything makes the editor's draft one to save. */
  onFieldsChange: (fields: TurnEngineAgentAiRequestFields) => void;
  /** The editor is saving. */
  disabled: boolean;
  /** The controller this Studio talks to now, or null when it has none. */
  resolveControllerUrl: () => Promise<string | null>;
}

/** What a list of agents gives the engine's name for one agent's AI. */
export interface FrontendTurnEngineAgentAiLabelProps {
  agent: ControllerAgentProfile;
}

/**
 * The engine as an agent's AI (docs/Local-Engine-Turns.md 11.3): the agent
 * editor in Your AI offers it beside Instafy AI and the person's own
 * connections, and every turn of an agent that uses it runs on it.
 */
export interface FrontendTurnEngineAgentAi {
  /** Its name, wherever an agent's AI is listed. */
  label: string;
  /** A neutral glyph beside its name in the editor's choice; never a brand logo (D28). */
  icon: ReactNode;
  /** The line under it in the agent editor. */
  description: string;
  /** Whether the editor offers it to this viewer, from the open space's runtime status. */
  offeredBy(status: FetchRuntimeStatusResult): boolean;
  /**
   * The sentence for a save of an agent's AI that the controller refused
   * with `code`, or null when the engine does not word that code.
   */
  describeSaveRefusal(refusal: { code: string; details: unknown }): string | null;
  /** Under the choice while it is chosen: what it still needs, such as setting it up here; often nothing. */
  Note?: ComponentType<FrontendTurnEngineAgentAiNoteProps>;
  /**
   * More of the agent's AI under the choice while it is chosen, such as which
   * of the person's sign-ins the agent's turns run on: fields the editor
   * shows and whose values saving sends. Renders nothing where there is
   * nothing to choose.
   */
  Fields?: ComponentType<FrontendTurnEngineAgentAiFieldsProps>;
  /**
   * The AI's name for one agent, wherever an agent's AI is listed, when
   * `label` alone does not say all of it; plain text. Without it, `label`.
   */
  AgentLabel?: ComponentType<FrontendTurnEngineAgentAiLabelProps>;
}

/** One of the viewer's own sign-ins a turn engine runs turns on, such as one of their logins. */
export interface TurnEngineSignIn {
  /** Its id, a UUID in lowercase. */
  id: string;
  /** The name its owner gave it; Studio shows it only to them. */
  label: string;
}

/**
 * The viewer's own sign-ins a turn engine runs turns on
 * (docs/Local-Engine-Turns.md 11.20). The controller names one, in an agent's
 * `backupAis` and in the `aiSignIn` and `aiSignInNext` stamps of a turn's
 * messages, as `{[refKey]: id}`. The agent editor's Backups list offers them
 * beside the person's connections, and the chat names them, for their owner
 * alone, under a reply and in a failure.
 */
export interface FrontendTurnEngineSignIns {
  /** The key that names one of them beside its id; never `credentialId`, which names a connection. */
  refKey: string;
  /** The viewer's sign-ins as last listed, the engine's first one first; null while none has loaded. */
  snapshot(): readonly TurnEngineSignIn[] | null;
  /**
   * Calls `onChange` whenever they may have changed, and lists them when no
   * list is recent: what names one subscribes while it shows. Returns the
   * call that stops it.
   */
  subscribe(onChange: () => void): () => void;
  /** Lists them when no list is younger than `maxAgeMs`; 0 always asks again, as the agent editor does when it opens. */
  load(maxAgeMs?: number): void;
  /**
   * The id of the sign-in an agent whose AI is this engine runs on first, by
   * what the engine's own fields set in the editor (`fields`, null for
   * nothing yet) or else what the agent saved; null when it has none. A
   * backup is never that one.
   */
  firstForAgent?(input: {
    agent: ControllerAgentProfile | null;
    fields: TurnEngineAgentAiRequestFields | null;
  }): string | null;
}

/** What Your AI gives a turn engine's row (docs/Local-Engine-Turns.md 5.3). */
export interface FrontendTurnEngineYourAiRowProps {
  /** A space's runtime status, including whether the engine's lane covers the viewer. */
  fetchRuntimeStatus: (params: FetchRuntimeStatusParams) => Promise<FetchRuntimeStatusResult | null>;
  /** The controller this Studio talks to now, or null. */
  resolveControllerUrl: () => Promise<string | null>;
}

/**
 * An engine that an agent's turns run on instead of the runtime's own
 * (docs/Local-Engine-Turns.md 11.3): the AI an agent uses names it as its
 * `provider`, and the controller stamps its id as the `aiAccessMode` of the
 * turns it runs. Core code keys everything on that id; everything specific to
 * the engine (where and to whom it is offered, and its words) stays in its
 * feature module.
 */
export interface FrontendTurnEngineContribution {
  /** An agent's `provider` when it is that agent's AI, and the `aiAccessMode` of its turns. */
  id: string;
  /** How the engine's turns read in the chat; without it the chat words them as any other turn. */
  presentation?: FrontendTurnEnginePresentation;
  /** The engine as an agent's AI; without it no agent editor offers it. */
  agentAi?: FrontendTurnEngineAgentAi;
  /**
   * The viewer's own sign-ins the engine runs turns on, as backups and in the
   * lines that name a turn's sign-in (11.20); without it the engine has none
   * to offer or name.
   */
  signIns?: FrontendTurnEngineSignIns;
  /**
   * Under a waiting turn's line, for the person whose turn it is: what makes
   * it run, such as starting the space on this computer. Renders nothing
   * where there is nothing to say.
   */
  WaitingNote?: ComponentType<FrontendTurnEngineWaitingNoteProps>;
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

/**
 * Each engine with sign-ins names them by a key of its own that the
 * controller uses for a sign-in (`AGENT_SIGN_IN_KEYS`), never a connection's.
 */
function assertTurnEngineSignInKeys(engines: readonly FrontendTurnEngineContribution[]): void {
  const seenKeys = new Set<string>();
  for (const engine of engines) {
    const refKey = engine.signIns?.refKey;
    if (refKey === undefined) {
      continue;
    }
    if (refKey === "credentialId" || !(AGENT_SIGN_IN_KEYS as readonly string[]).includes(refKey)) {
      throw new Error(
        `Turn engine "${engine.id}" names its sign-ins by ${JSON.stringify(refKey)}, which names no sign-in of an engine's.`,
      );
    }
    if (seenKeys.has(refKey)) {
      throw new Error(`Two turn engines name their sign-ins by "${refKey}".`);
    }
    seenKeys.add(refKey);
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
  assertTurnEngineSignInKeys(turnEngines);

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
