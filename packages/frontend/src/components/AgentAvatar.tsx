import { AiFace } from "./AiFace";
import { resolveAiFace, type AiFaceIdentity } from "../utils/aiFace";

/** The same saved or draft identity in bot settings and the agent list. */
export function AgentAvatar({ agent, size = "md", imageSrc }: {
  /** `textOnly`: an AI the viewer knows only by its handle wears the hollow face (aiFace.ts). */
  agent: { id?: string; handle: string; displayName?: string | null; avatarSeed?: string | null; textOnly?: boolean };
  size?: "sm" | "md" | "lg";
  /**
   * Shown instead of the agent's own picture (an upload preview, a draft
   * URL); null shows the agent without one. A picture that fails to load
   * shows the face behind it.
   */
  imageSrc?: string | null;
}) {
  const identity: AiFaceIdentity = {
    handle: agent.handle,
    agentId: agent.id,
    avatarSeed: agent.avatarSeed,
    displayName: agent.displayName,
    textOnly: agent.textOnly,
  };
  const dimensions = size === "lg" ? "h-16 w-16" : size === "sm" ? "h-7 w-7" : "h-9 w-9";
  // One face for every AI (AiFace, docs/Brand.md "Octo's hatchlings"): Octo
  // is its tile, any other agent its own picture or one of Octo's hatchlings
  // on the same tile.
  if (imageSrc === undefined) {
    return <AiFace identity={identity} inline className={dimensions} />;
  }
  const resolved = resolveAiFace(identity);
  const drawn = resolved.kind === "picture" ? resolved.fallback : resolved;
  return (
    <AiFace face={imageSrc ? { kind: "picture", src: imageSrc, fallback: drawn } : drawn} inline className={dimensions} />
  );
}
