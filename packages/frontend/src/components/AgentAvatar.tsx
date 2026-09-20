import { useState } from "react";
import { OctoMark } from "./OctoMark";
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
  return (
    <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full ${dimensions} ${builtIn ? "bg-slate-100 text-slate-900 dark:bg-[var(--color-studio-dark-active)] dark:text-slate-100" : "text-white"}`}
      style={customImage || builtIn ? undefined : { backgroundImage: resolveAgentAvatarGradient(normalizeCustomAgentAvatarSrc(agent.avatarSeed) ? agent.id || agent.handle : agent.avatarSeed || agent.handle) }}>
      {builtIn ? <OctoMark className="h-3/4 w-3/4" /> : customImage ? (
        <img src={src} alt="" className="h-full w-full object-cover" decoding="async" draggable={false} onError={() => setFailedSrc(src)} />
      ) : resolveAgentAvatarText(agent)}
    </span>
  );
}
