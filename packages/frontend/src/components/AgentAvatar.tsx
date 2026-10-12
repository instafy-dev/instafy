import { useState } from "react";
import { OctoCoin } from "./OctoCoin";
import { OCTO_AVATAR_SRC, normalizeCustomAgentAvatarSrc, resolveAgentAvatarGradient, resolveAgentAvatarImageSrc, resolveAgentAvatarText } from "../utils/agentAvatar";
import { normalizeIdentityImageSrc } from "../utils/identityImageSrc";

/** The same saved or draft identity in bot settings and the agent list. */
export function AgentAvatar({ agent, size = "md", imageSrc }: {
  agent: { id?: string; handle: string; displayName?: string | null; avatarSeed?: string | null };
  size?: "sm" | "md" | "lg";
  imageSrc?: string | null;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = normalizeIdentityImageSrc(imageSrc === undefined ? resolveAgentAvatarImageSrc(agent) : imageSrc);
  const customImage = src && src !== OCTO_AVATAR_SRC && src !== failedSrc;
  const builtIn = src === OCTO_AVATAR_SRC;
  const dimensions = size === "lg" ? "h-16 w-16 text-lg" : size === "sm" ? "h-7 w-7 text-xs" : "h-9 w-9 text-sm";
  // Octo is its coin, the same face as in chat (OctoCoin, docs/Brand.md).
  if (builtIn) {
    return <OctoCoin inline className={dimensions} />;
  }
  // Every other agent's coin shares Octo's light-mode edge: the avatar coin
  // shadow (empty in dark, where this coin has no edge).
  return (
    <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full text-white shadow-avatar-coin ${dimensions}`}
      style={customImage ? undefined : { backgroundImage: resolveAgentAvatarGradient(normalizeCustomAgentAvatarSrc(agent.avatarSeed) ? agent.id || agent.handle : agent.avatarSeed || agent.handle) }}>
      {customImage ? (
        <img src={src} alt="" className="h-full w-full object-cover" decoding="async" draggable={false} onError={() => setFailedSrc(src)} />
      ) : resolveAgentAvatarText(agent)}
    </span>
  );
}
