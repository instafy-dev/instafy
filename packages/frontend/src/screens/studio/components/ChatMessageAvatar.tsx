import { useMemo } from "react";
import { OctoMark } from "../../../components/OctoMark";
import { HumanAvatar } from "../../../components/HumanAvatar";
import {
  OCTO_AVATAR_SRC,
  resolveAgentAvatarGradient,
  resolveAgentAvatarImageSrc,
  resolveAgentAvatarText,
} from "../../../utils/agentAvatar";
import type { AssistantAvatarMotion } from "./chatAssistantIdentity";

export type ChatMessageAvatarKind = "assistant" | "human";

type AgentAvatarIdentity = { handle: string; avatarSeed: string };

type ChatMessageAgentAvatarOverride = {
  handle?: string | null;
  avatarSeed?: string | null;
};

function extractAgentAvatarIdentity(metadata: unknown): AgentAvatarIdentity | null {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  const agent = (metadata as Record<string, unknown>).agent;
  if (!agent || typeof agent !== "object") {
    return null;
  }
  const handleRaw = (agent as Record<string, unknown>).handle;
  const handleValue = typeof handleRaw === "string" ? handleRaw.trim() : "";
  const normalizedHandle = handleValue.startsWith("@") ? handleValue.slice(1).trim().toLowerCase() : handleValue.toLowerCase();
  if (!normalizedHandle) {
    return null;
  }
  const avatarSeedRaw = (agent as Record<string, unknown>).avatarSeed;
  const avatarSeed =
    typeof avatarSeedRaw === "string" && avatarSeedRaw.trim().length > 0 ? avatarSeedRaw.trim() : normalizedHandle;
  return { handle: normalizedHandle, avatarSeed };
}

function extractAgentAvatarIdentityFromOverride(
  override: ChatMessageAgentAvatarOverride | null | undefined,
): AgentAvatarIdentity | null {
  if (!override || typeof override !== "object") {
    return null;
  }
  const handleRaw = typeof override.handle === "string" ? override.handle.trim() : "";
  const handleValue = handleRaw.startsWith("@") ? handleRaw.slice(1).trim() : handleRaw;
  const normalizedHandle = handleValue.toLowerCase();
  if (!normalizedHandle) {
    return null;
  }
  const avatarSeedRaw = typeof override.avatarSeed === "string" ? override.avatarSeed.trim() : "";
  const avatarSeed = avatarSeedRaw || normalizedHandle;
  return { handle: normalizedHandle, avatarSeed };
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
}) {
  const agentIdentity =
    kind === "assistant"
      ? extractAgentAvatarIdentityFromOverride(agent) ?? extractAgentAvatarIdentity(metadata)
      : null;
  const assistantAvatarImageSrc =
    kind === "assistant"
      ? resolveAgentAvatarImageSrc({
          handle: agentIdentity?.handle ?? "octo",
          avatarSeed: agentIdentity?.avatarSeed ?? null,
        })
      : null;
  const usesAssistantImageAvatar = kind === "assistant" && Boolean(assistantAvatarImageSrc);
  const usesCanonicalOctoAvatar =
    kind === "assistant" && assistantAvatarImageSrc === OCTO_AVATAR_SRC;
  const testId = kind === "assistant" ? "chat-avatar-assistant" : "chat-avatar-human";
  const wrapperClass =
    kind === "assistant"
      ? usesAssistantImageAvatar
        ? "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"
        : "border-slate-200 text-white dark:border-slate-800"
      : "border-slate-200 text-white dark:border-slate-800";

  const gradientStyle = useMemo(() => {
    if (kind !== "assistant" || usesAssistantImageAvatar || !agentIdentity) {
      return undefined;
    }
    return { backgroundImage: resolveAgentAvatarGradient(agentIdentity.avatarSeed) };
  }, [agentIdentity, kind, usesAssistantImageAvatar]);

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
  const textClassName = size === "lg" ? "text-sm" : size === "2xs" ? "text-xxs" : "text-xs";

  if (kind === "human") {
    return <HumanAvatar userId={seed} displayName={label} avatarUrl={avatarUrl}
      data-testid={testId} className={`${sizeClassName} ${textClassName} shadow-sm`} />;
  }

  return (
    <div
      data-testid={testId}
      aria-hidden="true"
      className={`flex ${sizeClassName} shrink-0 items-center justify-center overflow-hidden rounded-full border shadow-sm ${wrapperClass}`}
      style={gradientStyle}
    >
      {usesCanonicalOctoAvatar ? (
          <span className="flex h-full w-full items-center justify-center bg-white">
            <OctoMark
              className="h-[85%] w-[85%] text-brand-ink"
              motion={motion}
              scrollReactive={scrollReactive}
              title="Octo"
            />
          </span>
        ) : usesAssistantImageAvatar && assistantAvatarImageSrc ? (
          <img
            src={assistantAvatarImageSrc}
            alt=""
            className="h-full w-full object-cover"
            decoding="async"
            draggable={false}
          />
        ) : (
          <span className={`${textClassName} font-semibold`}>
            {resolveAgentAvatarText({ handle: agentIdentity?.handle ?? "agent" })}
          </span>
      )}
    </div>
  );
}
