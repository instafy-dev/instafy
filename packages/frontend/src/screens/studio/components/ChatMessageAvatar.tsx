import { useContext } from "react";
import { getDefaultAssistantHandle } from "../../../assistants/localBuiltInAssistantCatalog";
import { AiFace } from "../../../components/AiFace";
import { HumanAvatar } from "../../../components/HumanAvatar";
import { normalizeAgentAvatarHandle } from "../../../utils/agentAvatar";
import { aiFaceIdentityFromMetadata, withSavedAgentFace, type AiFaceIdentity } from "../../../utils/aiFace";
import type { AssistantAvatarMotion } from "./chatAssistantIdentity";
import { ViewerAgentsContext } from "./viewerAgents";

export type ChatMessageAvatarKind = "assistant" | "human";

type ChatMessageAgentAvatarOverride = {
  handle?: string | null;
  avatarSeed?: string | null;
  /**
   * The saved agent's id: the viewer's own agent is drawn from its current
   * profile by it, and any agent's face falls back to it behind a picture
   * that fails to load.
   */
  id?: string | null;
  /** Known only by its handle (a mention chip's card, a roster entry): the hollow face, unless it is Octo. */
  textOnly?: boolean;
};

/**
 * Who an assistant face belongs to: the caller's identity when it names an
 * agent (a profile card's, the viewer's own saved agent), else the agent the
 * row's metadata stamps, its id included, else Octo, who speaks every
 * unattributed row. Values pass through raw: resolveAiFace normalizes them
 * and reads a stamp exactly as stamped.
 */
function resolveAssistantFaceIdentity(
  agent: ChatMessageAgentAvatarOverride | null | undefined,
  metadata: unknown,
): AiFaceIdentity {
  if (agent && normalizeAgentAvatarHandle(agent.handle)) {
    return { handle: agent.handle, avatarSeed: agent.avatarSeed, agentId: agent.id, textOnly: agent.textOnly };
  }
  return aiFaceIdentityFromMetadata(metadata) ?? { handle: getDefaultAssistantHandle() };
}

export function ChatMessageAvatar({
  kind,
  metadata,
  agent,
  label,
  avatarUrl,
  motion = "idle",
  scrollReactive = false,
  seed,
  size = "sm",
  testId: testIdOverride,
}: {
  kind: ChatMessageAvatarKind;
  metadata?: unknown;
  agent?: ChatMessageAgentAvatarOverride | null;
  label?: string | null;
  avatarUrl?: string | null;
  motion?: AssistantAvatarMotion;
  scrollReactive?: boolean;
  seed?: string | null;
  size?: "2xs" | "xs" | "sm" | "lg";
  /**
   * A second face of the same speaker on one row (the phone-only thinking
   * indicator beside the gutter avatar) needs its own selector, or the
   * gutter's chat-avatar-* selector would match both.
   */
  testId?: string;
}) {
  const testId =
    testIdOverride ?? (kind === "assistant" ? "chat-avatar-assistant" : "chat-avatar-human");
  const viewerAgents = useContext(ViewerAgentsContext);

  // "2xs" exists for ambient presence surfaces (the top-bar conversation
  // roster), where a transcript-sized face reads far too loud.
  const sizeClassName =
    size === "lg"
      ? "h-12 w-12"
      : size === "2xs"
        ? "h-6 w-6"
        : size === "xs"
          ? "h-7 w-7"
          : "h-8 w-8";

  if (kind === "human") {
    const textClassName = size === "lg" ? "text-sm" : size === "2xs" ? "text-xxs" : "text-xs";
    // HumanAvatar draws the shared avatar coin shadow in light; dark keeps
    // the small shadow these faces always had.
    return <HumanAvatar userId={seed} displayName={label} avatarUrl={avatarUrl}
      data-testid={testId} className={`${sizeClassName} ${textClassName} dark:shadow-sm`} />;
  }

  // Every AI is AiFace (docs/Brand.md, "Octo's hatchlings"): Octo is its
  // tile, the only face that takes the motion; any other AI wears its own
  // picture or one of Octo's hatchlings on the same tile. The viewer's own
  // saved agents wear their current profile's face.
  return (
    <AiFace
      identity={withSavedAgentFace(resolveAssistantFaceIdentity(agent, metadata), viewerAgents)}
      className={sizeClassName}
      motion={motion}
      scrollReactive={scrollReactive}
      testId={testId}
    />
  );
}
